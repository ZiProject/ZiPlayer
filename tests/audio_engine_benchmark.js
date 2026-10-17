"use strict";
// Benchmark of the FFmpeg audio processing engine against running the same FFmpeg filter chain directly.
// Both sides decode the same fixture, apply the same filters and produce the same PCM format, so the numbers
// isolate the engine's overhead (stdin/stdout piping, chunking, abort handling). Usage:
//   npm run bench:audio                 # 60 s fixtures
//   BENCH_SECONDS=300 npm run bench:audio
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { createAudioProcessingEngine } = require("../core/dist");
const { wavHeader } = require("./helpers/wav");

const SECONDS = Number(process.env.BENCH_SECONDS ?? 60);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const FILTERS = { gainDb: 3, highpassHz: 80 };
const FFMPEG_FILTER = "volume=3dB,highpass=f=80";

function ffmpegExecutable() {
	for (const candidate of [process.env.FFMPEG_PATH, require("ffmpeg-static"), "ffmpeg"]) {
		if (candidate && (candidate === "ffmpeg" || fs.existsSync(candidate))) return candidate;
	}
	return "ffmpeg";
}

function childrenRssBytes() {
	if (process.platform !== "linux") return 0;
	let total = 0;
	try {
		for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
			try {
				const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
				if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== process.pid) continue;
				const match = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
				if (match) total += Number(match[1]) * 1024;
			} catch {}
		}
	} catch {}
	return total;
}

function buildFixtures(dir) {
	const wavPath = path.join(dir, "fixture.wav");
	const sampleRate = 44100;
	const frames = SECONDS * sampleRate;
	const fd = fs.openSync(wavPath, "w");
	fs.writeSync(fd, wavHeader({ dataBytes: frames * 4, sampleRate, channels: 2 }));
	const block = Buffer.alloc(sampleRate * 4);
	for (let second = 0; second < SECONDS; second++) {
		for (let i = 0; i < sampleRate; i++) {
			const value = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * (second * sampleRate + i)) / sampleRate));
			block.writeInt16LE(value, i * 4);
			block.writeInt16LE(value, i * 4 + 2);
		}
		fs.writeSync(fd, block);
	}
	fs.closeSync(fd);
	const fixtures = [{ name: "wav/pcm16", file: wavPath }];
	for (const [name, args, ext] of [
		["webm/opus", ["-c:a", "libopus", "-b:a", "128k"], "webm"],
		["mp3", ["-c:a", "libmp3lame", "-b:a", "192k"], "mp3"],
		["m4a/aac (faststart)", ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"], "m4a"],
	]) {
		const out = path.join(dir, `fixture.${ext}`);
		const result = spawnSync(ffmpegExecutable(), ["-v", "error", "-y", "-i", wavPath, ...args, out]);
		if (result.status === 0) fixtures.push({ name, file: out });
	}
	return fixtures;
}

async function measure(label, run) {
	const lag = monitorEventLoopDelay({ resolution: 5 });
	lag.enable();
	let peakSelf = 0;
	let peakChildren = 0;
	const sampler = setInterval(() => {
		peakSelf = Math.max(peakSelf, process.memoryUsage().rss);
		peakChildren = Math.max(peakChildren, childrenRssBytes());
	}, 25);
	const cpuStart = process.cpuUsage();
	const start = process.hrtime.bigint();
	let firstMs = null;
	let bytes = 0;
	await run((chunkBytes) => {
		if (firstMs === null) firstMs = Number(process.hrtime.bigint() - start) / 1e6;
		bytes += chunkBytes;
	});
	const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
	const cpu = process.cpuUsage(cpuStart);
	clearInterval(sampler);
	lag.disable();
	return {
		label,
		wallMs,
		firstMs: firstMs ?? NaN,
		xRealtime: SECONDS / (wallMs / 1000),
		nodeCpuMs: (cpu.user + cpu.system) / 1000,
		rssMb: (Math.max(peakSelf, process.memoryUsage().rss) + peakChildren) / 1e6,
		lagMaxMs: lag.max / 1e6,
		pcmSeconds: bytes / 4 / 48000,
	};
}

async function runEngine(file, onChunk) {
	const options = { enabled: true, outputFormat: "pcm16le", ...FILTERS };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
	for await (const chunk of pipeline.process(fs.createReadStream(file))) onChunk(chunk.byteLength);
	await pipeline.dispose();
}

function runFfmpeg(file, onChunk) {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			ffmpegExecutable(),
			["-v", "error", "-i", "pipe:0", "-vn", "-af", FFMPEG_FILTER, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
			{
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		proc.stdin.on("error", () => {});
		fs.createReadStream(file).pipe(proc.stdin);
		proc.stdout.on("data", (chunk) => onChunk(chunk.length));
		proc.once("error", reject);
		proc.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
	});
}

function median(values) {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ziplayer-bench-"));
	try {
		const fixtures = buildFixtures(dir);
		console.log(
			`FFmpeg DSP engine vs direct FFmpeg: ${SECONDS}s stereo fixtures, filters ${FFMPEG_FILTER}, ${RUNS} runs (median)`,
		);
		console.log(
			`${"fixture".padEnd(22)} ${"runner".padEnd(8)} ${"wall ms".padStart(8)} ${"x real".padStart(7)} ${"1st ms".padStart(7)} ${"node cpu".padStart(9)} ${"peak MB".padStart(8)} ${"lag ms".padStart(7)}  pcm s`,
		);
		for (const fixture of fixtures) {
			for (const [runner, run] of [
				["engine", runEngine],
				["ffmpeg", runFfmpeg],
			]) {
				const runs = [];
				for (let i = 0; i < RUNS; i++) runs.push(await measure(runner, (onChunk) => run(fixture.file, onChunk)));
				const m = (key) => median(runs.map((entry) => entry[key]));
				console.log(
					`${fixture.name.padEnd(22)} ${runner.padEnd(8)} ${m("wallMs").toFixed(0).padStart(8)} ${m("xRealtime").toFixed(0).padStart(7)} ${m("firstMs").toFixed(0).padStart(7)} ${m("nodeCpuMs").toFixed(0).padStart(9)} ${m("rssMb").toFixed(0).padStart(8)} ${m("lagMaxMs").toFixed(0).padStart(7)}  ${m("pcmSeconds").toFixed(1)}`,
				);
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
