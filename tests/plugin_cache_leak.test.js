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

// PluginController shares one PluginManager, while the manager keeps per-player stream runtime
// state. Direct white-box calls therefore pass the playerId just like the playback pipeline.
const pluginManagerOf = (mgr, guildId) => mgr.controllers.plugin.getManager(guildId);
const streamOptions = (guildId) => ({ context: { playerId: guildId } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("PluginManager stream cache is released when the player is destroyed", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild");

	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await pluginManager.getStream(track, streamOptions(player.id));
	assert.ok(streamInfo?.stream, "expected a resolved stream to be cached");
	const cachedStream = streamInfo.stream;

	// sanity: cache actually holds this exact stream object
	const again = await pluginManager.getStream(track, streamOptions(player.id));
	assert.equal(again.stream, cachedStream, "second call should hit the stream cache (same object)");

	player.destroy();
	// give any fire-and-forget async disposal a chance to run
	await sleep(50);

	assert.equal(cachedStream.destroyed, true, "cached stream must be destroyed after player.destroy()");
	assert.equal(mgr.controllers.plugin.has("leak-test-guild"), false, "PluginController must release the player's runtime");
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
	assert.equal(firstPluginManager, secondPluginManager, "all players use the shared PluginManager");
	const firstStream = (
		await firstPluginManager.getStream(
			{
				id: "first",
				title: "First",
				url: "fake:first",
				source: "fake",
			},
			streamOptions("resource-isolation-a"),
		)
	).stream;
	const secondStream = (
		await secondPluginManager.getStream(
			{
				id: "second",
				title: "Second",
				url: "fake:second",
				source: "fake",
			},
			streamOptions("resource-isolation-b"),
		)
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
	await pluginManager.getStream(track, streamOptions(player.id));
	player.destroy();
	await sleep(100);
	const handles = process._getActiveHandles ? process._getActiveHandles() : [];
	console.log(
		"ACTIVE HANDLES:",
		handles.length,
		handles.map((h) => h.constructor?.name),
	);
});

test("clearing a player's plugins alone does not destroy cached streams", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild-3");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild-3");
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	const streamInfo = await pluginManager.getStream(track, streamOptions(player.id));
	pluginManager.clearPlayerPlugins(player.id);
	assert.equal(streamInfo.stream.destroyed, false, "clearing plugin registrations does not call .destroy() on cached streams");
	player.destroy();
});

test("plugins and stream cache are cleared when the player is destroyed", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const player = await mgr.create("leak-test-guild-4");
	player.addPlugin(new FakePlugin());
	const pluginManager = pluginManagerOf(mgr, "leak-test-guild-4");
	const track = { id: "t1", title: "Track 1", url: "fake:t1", duration: 1000, source: "fake" };
	await pluginManager.getStream(track, streamOptions(player.id));
	const statsBefore = pluginManager.getStats(player.id);

	player.destroy();
	await sleep(20);

	assert.ok(statsBefore.streamCacheSize >= 1, "sanity: something was cached before destroy");
	assert.equal(pluginManager.get("fake", player.id), undefined, "registered plugin should be released after destroy");
	assert.equal(pluginManager.getStats(player.id).streamCacheSize, 0, "player stream cache should be emptied after destroy");
});
