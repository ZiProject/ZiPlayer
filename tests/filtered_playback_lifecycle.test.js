"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { StreamType } = require("@discordjs/voice");
const ffmpegPath = require("ffmpeg-static");
const { FilterEngine, Bus, PlaybackController } = require("../core/dist");
const { makeWav } = require("./helpers/wav");

test("FilterEngine passes stream through untouched when no filters and no seek requested", async () => {
	const engine = new FilterEngine(undefined, () => {}, undefined, { ffmpegPath }, "filter-test-1");
	const inputSource = Readable.from([Buffer.from("unfiltered-data")]);
	const streamInfo = { stream: inputSource, track: { id: "t1", title: "Unfiltered" }, inputType: StreamType.Arbitrary };

	const result = await engine.applyFiltersAndSeek(streamInfo, -1);
	assert.equal(result.stream, inputSource, "Without filters or seek, original stream must be forwarded");
	assert.equal(result.inputType, StreamType.Arbitrary);

	engine.destroy();
	inputSource.destroy();
});

test("FilterEngine applies FFmpeg filter and emits OggOpus stream", async () => {
	const engine = new FilterEngine(
		{ refreshPlayerResource: async () => true },
		() => {},
		undefined,
		{ ffmpegPath },
		"filter-test-2",
	);
	// Apply a valid filter
	const applied = await engine.applyFilter("bass");
	assert.equal(applied, true);
	assert.ok(engine.hasFilter("bass"));
	assert.equal(engine.getFilterString(), "bass");

	const wav = makeWav({ seconds: 0.2, sampleRate: 48000, channels: 2 });
	const inputSource = Readable.from([wav]);
	const streamInfo = { stream: inputSource, track: { id: "t2", title: "Bass Filtered" }, inputType: StreamType.Arbitrary };

	const result = await engine.applyFiltersAndSeek(streamInfo, -1);
	assert.ok(result.stream, "Filtered stream must be produced");
	assert.notEqual(result.stream, inputSource, "Filtered stream must be a new stream from FFmpeg");
	assert.equal(result.inputType, StreamType.OggOpus, "FilterEngine must emit StreamType.OggOpus");

	// Read first chunk from FFmpeg output to verify Ogg container
	const firstChunk = await new Promise((resolve, reject) => {
		result.stream.once("data", resolve);
		result.stream.once("error", reject);
	});
	assert.ok(firstChunk.length > 0);
	assert.equal(firstChunk.subarray(0, 4).toString(), "OggS", "Output from FFmpeg filter must be Ogg Opus");

	// Feed filtered output directly into PlaybackController.createResource
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const EventEmitter = require("node:events").EventEmitter;
	const audioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		stop() {
			return true;
		},
		pause() {
			return true;
		},
		unpause() {
			return true;
		},
	});
	controller.attach("filter-test-2", { audioPlayer });

	const resource = controller.createResource("filter-test-2", result.stream, streamInfo.track, result.inputType);
	assert.ok(resource, "PlaybackController must create resource from filtered output");
	assert.ok(resource.volume, "Resource must support inline volume");

	// Teardown
	engine.destroy();
	controller.detach("filter-test-2");
});

test("FilterEngine destroy terminates FFmpeg process and cleans up resources", async () => {
	const engine = new FilterEngine(
		{ refreshPlayerResource: async () => true },
		() => {},
		undefined,
		{ ffmpegPath },
		"filter-cleanup-test",
	);
	await engine.applyFilter("tremolo");

	const wav = makeWav({ seconds: 5, sampleRate: 48000, channels: 2 });
	const inputSource = Readable.from([wav]);
	const streamInfo = { stream: inputSource, track: { id: "t3", title: "Tremolo Track" } };

	const result = await engine.applyFiltersAndSeek(streamInfo, -1);
	assert.ok(result.stream);

	// Destroying the filter engine must clean up FFmpeg and not leak
	engine.destroy();
	assert.equal(engine.getActiveFilters().length, 0);
	assert.equal(engine.lastFilteredStreamValue, null);
});

test("FilterEngine handles seek with recreate callback without FFmpeg", async () => {
	const engine = new FilterEngine(undefined, () => {}, undefined, { ffmpegPath }, "filter-seek-test");
	let recreatedAt = null;
	const streamInfo = {
		stream: Readable.from([Buffer.from("initial")]),
		recreate: async (position) => {
			recreatedAt = position;
			return Readable.from([Buffer.from("recreated-audio")]);
		},
		track: { id: "t4", title: "Recreatable" },
	};

	const result = await engine.applyFiltersAndSeek(streamInfo, 15000);
	assert.equal(recreatedAt, 15000);
	assert.equal(result.wasRecreated, true);

	result.stream.destroy();
	engine.destroy();
});

test("FilterEngine applies active filter when seeking a recreatable stream", async () => {
	const engine = new FilterEngine(undefined, () => {}, undefined, { ffmpegPath }, "filter-seek-recreate-test");
	const applied = await engine.applyFilter("bass");
	assert.equal(applied, true);

	let recreatedAt = null;
	const wav = makeWav({ seconds: 0.2, sampleRate: 48000, channels: 2 });
	const streamInfo = {
		stream: Readable.from([Buffer.from("initial")]),
		recreate: async (position) => {
			recreatedAt = position;
			return Readable.from([wav]);
		},
		track: { id: "t5", title: "Recreatable Filtered" },
	};

	const result = await engine.applyFiltersAndSeek(streamInfo, 10000);
	assert.equal(recreatedAt, 10000, "recreate should be called with seek position");
	assert.equal(result.wasRecreated, true, "wasRecreated flag must be true");
	assert.equal(result.inputType, StreamType.OggOpus, "output must be OggOpus when filters are active");
	assert.ok(result.stream, "must produce filtered output stream");

	// Verify FFmpeg filtered output header
	const firstChunk = await new Promise((resolve, reject) => {
		result.stream.once("data", resolve);
		result.stream.once("error", reject);
	});
	assert.equal(firstChunk.subarray(0, 4).toString(), "OggS", "Output from FFmpeg filter must be Ogg Opus");

	engine.destroy();
});

test("initialFilters are preserved on player creation without being rolled back", async () => {
	const { PlayerManager } = require("../core/dist");
	const manager = new PlayerManager();
	try {
		const player = await manager.create("guild-initial-filters", {
			filters: ["bassboost"],
		});
		assert.ok(player, "Player must be created");

		const activeFilters = player.filter.getActiveFilters();
		assert.equal(activeFilters.length, 1, "initialFilters must not be removed on creation");
		assert.equal(activeFilters[0].name, "bassboost");
		assert.equal(player.filter.hasFilter("bassboost"), true);
		assert.ok(player.filter.getFilterString().includes("bass="));
	} finally {
		manager.destroy();
	}
});

test("player.filter.applyFilter() before playback succeeds and retains filter", async () => {
	const { PlayerManager } = require("../core/dist");
	const manager = new PlayerManager();
	try {
		const player = await manager.create("guild-pre-playback-filter");
		assert.equal(player.filter.getActiveFilters().length, 0);

		const applied = await player.filter.applyFilter("nightcore");
		assert.equal(applied, true, "applyFilter before playback must succeed");
		assert.equal(player.filter.hasFilter("nightcore"), true);
		assert.ok(player.filter.getFilterString().includes("asetrate"));
	} finally {
		manager.destroy();
	}
});
