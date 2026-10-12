const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const { createAudioProcessingEngine, resolveOutputStreamType, FFmpegAudioProcessingEngine } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");
const { makeWav, analyzePcm16 } = require("./helpers/wav");

async function collect(pipeline, input, signal = AbortSignal.timeout(10_000)) {
	const chunks = [];
	for await (const chunk of pipeline.process(input, signal)) chunks.push(Buffer.from(chunk));
	return chunks;
}

test("audio processing engine applies gain and emits PCM at the declared format", async () => {
	const options = { enabled: true, gainDb: 6, highpassHz: 80, resampleRate: 8000 };
	const engine = createAudioProcessingEngine(options);
	const pipeline = await engine.createPipeline(options, { playerId: "p1" });
	const chunks = await collect(pipeline, [makeWav({ seconds: 0.5, sampleRate: 8000, channels: 2, amplitude: 0.25 })]);
	assert.equal(pipeline.outputFormat.sampleRateHz, 8000);
	const analysis = analyzePcm16(Buffer.concat(chunks), { sampleRate: 8000, channels: 2 });
	assert.ok(Math.abs(analysis.frames - 4000) <= 2, `frames=${analysis.frames}`);
	// 0.25 * 10^(6/20) ~= 0.499. The highpass has a start-up transient, so measure the steady-state tail.
	let steadyPeak = 0;
	for (let i = Math.floor(analysis.frames / 4); i < analysis.frames; i++)
		steadyPeak = Math.max(steadyPeak, Math.abs(analysis.left[i]));
	assert.ok(Math.abs(steadyPeak - 0.499) < 0.03, `steadyPeak=${steadyPeak}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 10, `frequency=${analysis.frequency}`);
	await pipeline.dispose();
});

test("audio processing engine rejects invalid DSP configuration", async () => {
	const engine = createAudioProcessingEngine();
	await assert.rejects(
		() => engine.createPipeline({ enabled: true, gainDb: Number.NaN }, { playerId: "p2" }),
		/gainDb|invalid|valid/i,
	);
	await assert.rejects(() => engine.createPipeline({ enabled: true, gainDb: 3, gainLinear: 2 }), /cannot both/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, channels: 1.5 }), /channels/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, normalize: "loud" }), /preset/i);
	await assert.rejects(() => engine.createPipeline({ enabled: true, normalize: -14 }), /numeric/i);
	assert.throws(() => createAudioProcessingEngine({ maxBufferBytes: 0 }), /maxBufferBytes/);
});

test("audio processing engine ignores undefined overrides instead of erasing defaults", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, sampleRate: 44_100, channels: 1 });
	const pipeline = await engine.createPipeline({ sampleRate: undefined, channels: undefined, gainDb: undefined });
	assert.equal(pipeline.outputFormat.sampleRateHz, 44_100);
	assert.equal(pipeline.outputFormat.channels, 1);
	await pipeline.dispose();
});

test("audio processing engine rejects raw PCM input because the runtime only supports encoded input", async () => {
	const engine = createAudioProcessingEngine();
	await assert.rejects(
		() => engine.createPipeline({ enabled: true, inputFormat: "pcm16le", outputFormat: "pcm16le" }, { playerId: "p3" }),
		/inputFormat.*encoded|not supported/i,
	);
});

test("audio processing engine emits valid PCM16 and keeps source amplitude and frequency", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, outputFormat: "pcm16le" });
	const pipeline = await engine.createPipeline({ enabled: true, outputFormat: "pcm16le" }, { playerId: "p4" });
	const chunks = await collect(pipeline, [makeWav({ seconds: 0.5, sampleRate: 44100, channels: 2, amplitude: 0.5 })]);
	assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length % 4 === 0));
	const analysis = analyzePcm16(Buffer.concat(chunks), { sampleRate: 48000, channels: 2 });
	assert.ok(Math.abs(analysis.frames - 24000) <= 2, `frames=${analysis.frames}`);
	assert.ok(Math.abs(analysis.peak - 0.5) < 0.02, `peak=${analysis.peak}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 5, `frequency=${analysis.frequency}`);
	assert.ok(analysis.maxChannelDiff < 1e-3);
	await pipeline.dispose();
});

test("audio processing emits float32 PCM when requested", async () => {
	const options = { enabled: true, outputFormat: "pcmFloat32" };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
	assert.equal(pipeline.outputFormat.sampleFormat, "f32");
	assert.equal(pipeline.outputFormat.chunkAlignmentBytes, 8);
	const buffer = Buffer.concat(
		await collect(pipeline, [makeWav({ seconds: 0.2, sampleRate: 48000, channels: 2, amplitude: 0.5 })]),
	);
	assert.equal(buffer.length % 8, 0);
	let peak = 0;
	for (let i = 0; i < buffer.length; i += 4) peak = Math.max(peak, Math.abs(buffer.readFloatLE(i)));
	assert.ok(Math.abs(peak - 0.5) < 0.02, `peak=${peak}`);
	await pipeline.dispose();
});

test("audio processing accepts Node readable streams", async () => {
	const options = { enabled: true, outputFormat: "pcm16le" };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
	const chunks = await collect(pipeline, Readable.from([makeWav({ seconds: 0.1, channels: 2 })]));
	assert.ok(chunks.length > 0);
	await pipeline.dispose();
});

test("audio processing splits output into frame-aligned chunks no larger than maxBufferBytes", async () => {
	const options = { enabled: true, outputFormat: "pcm16le", maxBufferBytes: 66 };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options, { playerId: "p7" });
	const chunks = await collect(pipeline, [makeWav({ seconds: 0.1, sampleRate: 48000, channels: 2 })]);
	assert.ok(chunks.length > 10);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 66, `chunk=${chunk.length}`);
		assert.equal(chunk.length % 4, 0);
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	assert.ok(Math.abs(total / 4 - 4800) <= 2, `frames=${total / 4}`);
	await pipeline.dispose();
});

