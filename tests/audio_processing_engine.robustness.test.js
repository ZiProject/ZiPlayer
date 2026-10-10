// Regression tests cho AudioProcessingEngine: đúng dạng sóng/biên độ/sample rate và vòng đời huỷ/lỗi.
// Chạy: node --test tests/audio_processing_engine.robustness.test.js (sau khi build core)
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createAudioProcessingEngine } = require("../core/dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) =>
	Promise.race([
		p.then(
			(v) => ({ ok: true, v }),
			(e) => ({ ok: false, e }),
		),
		sleep(ms).then(() => ({ hung: true })),
	]);

/** WAV 16-bit PCM sinh theo chunk; stats theo dõi upstream đã kết thúc (finally) hay chưa. */
function wavSource({
	seconds,
	sr = 44100,
	ch = 1,
	amp = 0.5,
	freq = 440,
	chunkBytes = 16384,
	stats = {},
	hangAfter,
	errorAfter,
}) {
	const frames = Math.round(seconds * sr);
	const data = frames * ch * 2;
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + data, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(ch, 22);
	h.writeUInt32LE(sr, 24);
	h.writeUInt32LE(sr * ch * 2, 28);
	h.writeUInt16LE(ch * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(data, 40);
	stats.pulled = 0;
	return (async function* () {
		try {
			yield h;
			for (let f = 0; f < frames; ) {
				if (hangAfter != null && stats.pulled >= hangAfter) await new Promise(() => {});
				if (errorAfter != null && stats.pulled >= errorAfter) throw new Error("ECONNRESET");
				const n = Math.min(chunkBytes / (ch * 2), frames - f);
				const b = Buffer.alloc(n * ch * 2);
				for (let i = 0; i < n; i++) {
					const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * (f + i)) / sr));
					for (let c = 0; c < ch; c++) b.writeInt16LE(v, (i * ch + c) * 2);
				}
				f += n;
				stats.pulled++;
				yield b;
			}
		} finally {
			stats.returned = true;
		}
	})();
}

async function render(opts, source) {
	const eng = createAudioProcessingEngine(opts);
	const p = await eng.createPipeline(opts);
	const bufs = [];
	for await (const c of p.process(source, AbortSignal.timeout(10_000))) bufs.push(Buffer.from(c));
	await p.dispose();
	const all = Buffer.concat(bufs);
	const { channels, sampleRateHz } = p.outputFormat;
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

test("PCM output preserves amplitude, frequency, duration and declared sample rate", async () => {
	const r = await render({ outputFormat: "pcm16le", normalize: false }, wavSource({ seconds: 1, sr: 44100, ch: 1, amp: 0.5 }));
	assert.equal(r.sampleRateHz, 48000);
	assert.equal(r.channels, 2);
	assert.ok(Math.abs(r.frames - 48000) <= 2, `frames=${r.frames}`);
	assert.ok(Math.abs(r.peak - 0.5) < 0.01, `peak=${r.peak}`);
	assert.ok(Math.abs(r.freq - 440) < 3, `freq=${r.freq}`);
	let maxDiff = 0;
	for (let i = 0; i < r.frames; i++) maxDiff = Math.max(maxDiff, Math.abs(r.left[i] - r.right[i]));
	assert.ok(maxDiff < 1e-3, "mono must be duplicated to both channels");
});

test("gain is applied linearly (+6 dB) and hard gain clamps instead of wrapping", async () => {
	const g6 = await render({ outputFormat: "pcm16le", normalize: false, gainDb: 6 }, wavSource({ seconds: 0.5, amp: 0.5 }));
	assert.ok(Math.abs(g6.peak - 0.5 * 10 ** (6 / 20)) < 0.02, `peak=${g6.peak}`);
	const g12 = await render({ outputFormat: "pcm16le", normalize: false, gainDb: 12 }, wavSource({ seconds: 0.5, amp: 0.5 }));
	assert.ok(g12.peak <= 1 && g12.peak > 0.99);
	assert.ok(Math.abs(g12.freq - 440) < 3, "clipping must not wrap around / change the waveform period");
});

test("highpass attenuates content below the cutoff", async () => {
	const r = await render({ outputFormat: "pcm16le", normalize: false, highpassHz: 2000 }, wavSource({ seconds: 0.5, amp: 0.5 }));
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
