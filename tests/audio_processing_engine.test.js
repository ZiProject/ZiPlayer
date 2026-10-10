const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const { createAudioProcessingEngine, resolveOutputStreamType } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");

test("audio processing engine can apply gain and emit valid PCM output", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, gainDb: 6, highpassHz: 80, resampleRate: 8000 });
	const audioMod = await import("../core/node_modules/audio/audio.js");
	const source = audioMod.default.from((t) => Math.sin(2 * Math.PI * 440 * t), {
		duration: 0.05,
		sampleRate: 8000,
		channels: 1,
	});
	const wav = await source.encode("wav");
	const pipeline = await engine.createPipeline(
		{ enabled: true, gainDb: 6, highpassHz: 80, resampleRate: 8000 },
		{ playerId: "p1" },
	);

	const chunks = [];
	for await (const chunk of pipeline.process(
		(async function* () {
			yield wav;
		})(),
		AbortSignal.timeout(3000),
	)) {
		assert.ok(chunk instanceof Uint8Array);
		assert.ok(chunk.length > 0);
		chunks.push(chunk.length);
	}

	assert.ok(chunks.length > 0);
	assert.ok(chunks.some((length) => length > 0));
	await pipeline.dispose();
});

test("audio processing engine rejects invalid DSP configuration", async () => {
	const engine = createAudioProcessingEngine();
	await assert.rejects(async () => {
		await engine.createPipeline({ enabled: true, gainDb: Number.NaN }, { playerId: "p2" });
	}, /gainDb|invalid|valid/i);
});

test("audio processing engine rejects raw PCM input because the runtime only supports encoded input", async () => {
	const engine = createAudioProcessingEngine();
	await assert.rejects(async () => {
		await engine.createPipeline({ enabled: true, inputFormat: "pcm16le", outputFormat: "pcm16le" }, { playerId: "p3" });
	}, /inputFormat.*encoded|not supported/i);
});

test("audio processing engine emits valid PCM16 bytes for processed output", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, outputFormat: "pcm16le" });
	const audioMod = await import("../core/node_modules/audio/audio.js");
	const source = audioMod.default.from((t) => Math.sin(2 * Math.PI * 440 * t), {
		duration: 0.05,
		sampleRate: 8000,
		channels: 1,
	});
	const wav = await source.encode("wav");
	const pipeline = await engine.createPipeline({ enabled: true, outputFormat: "pcm16le" }, { playerId: "p4" });
	const chunks = [];
	for await (const chunk of pipeline.process(
		(async function* () {
			yield wav;
		})(),
		AbortSignal.timeout(3000),
	)) {
		assert.ok(chunk instanceof Uint8Array);
		assert.ok(chunk.length > 0);
		assert.equal(chunk.length % 2, 0);
		chunks.push(chunk);
	}
	assert.ok(chunks.length > 0);
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	assert.ok(totalLength > 0);
	const first = new Int16Array(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength / 2);
	assert.ok(first.length > 0);
	assert.ok(first.some((sample) => sample !== 0));
	await pipeline.dispose();
});

test("audio processing accepts Node readable streams with an attached audio pages field", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, outputFormat: "pcm16le" });
	const audioMod = await import("../core/node_modules/audio/audio.js");
	const wav = await audioMod.default
		.from((t) => Math.sin(2 * Math.PI * 440 * t), { duration: 0.02, sampleRate: 8000, channels: 1 })
		.encode("wav");
	const stream = Readable.from([wav]);
	stream.pages = [];
	const pipeline = await engine.createPipeline({ enabled: true, outputFormat: "pcm16le" });
	const chunks = [];
	for await (const chunk of pipeline.process(stream, AbortSignal.timeout(3000))) chunks.push(chunk);
	assert.ok(chunks.length > 0);
	assert.ok(chunks.some((chunk) => chunk.length > 0));
	await pipeline.dispose();
});