test("audio processing declares its PCM sample rate, channel count, and chunk alignment", async () => {
	const options = { enabled: true, outputFormat: "pcm16le" };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
	assert.deepEqual(pipeline.outputFormat, {
		kind: "pcm",
		sampleFormat: "s16",
		endianness: "little",
		sampleRateHz: 48000,
		channels: 2,
		channelLayout: "interleaved",
		chunkAlignmentBytes: 4,
	});
	const chunks = await collect(pipeline, [makeWav({ seconds: 0.02, sampleRate: 8000, channels: 1 })]);
	let byteLength = 0;
	for (const chunk of chunks) {
		assert.equal(chunk.byteLength % pipeline.outputFormat.chunkAlignmentBytes, 0);
		byteLength += chunk.byteLength;
	}
	// 0.02 s at 48 kHz stereo s16 is 960 frames (3840 bytes); the resampler may be off by a frame.
	assert.ok(Math.abs(byteLength - 3840) <= 8, `bytes=${byteLength}`);
	await pipeline.dispose();
});

function pcm16Sine({ seconds, sampleRate, channels, amplitude = 0.5, frequency = 440 }) {
	const frames = Math.round(seconds * sampleRate);
	const buffer = Buffer.alloc(frames * channels * 2);
	for (let i = 0; i < frames; i++) {
		const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
		for (let c = 0; c < channels; c++) buffer.writeInt16LE(value, (i * channels + c) * 2);
	}
	return buffer;
}

test("declared PCM input is decoded exactly instead of being guessed by FFmpeg", async () => {
	const options = { enabled: true, outputFormat: "pcm16le" };
	const pcmFormat = {
		kind: "pcm",
		sampleFormat: "s16",
		endianness: "little",
		sampleRateHz: 48000,
		channels: 2,
		channelLayout: "interleaved",
	};
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options, { inputFormat: pcmFormat });
	const input = pcm16Sine({ seconds: 1, sampleRate: 48000, channels: 2 });
	const analysis = analyzePcm16(Buffer.concat(await collect(pipeline, Readable.from([input]))), {
		sampleRate: 48000,
		channels: 2,
	});
	assert.ok(Math.abs(analysis.frames - 48000) <= 2, `frames=${analysis.frames}`);
	assert.ok(Math.abs(analysis.peak - 0.5) < 0.02, `peak=${analysis.peak}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 3, `frequency=${analysis.frequency}`);
	await pipeline.dispose();
});

test("declared PCM input may use another rate, channel count and float samples", async () => {
	const options = { enabled: true, outputFormat: "pcm16le" };
	const frames = 22050;
	const input = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) input.writeFloatLE(0.5 * Math.sin((2 * Math.PI * 440 * i) / 22050), i * 4);
	const pcmFormat = {
		kind: "pcm",
		sampleFormat: "f32",
		endianness: "little",
		sampleRateHz: 22050,
		channels: 1,
		channelLayout: "interleaved",
	};
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options, { inputFormat: pcmFormat });
	const analysis = analyzePcm16(Buffer.concat(await collect(pipeline, [input])), { sampleRate: 48000, channels: 2 });
	assert.ok(Math.abs(analysis.frames - 48000) <= 2, `frames=${analysis.frames}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 3, `frequency=${analysis.frequency}`);
	await pipeline.dispose();
});

test("undeclared raw PCM is rejected instead of being played back as ADPCM noise", async () => {
	const options = { enabled: true };
	const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
	await assert.rejects(
		() => collect(pipeline, Readable.from([pcm16Sine({ seconds: 1, sampleRate: 48000, channels: 2 })])),
		/whitelist|Invalid data|produced no audio|Error opening input/i,
	);
	await pipeline.dispose();
});

test("malformed PCM input descriptions are rejected", async () => {
	const engine = createAudioProcessingEngine({ enabled: true });
	const base = {
		kind: "pcm",
		sampleFormat: "s16",
		endianness: "little",
		sampleRateHz: 48000,
		channels: 2,
		channelLayout: "interleaved",
	};
	await assert.rejects(() => engine.createPipeline({}, { inputFormat: { ...base, channels: 0 } }), /channels/);
	await assert.rejects(() => engine.createPipeline({}, { inputFormat: { ...base, sampleRateHz: -1 } }), /sampleRateHz/);
	await assert.rejects(() => engine.createPipeline({}, { inputFormat: { ...base, sampleFormat: "s24" } }), /sample format/);
});

test("loudness presets run through FFmpeg loudnorm and keep the output format", async () => {
	for (const normalize of [true, "streaming", "podcast", "broadcast"]) {
		const options = { enabled: true, normalize };
		const pipeline = await createAudioProcessingEngine(options).createPipeline(options);
		const buffer = Buffer.concat(
			await collect(pipeline, [makeWav({ seconds: 1, sampleRate: 48000, channels: 2, amplitude: 0.5 })]),
		);
		const analysis = analyzePcm16(buffer, { sampleRate: 48000, channels: 2 });
		assert.ok(analysis.frames > 40000, `normalize=${normalize} frames=${analysis.frames}`);
		assert.ok(analysis.peak > 0 && analysis.peak <= 1);
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
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "encoded" }, StreamType.Opus), StreamType.OggOpus);
	assert.equal(resolveOutputStreamType({ enabled: false, outputFormat: "pcm16le" }, StreamType.OggOpus), StreamType.OggOpus);
});
