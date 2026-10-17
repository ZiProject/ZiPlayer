// Regression tests cho AudioProcessingEngine: đúng dạng sóng/biên độ/sample rate và vòng đời huỷ/lỗi.
// Chạy: npm test (build core trước). Engine: FFmpeg tiến trình con.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { createAudioProcessingEngine } = require("../core/dist");
const ffmpegPath = require("ffmpeg-static");
const helpers = require("./helpers/wav");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) =>
	Promise.race([
		p.then(
			(v) => ({ ok: true, v }),
			(e) => ({ ok: false, e }),
		),
		sleep(ms).then(() => ({ hung: true })),
	]);

function wavSource(options) {
	return helpers.wavSource({
		...options,
		sampleRate: options.sr,
		channels: options.ch,
		amplitude: options.amp,
		frequency: options.freq,
	});
}

async function render(opts, source) {
	const eng = createAudioProcessingEngine(opts);
	const p = await eng.createPipeline(opts);
	const bufs = [];
	for await (const c of p.process(source, AbortSignal.timeout(10_000))) bufs.push(Buffer.from(c));
	await p.dispose();
	const encoded = Buffer.concat(bufs);
	const sampleRateHz = opts.resampleRate ?? opts.sampleRate ?? 48_000;
	const channels = opts.channels ?? 2;
	const all = execFileSync(
		ffmpegPath,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"ogg",
			"-i",
			"pipe:0",
			"-f",
			"s16le",
			"-ar",
			String(sampleRateHz),
			"-ac",
			String(channels),
			"pipe:1",
		],
		{ input: encoded, maxBuffer: 4 * 1024 * 1024 },
	);
	const frames = all.length / (channels * 2);
	const left = new Float32Array(frames),
		right = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		left[i] = all.readInt16LE(i * channels * 2) / 32768;
		right[i] = all.readInt16LE((i * channels + (channels - 1)) * 2) / 32768;
	}
	let peak = 0,
		zc = 0;
	for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]));
	for (let i = 1; i < frames; i++) if (left[i - 1] < 0 && left[i] >= 0) zc++;
	return { frames, sampleRateHz, channels, peak, freq: zc / (frames / sampleRateHz), left, right, bytes: all.length };
}

test("encoded output preserves amplitude, frequency, duration and configured sample rate", async () => {
	const r = await render({ normalize: false }, wavSource({ seconds: 1, sr: 44100, ch: 2, amp: 0.5 }));
	assert.equal(r.sampleRateHz, 48000);
	assert.equal(r.channels, 2);
	assert.ok(Math.abs(r.frames - 48000) <= 2, `frames=${r.frames}`);
	assert.ok(Math.abs(r.peak - 0.5) < 0.01, `peak=${r.peak}`);
	assert.ok(Math.abs(r.freq - 440) < 3, `freq=${r.freq}`);
	let maxDiff = 0;
	for (let i = 0; i < r.frames; i++) maxDiff = Math.max(maxDiff, Math.abs(r.left[i] - r.right[i]));
	assert.ok(maxDiff < 1e-3, "identical L/R source must stay identical");
});

test("mono source is upmixed to both channels (unity or equal-power, never lower)", async () => {
	const r = await render({ normalize: false }, wavSource({ seconds: 0.5, sr: 44100, ch: 1, amp: 0.5 }));
	assert.ok(r.peak >= 0.5 * Math.SQRT1_2 - 0.01 && r.peak <= 0.51, `peak=${r.peak}`);
	let maxDiff = 0;
	for (let i = 0; i < r.frames; i++) maxDiff = Math.max(maxDiff, Math.abs(r.left[i] - r.right[i]));
	assert.ok(maxDiff < 1e-3, "mono must be duplicated to both channels");
});