test("audio processing enforces maxBufferBytes before a larger chunk can escape the pipeline", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, outputFormat: "pcm16le", maxBufferBytes: 64 });
	const audioMod = await import("../core/node_modules/audio/audio.js");
	const wav = await audioMod.default
		.from((t) => Math.sin(2 * Math.PI * 440 * t), { duration: 0.05, sampleRate: 8000, channels: 1 })
		.encode("wav");
	const pipeline = await engine.createPipeline({ enabled: true, outputFormat: "pcm16le", maxBufferBytes: 64 }, { playerId: "p7" });
	await assert.rejects(async () => {
		for await (const _chunk of pipeline.process([wav], AbortSignal.timeout(3000))) {
			// The engine must reject a chunk larger than its buffer budget before yielding it.
		}
	}, /maxBufferBytes/i);
	await pipeline.dispose();
});

test("audio processing declares and enforces its PCM sample rate, channel count, and chunk alignment", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, outputFormat: "pcm16le" });
	const audioMod = await import("../core/node_modules/audio/audio.js");
	const wav = await audioMod.default
		.from((t) => Math.sin(2 * Math.PI * 440 * t), { duration: 0.02, sampleRate: 8000, channels: 1 })
		.encode("wav");
	const pipeline = await engine.createPipeline({ enabled: true, outputFormat: "pcm16le" });
	assert.deepEqual(pipeline.outputFormat, {
		kind: "pcm",
		sampleFormat: "s16",
		endianness: "little",
		sampleRateHz: 48000,
		channels: 2,
		channelLayout: "interleaved",
		chunkAlignmentBytes: 4,
	});
	const chunks = [];
	let byteLength = 0;
	for await (const chunk of pipeline.process([wav], AbortSignal.timeout(3000))) {
		assert.equal(chunk.byteLength % pipeline.outputFormat.chunkAlignmentBytes, 0);
		byteLength += chunk.byteLength;
		chunks.push(chunk);
	}
	assert.ok(chunks.length > 0);
	assert.equal(byteLength, 3840);
	await pipeline.dispose();
});

test("PlaybackController fails DSP setup instead of replaying a possibly consumed source stream", () => {
	const { Bus, PlaybackController } = require("../core/dist");
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		pause() {},
		resume() {},
		stop() {},
	});
	controller.attach("p5", {
		audioPlayer,
		audioProcessing: { enabled: true, inputFormat: "pcm16le", outputFormat: "pcm16le" },
		stuckTimeoutMs: 1000,
	});
	const stream = Readable.from([Buffer.from([0x00, 0x01, 0x02, 0x03])]);
	const track = { id: "fallback-track", title: "Fallback", duration: 1000 };
	assert.throws(
		() => controller.createResource("p5", stream, track, StreamType.Opus),
		/Audio processing inputFormat=pcm16le.*not supported/,
	);
	assert.equal(stream.readableDidRead, false);
	assert.equal(stream.destroyed, true);
	controller.detach("p5");
});

test("PlaybackController reports runtime DSP failure instead of mixing in encoded source bytes", async () => {
	const { Bus, PlaybackController } = require("../core/dist");
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
	controller.attach("p6", { audioPlayer, audioProcessing: { enabled: true } });
	const source = Readable.from([Buffer.from("not-a-valid-audio-container")]);
	const resource = controller.createResource(
		"p6",
		source,
		{ id: "broken-track", title: "Broken source", duration: 1000 },
		StreamType.Opus,
	);
	await assert.rejects(async () => {
		for await (const _chunk of resource.playStream) {
			assert.fail("Encoded source bytes must not be emitted as raw PCM fallback");
		}
	}, /Audio processing failed for Broken source/);
	assert.equal(source.readableDidRead, true);
	assert.equal(source.destroyed, true);
	controller.detach("p6");
});

test("processed raw PCM uses the Discord raw stream contract", () => {
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "pcm16le" }, StreamType.Opus), StreamType.Raw);
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "pcmFloat32" }, StreamType.WebmOpus), StreamType.Raw);
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "encoded" }, StreamType.Opus), StreamType.Opus);
	assert.equal(resolveOutputStreamType({ enabled: false, outputFormat: "pcm16le" }, StreamType.OggOpus), StreamType.OggOpus);
});
