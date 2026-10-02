const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const { FilterEngine, isSafeCustomFilter } = require("../core/dist");

test("isSafeCustomFilter accepts ordinary audio filter graphs", () => {
	for (const filter of [
		"bass=g=10",
		"atempo=1.25,asetrate=44100*1.1",
		"equalizer=f=1000:t=q:w=1:g=5,volume=2",
		"aecho=0.8:0.9:1000:0.3",
		"[0:a]loudnorm=I=-16[out]",
		"tremolo=f=5:d=0.5;vibrato",
	]) {
		assert.equal(isSafeCustomFilter(filter), true, filter);
	}
});

test("isSafeCustomFilter rejects filters that read files/URLs, control characters, empty and oversized input", () => {
	for (const filter of [
		"amovie=/etc/passwd",
		"movie=/etc/passwd[a]",
		"[x]amovie@z=filename=/etc/hosts",
		"AMOVIE=/etc/passwd",
		"asendcmd=f=/tmp/x",
		"ladspa=file=foo",
		"bass=g=5\nmovie=x",
		"",
		"a".repeat(1001),
	]) {
		assert.equal(isSafeCustomFilter(filter), false, JSON.stringify(filter.slice(0, 40)));
	}
});

test("FilterEngine.applyFilter refuses an unsafe raw filter string without touching the pipeline", async () => {
	const engine = new FilterEngine(undefined, () => {}, undefined, {}, "player-1");
	assert.equal(await engine.applyFilter("amovie=/etc/passwd"), false);
	assert.equal(engine.getFilterString(), "");
	assert.deepEqual(engine.getActiveFilters(), []);
});

test("FilterEngine survives ffmpeg exiting early while the source is still piping (EPIPE)", async (t) => {
	if (process.platform === "win32") return t.skip("needs a POSIX shell script as a fake ffmpeg");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-fake-ffmpeg-"));
	const fake = path.join(dir, "ffmpeg");
	fs.writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

	const uncaught = [];
	const onUncaught = (error) => uncaught.push(error);
	process.on("uncaughtException", onUncaught);

	const engine = new FilterEngine(undefined, () => {}, undefined, { ffmpegPath: fake }, "player-1");
	engine.activeFilters.push({ name: "bass", ffmpegFilter: "bass=g=5", description: "test" });
	const source = new Readable({
		read() {
			this.push(Buffer.alloc(64 * 1024));
		},
	});

	try {
		await engine.applyFiltersAndSeek({ stream: source, track: { id: "t1", title: "t" }, streamType: "arbitrary" }, -1);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.deepEqual(
			uncaught.map((e) => e.code || e.message),
			[],
			"an early ffmpeg exit must not raise an uncaught EPIPE",
		);
	} finally {
		process.off("uncaughtException", onUncaught);
		source.destroy();
		engine.destroy();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
