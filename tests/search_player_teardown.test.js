const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

// The internal search player (see PlayerManager.getSearchPlayer()) is deliberately never stored
// in `players` — but it still gets a full set of shared-controller state via
// `attachPlayerControllers()`. Before this fix, `Player.destroy()` on it never reached
// `PlayerManager.requestDestroy()`'s teardown branch (only players tracked in `this.players`
// did), so that state leaked forever. See core/todo.md "Phát hiện 2".

const SEARCH_PLAYER_GUILD_ID = "__ziplayer_search__";

/** Every shared controller/manager map keyed by playerId, as used by `attachPlayerControllers`. */
const holders = (mgr, id) => {
	const c = mgr.controllers;
	const out = [];
	const check = (name, map) => {
		if (map?.has(id)) out.push(name);
	};
	check("connection", c.connection.slots);
	check("playback", c.playback.slots);
	check("preload", c.preload.states);
	check("preloadManager", c.preloadManager.slots);
	check("trackLoader", c.trackLoader.slots);
	check("trackResolver", c.trackResolver.slots);
	check("orchestrator", c.orchestrator.workers);
	check("queue", c.queue.states);
	check("volume", c.volume.states);
	check("transition", c.transition.states);
	check("forward", c.forward.states);
	check("session", c.session.states);
	check("filter", c.filter.engines);
	check("antiStuck", c.antiStuck.workers);
	check("stream", c.stream.workers);
	check("save", c.save.workers);
	check("lifecycle", c.lifecycle.workers);
	check("tts", c.tts.workers);
	check("search", c.search.workers);
	check("resourceRefresh", c.resourceRefresh.workers);
	check("plugin", c.plugin.managers);
	check("extension", c.extension.managers);
	check("eventBridge", c.eventBridge.slots);
	return out;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("getSearchPlayer().destroy() detaches every shared controller and perPlayerResources", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const searchPlayer = mgr.getSearchPlayer();
	assert.ok(holders(mgr, SEARCH_PLAYER_GUILD_ID).length > 0, "search player should have attached controller state");
	assert.ok(mgr.perPlayerResources.has(SEARCH_PLAYER_GUILD_ID));

	searchPlayer.destroy();
	assert.equal(searchPlayer.destroyed, true, "destroyed is visible synchronously");
	await sleep(20); // teardown finishes asynchronously

	assert.deepEqual(holders(mgr, SEARCH_PLAYER_GUILD_ID), [], "no controller should still hold search player state");
	assert.equal(mgr.perPlayerResources.has(SEARCH_PLAYER_GUILD_ID), false);
});

test("getSearchPlayer() called again after destroy re-attaches without leaking the old worker/streamManager", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const first = mgr.getSearchPlayer();
	const oldLifecycleWorker = mgr.controllers.lifecycle.workers.get(SEARCH_PLAYER_GUILD_ID);
	const oldStreamManager = mgr.perPlayerResources.get(SEARCH_PLAYER_GUILD_ID).streamManager;

	first.destroy();
	await sleep(20);

	const second = mgr.getSearchPlayer();
	assert.notEqual(second, first, "a fresh search player is created after the old one was destroyed");

	const newLifecycleWorker = mgr.controllers.lifecycle.workers.get(SEARCH_PLAYER_GUILD_ID);
	assert.notEqual(newLifecycleWorker, oldLifecycleWorker, "a new lifecycle worker is attached");
	assert.equal(oldLifecycleWorker.disposed, true, "the old lifecycle worker must be disposed, not just replaced");

	const newStreamManager = mgr.perPlayerResources.get(SEARCH_PLAYER_GUILD_ID).streamManager;
	assert.notEqual(newStreamManager, oldStreamManager, "a new streamManager is created");
	assert.equal(
		oldStreamManager.cleanupTimer,
		null,
		"the old streamManager must be disposed by teardown (cleanup timer stopped), not orphaned",
	);
});
