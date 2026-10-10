const { createAudioProcessingEngine } = require("../core/dist");
const audio = require("audio").default;

async function runOnce(label, fn) {
	const start = process.hrtime.bigint();
	const before = process.memoryUsage().rss;
	let totalBytes = 0;
	for (let i = 0; i < 8; i += 1) {
		totalBytes += await fn();
	}
	const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
	const after = process.memoryUsage().rss;
	console.log(`${label}: elapsed=${elapsedMs.toFixed(2)}ms totalBytes=${totalBytes} rssDelta=${after - before}`);
}

async function makeEncodedFixture() {
	const source = audio.from(
		(t) => {
			const tone = Math.sin(2 * Math.PI * 440 * t);
			const tremolo = 0.65 + 0.35 * Math.sin(2 * Math.PI * 3 * t);
			return tone * tremolo;
		},
		{ duration: 0.2, sampleRate: 48000, channels: 2 },
	);
	return await source.encode("wav");
}

(async () => {
	const fixture = await makeEncodedFixture();
	const legacy = async () => {
		let total = 0;
		for await (const chunk of (async function* () {
			yield fixture;
		})()) {
			total += chunk.length;
		}
		return total;
	};

	const dsp = async () => {
		const engine = createAudioProcessingEngine({
			enabled: true,
			outputFormat: "pcm16le",
			gainDb: 3,
			highpassHz: 80,
			normalize: false,
		});
		const pipeline = await engine.createPipeline({
			enabled: true,
			outputFormat: "pcm16le",
			gainDb: 3,
			highpassHz: 80,
			normalize: false,
		});
		let total = 0;
		for await (const chunk of pipeline.process(
			(async function* () {
				yield fixture;
			})(),
			AbortSignal.timeout(5000),
		)) {
			total += chunk.length;
		}
		await pipeline.dispose();
		return total;
	};

	console.log("AudioEngine benchmark (8 iterations each)\n");
	await runOnce("legacy", legacy);
	await runOnce("dsp-enabled", dsp);
})();
