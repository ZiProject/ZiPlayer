const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const { createAudioProcessingEngine, FFmpegAudioProcessingEngine, Bus, PlaybackController } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");
const ffmpegPath = require("ffmpeg-static");
const { makeWav, analyzePcm16 } = require("./helpers/wav");

async function collect(pipeline, input, signal = AbortSignal.timeout(10_000)) {
	const chunks = [];
	for await (const chunk of pipeline.process(input, signal)) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function decodeOpus(audio, { sampleRate = 48_000, channels = 2 } = {}) {
	return execFileSync(
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
			String(sampleRate),
			"-ac",
			String(channels),
			"pipe:1",
		],
		{ input: audio, maxBuffer: 4 * 1024 * 1024 },
	);
}

test("audio processing applies filters and emits encoded Opus", async () => {
	const options = { enabled: true, gainDb: 6, highpassHz: 80, sampleRate: 8000, resampleRate: 8000 };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options, { playerId: "p1" });
	assert.deepEqual(pipeline.outputFormat, { kind: "encoded", codec: "opus", container: "ogg" });
	const audio = await collect(pipeline, [makeWav({ seconds: 0.5, sampleRate: 8000, channels: 2, amplitude: 0.25 })]);
	assert.equal(audio.subarray(0, 4).toString(), "OggS");
	const decoded = analyzePcm16(decodeOpus(audio, { sampleRate: 8000 }), { sampleRate: 8000, channels: 2 });
	assert.ok(Math.abs(decoded.frames - 4000) <= 2, `frames=${decoded.frames}`);
	assert.ok(Math.abs(decoded.peak - 0.499) < 0.06, `peak=${decoded.peak}`);
	assert.ok(Math.abs(decoded.frequency - 440) < 10, `frequency=${decoded.frequency}`);
	await pipeline.dispose();
});

test("audio processing rejects invalid DSP configuration and non-encoded formats", async () => {
	const engine = createAudioProcessingEngine();
	await assert.rejects(() => engine.createPipeline({ enabled: true, gainDb: Number.NaN }), /gainDb|invalid|valid/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, gainDb: 3, gainLinear: 2 }), /cannot both/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, channels: 1.5 }), /channels/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, normalize: "loud" }), /preset/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, normalize: -14 }), /numeric/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, outputFormat: "raw" }), /outputFormat.*encoded/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, inputFormat: "raw" }), /inputFormat.*encoded/i);
	assert.throws(() => createAudioProcessingEngine({ maxBufferBytes: 0 }), /maxBufferBytes/);
});

test("audio processing ignores undefined overrides and accepts Node readable streams", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, sampleRate: 44_100, channels: 1 });
	const pipeline = await engine.createPipeline({ sampleRate: undefined, channels: undefined });
	const audio = await collect(pipeline, Readable.from([makeWav({ seconds: 0.1, sampleRate: 44100, channels: 1 })]));
	assert.equal(audio.subarray(0, 4).toString(), "OggS");
	assert.deepEqual(pipeline.outputFormat, { kind: "encoded", codec: "opus", container: "ogg" });
	await pipeline.dispose();
});

test("audio processing bounds emitted chunks without splitting the encoded stream contract", async () => {
	const options = { enabled: true, maxBufferBytes: 66 };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options, { playerId: "p7" });
	const chunks = [];
	for await (const chunk of pipeline.process([makeWav({ seconds: 0.1 })], AbortSignal.timeout(10_000))) {
		chunks.push(Buffer.from(chunk));
		assert.ok(chunk.byteLength <= 66, `chunk=${chunk.byteLength}`);
	}
	assert.ok(chunks.length > 10);
	assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), "OggS");
	await pipeline.dispose();
});

test("unrecognized raw input is rejected instead of being guessed by FFmpeg", async () => {
	const pipeline = await createAudioProcessingEngine({ enabled: true }).createPipeline({ enabled: true });
	await assert.rejects(
		() => collect(pipeline, Readable.from([Buffer.alloc(48_000)])),
		/whitelist|Invalid data|produced no audio|Error opening input/i,
	);
	await pipeline.dispose();
});

test("loudness presets produce valid encoded output", async () => {
	for (const normalize of [true, "streaming", "podcast", "broadcast"]) {
		const options = { enabled: true, normalize };
		const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
		const audio = await collect(pipeline, [makeWav({ seconds: 0.3, sampleRate: 48000, channels: 2, amplitude: 0.5 })]);
		assert.equal(audio.subarray(0, 4).toString(), "OggS");
		assert.ok(decodeOpus(audio).length > 0);
		await pipeline.dispose();
	}
});

test(
	"a failing FFmpeg executable is reported with its exit code instead of an empty success",
	{ skip: process.platform === "win32" },
	async () => {
		const options = { enabled: true, ffmpegPath: "/bin/false" };
		const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
		await assert.rejects(() => collect(pipeline, [makeWav({ seconds: 0.1 })]), /FFmpeg (exited with code 1|produced no audio)/);
		await pipeline.dispose();
	},
);

test("process() refuses new work after dispose()", async () => {
	const pipeline = await new FFmpegAudioProcessingEngine().createPipeline({ enabled: true });
	await pipeline.dispose();
	assert.throws(() => pipeline.process([makeWav()]), /disposed/);
});

test("PlaybackController rejects raw audio inputs before resource creation", () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		pause() {},
		resume() {},
		stop() {},
	});
	controller.attach("raw-input", { audioPlayer, stuckTimeoutMs: 1000 });
	const stream = Readable.from([Buffer.alloc(32)]);
	assert.throws(
		() => controller.createResource("raw-input", stream, { id: "track", title: "Track", duration: 1000 }, StreamType.Raw),
		/raw audio input is unsupported/i,
	);
	assert.equal(stream.destroyed, true);
	controller.detach("raw-input");
});

test("PlaybackController reports FFmpeg failure instead of falling back to input bytes", async () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		pause() {
			return true;
		},
		unpause() {
			return true;
		},
		stop() {
			return true;
		},
	});
	controller.attach("invalid-audio", { audioPlayer, audioProcessing: { enabled: true } });
	const source = Readable.from([Buffer.from("not-a-valid-audio-container")]);
	const resource = controller.createResource(
		"invalid-audio",
		source,
		{ id: "broken-track", title: "Broken source", duration: 1000 },
		StreamType.Opus,
	);
	await assert.rejects(async () => {
		for await (const _chunk of resource.playStream) assert.fail("Invalid encoded source must not be emitted");
	}, /Audio processing failed for Broken source/);
	assert.equal(source.destroyed, true);
	controller.detach("invalid-audio");
});
