const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

const { PlayerManager, BasePlugin } = require("../core/dist");

class FakePlugin extends BasePlugin {
	name = "fake";
	version = "1.0.0";
	canHandle(url) {
		return typeof url === "string" && url.startsWith("fake:");
	}
	async search(query) {
		return { tracks: [{ id: "t1", title: query, url: "fake:t1", duration: 1000, source: "fake" }], playlist: null };
	}
	async getStream(track) {
		const stream = new Readable({ read() {} });
		stream._testStream = true;
		return { stream, type: "arbitrary" };
	}
}

test("PluginManager stream cache is not released when the player is destroyed", async () => {
	const mgr = new PlayerManager();
	const player = await mgr.create("leak-test-guild");
	player.pluginManager.register(new FakePlugin());

	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await player.pluginManager.getStream(track);
	assert.ok(streamInfo?.stream, "expected a resolved stream to be cached");
	const cachedStream = streamInfo.stream;

	// sanity: cache actually holds this exact stream object
	const again = await player.pluginManager.getStream(track);
	assert.equal(again.stream, cachedStream, "second call should hit the stream cache (same object)");

	player.destroy();
	// give any fire-and-forget async disposal a chance to run
	await new Promise((resolve) => setTimeout(resolve, 50));

	// EXPECTATION (desired, currently fails): destroying the player should
	// release cached plugin streams so they don't linger as open handles.
	assert.equal(cachedStream.destroyed, true, "cached stream should be destroyed after player.destroy()");

	mgr.destroy();
});

test("diagnostic: list active handles after destroy", async () => {
	const mgr = new PlayerManager();
	const player = await mgr.create("leak-test-guild-2");
	player.pluginManager.register(new FakePlugin());
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	await player.pluginManager.getStream(track);
	player.destroy();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const handles = process._getActiveHandles ? process._getActiveHandles() : [];
	console.log(
		"ACTIVE HANDLES:",
		handles.length,
		handles.map((h) => h.constructor?.name),
	);
	mgr.destroy();
});

test("diagnostic: PluginManager.clear() alone still does not destroy underlying streams (destroy() does)", async () => {
	const mgr = new PlayerManager();
	const player = await mgr.create("leak-test-guild-3");
	player.pluginManager.register(new FakePlugin());
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await player.pluginManager.getStream(track);
	player.pluginManager.clear();
	assert.equal(
		streamInfo.stream.destroyed,
		false,
		"clear() alone does not call .destroy() on cached streams (by design; destroy() does the full teardown)",
	);
	player.destroy();
	mgr.destroy();
});

test("diagnostic: PluginManager cache/plugins are never cleared on player.destroy()", async () => {
	const mgr = new PlayerManager();
	const player = await mgr.create("leak-test-guild-4");
	player.pluginManager.register(new FakePlugin());
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	await player.pluginManager.getStream(track);
	const statsBefore = player.pluginManager.getStats ? player.pluginManager.getStats() : null;
	player.destroy();
	await new Promise((r) => setTimeout(r, 20));
	const statsAfter = player.pluginManager.getStats ? player.pluginManager.getStats() : null;
	console.log("stats before:", statsBefore, "stats after destroy:", statsAfter);
	assert.equal(player.pluginManager.get("fake"), undefined, "registered plugin should be released after destroy");
	assert.equal(statsAfter.streamCacheSize, 0, "stream cache should be emptied after destroy");
	mgr.destroy();
});
