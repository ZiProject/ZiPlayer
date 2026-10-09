const test = require("node:test");
const assert = require("node:assert/strict");

const { createAudioProcessingEngine, resolveOutputStreamType } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");

test("audio processing engine can apply gain and emit valid PCM output", async () => {
	const engine = createAudioProcessingEngine({ enabled: true, gainDb: 6, highpassHz: 80, resampleRate: 8000 });
	const audioMod = await import("audio");
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

test("processed raw PCM uses the Discord raw stream contract", () => {
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "pcm16le" }, StreamType.Opus), StreamType.Raw);
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "pcmFloat32" }, StreamType.WebmOpus), StreamType.Raw);
	assert.equal(resolveOutputStreamType({ enabled: true, outputFormat: "encoded" }, StreamType.Opus), StreamType.Opus);
	assert.equal(resolveOutputStreamType({ enabled: false, outputFormat: "pcm16le" }, StreamType.OggOpus), StreamType.OggOpus);
});
