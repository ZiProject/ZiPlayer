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

// `PluginManager` (and the stream cache it owns) is a per-player resource that `PlayerManager`
// wires up internally — there is no public `Player` API for it: `getStream()`/`getStats()` are
// implementation details the playback pipeline calls internally, not part of the RPC surface
// (`plugin.add`/`plugin.remove`/`plugin.get`/`plugin.list`/`plugin.clear`/`plugin.stats` cover
// registration and introspection, not stream fetching). A white-box test that needs to drive
// `getStream()` directly and inspect the cache therefore has to reach the exact same instance
// `player.addPlugin()` and the playback pipeline use — `PluginController` owns this
// instance keyed by playerId. `player.capabilities` is not part of the Player API.
const pluginManagerOf = (mgr, guildId) => mgr.controllers.plugin.getManager(guildId);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("PluginManager stream cache is released when the player is destroyed", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild");

	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await pluginManager.getStream(track);
	assert.ok(streamInfo?.stream, "expected a resolved stream to be cached");
	const cachedStream = streamInfo.stream;

	// sanity: cache actually holds this exact stream object
	const again = await pluginManager.getStream(track);
	assert.equal(again.stream, cachedStream, "second call should hit the stream cache (same object)");

	player.destroy();
	// give any fire-and-forget async disposal a chance to run
	await sleep(50);

	assert.equal(cachedStream.destroyed, true, "cached stream must be destroyed after player.destroy()");
	assert.equal(mgr.controllers.plugin.has("leak-test-guild"), false, "PluginController must release its manager");
});

test("disposing one player's managers leaves another player's resources intact", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const firstPlayer = await mgr.create("resource-isolation-a");
	const secondPlayer = await mgr.create("resource-isolation-b");
	firstPlayer.addPlugin(new FakePlugin());
	secondPlayer.addPlugin(new FakePlugin());
	const firstPluginManager = pluginManagerOf(mgr, "resource-isolation-a");
	const secondPluginManager = pluginManagerOf(mgr, "resource-isolation-b");
	const firstStream = (
		await firstPluginManager.getStream({
			id: "first",
			title: "First",
			url: "fake:first",
			source: "fake",
		})
	).stream;
	const secondStream = (
		await secondPluginManager.getStream({
			id: "second",
			title: "Second",
			url: "fake:second",
			source: "fake",
		})
	).stream;

	await mgr.destroy("resource-isolation-a");

	assert.equal(firstStream.destroyed, true);
	assert.equal(secondStream.destroyed, false);
	assert.equal(mgr.controllers.plugin.getManager("resource-isolation-a"), undefined);
	assert.equal(mgr.controllers.plugin.getManager("resource-isolation-b"), secondPluginManager);
	assert.equal(mgr.controllers.stream.has("resource-isolation-b"), true);
});

test("diagnostic: list active handles after destroy", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild-2");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild-2");
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	await pluginManager.getStream(track);
	player.destroy();
	await sleep(100);
	const handles = process._getActiveHandles ? process._getActiveHandles() : [];
	console.log(
		"ACTIVE HANDLES:",
		handles.length,
		handles.map((h) => h.constructor?.name),
	);
});

test("diagnostic: PluginManager.clear() alone still does not destroy underlying streams (destroy() does)", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild-3");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild-3");
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await pluginManager.getStream(track);
	pluginManager.clear();
	assert.equal(
		streamInfo.stream.destroyed,
		false,
		"clear() alone does not call .destroy() on cached streams (by design; destroy() does the full teardown)",
	);
	player.destroy();
});

test("plugins and stream cache are cleared when the player is destroyed", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild-4");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild-4");
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	await pluginManager.getStream(track);
	const statsBefore = pluginManager.getStats();

	player.destroy();
	await sleep(20);

	// The manager instance itself (captured above, before destroy() removed it from
	// PluginController) is what destroy() actually clears in place — verify on that same
	// reference, not a fresh (now-empty) lookup.
	const statsAfter = pluginManager.getStats();
	assert.ok(statsBefore.streamCacheSize >= 1, "sanity: something was cached before destroy");
	assert.equal(pluginManager.get("fake"), undefined, "registered plugin should be released after destroy");
	assert.equal(statsAfter.streamCacheSize, 0, "stream cache should be emptied after destroy");
});