test("gain is applied linearly (+6 dB) and hard gain clamps instead of wrapping", async () => {
	const g6 = await render({ normalize: false, gainDb: 6 }, wavSource({ seconds: 0.5, ch: 2, amp: 0.5 }));
	assert.ok(Math.abs(g6.peak - 0.5 * 10 ** (6 / 20)) < 0.02, `peak=${g6.peak}`);
	const g12 = await render(
		{ normalize: false, gainDb: 12 },
		wavSource({ seconds: 0.5, ch: 2, amp: 0.5 }),
	);
	assert.ok(g12.peak <= 1 && g12.peak > 0.99);
	assert.ok(Math.abs(g12.freq - 440) < 3, "clipping must not wrap around / change the waveform period");
});

test("highpass attenuates content below the cutoff", async () => {
	const r = await render({ normalize: false, highpassHz: 2000 }, wavSource({ seconds: 0.5, amp: 0.5 }));
	assert.ok(r.peak < 0.15, `peak=${r.peak}`);
});

test("abort mid-stream ends the pipeline promptly and releases upstream", async () => {
	const stats = {};
	const p = await createAudioProcessingEngine({ normalize: false }).createPipeline({ normalize: false });
	const ac = new AbortController();
	let n = 0;
	const r = await settle(
		(async () => {
			for await (const _ of p.process(wavSource({ seconds: 60, stats }), ac.signal)) if (++n === 3) ac.abort();
		})(),
		2000,
	);
	await sleep(200);
	assert.ok(r.ok, "process() must settle after abort");
	assert.equal(stats.returned, true, "upstream generator must be finalized");
	assert.ok(stats.pulled < 200, "must not consume the whole source after abort");
	await p.dispose();
});

test("abort while upstream is stalled still terminates process()", async () => {
	const p = await createAudioProcessingEngine({ normalize: false }).createPipeline({ normalize: false });
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 200);
	const r = await settle(
		(async () => {
			for await (const _ of p.process(wavSource({ seconds: 60, hangAfter: 3 }), ac.signal)) {
			}
		})(),
		2000,
	);
	assert.ok(!r.hung, "process() hung although the AbortSignal fired");
	await Promise.race([p.dispose(), sleep(1000)]);
});

test("upstream failure propagates as an error instead of hanging forever", async () => {
	const p = await createAudioProcessingEngine({ normalize: false }).createPipeline({ normalize: false });
	const r = await settle(
		(async () => {
			for await (const _ of p.process(wavSource({ seconds: 60, errorAfter: 5 }))) {
			}
		})(),
		3000,
	);
	assert.ok(!r.hung, "pipeline hung on upstream error (track would stay silent)");
	assert.equal(r.ok, false);
	assert.match(String(r.e?.message), /ECONNRESET/);
	await p.dispose();
});

test("repeated cancel of a Node Readable source raises no uncaught exceptions", async () => {
	const uncaught = [];
	const onUncaught = (e) => uncaught.push(e?.code || e?.message);
	process.on("uncaughtException", onUncaught);
	try {
		let closed = 0;
		for (let i = 0; i < 30; i++) {
			const rd = Readable.from(wavSource({ seconds: 60 }));
			rd.on("close", () => closed++);
			const p = await createAudioProcessingEngine({ normalize: false }).createPipeline({ normalize: false });
			const ac = new AbortController();
			let n = 0;
			try {
				for await (const _ of p.process(rd, ac.signal))
					if (++n === 3) {
						ac.abort();
						rd.destroy();
					}
			} catch {}
			await p.dispose();
		}
		await sleep(300);
		assert.deepEqual(uncaught, []);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
});

test("undecodable input is reported as an error, never as a silent empty success", async () => {
	const p = await createAudioProcessingEngine({ normalize: false }).createPipeline({ normalize: false });
	const r = await settle(
		(async () => {
			let bytes = 0;
			for await (const c of p.process(
				[Buffer.from("this is definitely not an audio container ".repeat(200))],
				AbortSignal.timeout(5000),
			))
				bytes += c.length;
			return bytes;
		})(),
		6000,
	);
	assert.ok(!r.hung, "pipeline hung on undecodable input");
	assert.equal(r.ok, false, `completed with ${r.v} bytes instead of failing`);
	await p.dispose();
});
