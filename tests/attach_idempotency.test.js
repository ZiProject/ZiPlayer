const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

// `PlayerManager.attachPlayerControllers()` is called exactly once per playerId in normal
// operation (guarded by `players.has(guildId)`/`searchPlayer` checks), but nothing previously
// stopped a caller from invoking it twice for the same playerId without a `detach()` in between
// (this is exactly what used to happen for the search player, see search_player_teardown.test.js).
// Before this fix, most controllers' `attach()` just overwrote the `Map` entry, leaking the old
// worker's timers/subscriptions. Every `attach()` must now either (a) detach the stale entry
// first, or (b) be a documented no-op when already attached. See core/todo.md "Phát hiện 3".
const PLAYER_ID = "g-idempotency";

/**
 * Controllers/managers that must call `detach()` on their own stale entry before re-attaching.
 * `connection` is deliberately excluded here: its `attach()` releases the stale slot inline and
 * synchronously (its `detach()` is async, waiting on in-flight operations, so it is never called
 * from inside the synchronous `attach()` — see the comment on `ConnectionController.attach()`).
 * That inline cleanup is covered separately below, in the "does not orphan the old resource" test.
 */
const DETACH_THEN_REATTACH = [
	"playback",
	"preloadManager",
	"trackLoader",
	"queue",
	"volume",
	"transition",
	"forward",
	"session",
	"filter",
	"antiStuck",
	"stream",
	"save",
	"lifecycle",
	"tts",
	"search",
	"resourceRefresh",
	"plugin",
	"extension",
	"trackResolver",
	"eventBridge",
];

/** Controllers that intentionally no-op (keep the existing entry) when already attached. */
const SKIP_IF_ALREADY_ATTACHED = ["preload", "orchestrator"];

const stateMapOf = (controllers, name) => {
	const c = controllers[name];
	return c.slots ?? c.states ?? c.workers ?? c.managers ?? c.engines;
};

test("attach() re-run for an already-attached playerId detaches the stale entry first", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	mgr.attachPlayerControllers(PLAYER_ID, {});

	const spies = new Map();
	for (const name of DETACH_THEN_REATTACH) {
		const controller = mgr.controllers[name];
		const original = controller.detach.bind(controller);
		let calledWith = null;
		controller.detach = (playerId) => {
			if (playerId === PLAYER_ID) calledWith = playerId;
			return original(playerId);
		};
		spies.set(name, () => calledWith);
	}

	mgr.attachPlayerControllers(PLAYER_ID, {});

	for (const name of DETACH_THEN_REATTACH) {
		assert.equal(spies.get(name)(), PLAYER_ID, `${name}.detach() should be called before re-attaching`);
	}
});

test("attach() re-run for an already-attached playerId does not orphan the old resource", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	mgr.attachPlayerControllers(PLAYER_ID, {});

	const oldConnectionSlot = mgr.controllers.connection.slots.get(PLAYER_ID);
	const oldLifecycleWorker = mgr.controllers.lifecycle.workers.get(PLAYER_ID);
	const oldStreamManager = mgr.perPlayerResources.get(PLAYER_ID).streamManager;

	mgr.attachPlayerControllers(PLAYER_ID, {});

	assert.equal(oldConnectionSlot.disposed, true, "the old connection slot must be marked disposed, not just replaced");
	assert.equal(oldLifecycleWorker.disposed, true, "the old lifecycle worker must be disposed, not just replaced");
	assert.equal(
		oldStreamManager.cleanupTimer,
		null,
		"the old (unreachable) streamManager must be disposed, not orphaned with a live timer",
	);
	assert.notEqual(mgr.controllers.connection.slots.get(PLAYER_ID), oldConnectionSlot);
	assert.notEqual(mgr.controllers.lifecycle.workers.get(PLAYER_ID), oldLifecycleWorker);
	assert.notEqual(mgr.perPlayerResources.get(PLAYER_ID).streamManager, oldStreamManager);
});

test("attach() re-run for an already-attached playerId does not duplicate PlayerEventBridge bus subscriptions", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const { BUS_EVENT } = require("../core/dist");

	mgr.attachPlayerControllers(PLAYER_ID, {});
	mgr.attachPlayerControllers(PLAYER_ID, {});

	// Two attach() calls without an intervening detach() used to register the bridge's bus
	// listeners twice (attach() never captured/removed the previous `bus.subscribe()` unsubscribe
	// functions), so a single event would be forwarded to the Player more than once.
	let forwardCount = 0;
	const player = { destroyed: false, emit: () => forwardCount++ };
	mgr.controllers.eventBridge.attachPlayer(PLAYER_ID, player);
	mgr.bus.event(PLAYER_ID, { type: BUS_EVENT.trackStarted, track: { id: "t1" } });
	assert.equal(forwardCount, 1, "the event must be forwarded exactly once, not once per stale attach()");
});

for (const name of SKIP_IF_ALREADY_ATTACHED) {
	test(`${name}.attach() is a no-op when the playerId is already attached`, async (t) => {
		const mgr = new PlayerManager({ autoCleanup: false });
		t.after(() => mgr.destroy());

		mgr.attachPlayerControllers(PLAYER_ID, {});
		const before = stateMapOf(mgr.controllers, name).get(PLAYER_ID);

		mgr.attachPlayerControllers(PLAYER_ID, {});
		const after = stateMapOf(mgr.controllers, name).get(PLAYER_ID);

		assert.equal(after, before, `${name}'s entry must be left untouched, not replaced, on a repeat attach()`);
	});
}
