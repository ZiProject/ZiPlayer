const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

// `ForwardController` and `PlaybackSessionController` both had a private lazy `state(playerId)`
// getter that silently created (and permanently kept) a Map entry for any playerId it was asked
// about, even one that was never `attach()`ed or was already `detach()`ed. A late call into
// either controller for a destroyed playerId used to resurrect a zombie entry that no future
// `detach()` would ever know to remove (the player is already gone from PlayerManager's point of
// view, so no `detach()` call for that id will ever happen again). See core/todo.md "Phát hiện 4".
const PLAYER_ID = "g-zombie";

test("ForwardController.healthStatus() after detach() does not resurrect a Map entry", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await mgr.create(PLAYER_ID);
	await mgr.destroy(PLAYER_ID);
	assert.equal(mgr.controllers.forward.states.has(PLAYER_ID), false, "detach() should have removed the entry");

	// A late, otherwise-harmless read call — must not create a permanent entry.
	mgr.controllers.forward.healthStatus(PLAYER_ID);
	assert.equal(mgr.controllers.forward.states.has(PLAYER_ID), false, "healthStatus() must not resurrect the entry");
});

test("ForwardController read methods return safe defaults for an unattached playerId", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const status = mgr.controllers.forward.healthStatus("never-attached");
	assert.equal(status.role, "none");
	assert.equal(status.healthy, true);
	assert.equal(mgr.controllers.forward.states.has("never-attached"), false);
});

test("PlaybackSessionController.replace() after detach() does not resurrect a Map entry", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await mgr.create(PLAYER_ID);
	await mgr.destroy(PLAYER_ID);
	assert.equal(mgr.controllers.session.states.has(PLAYER_ID), false, "detach() should have removed the entry");

	// replace() is the method that used the lazy, resurrecting state() getter internally.
	const track = { id: "t1", title: "t1", url: "https://example.com/t1", duration: 1000, requestedBy: "tester", source: "test" };
	mgr.controllers.session.replace(PLAYER_ID, track);
	assert.equal(mgr.controllers.session.states.has(PLAYER_ID), false, "replace() must not resurrect the entry");
	assert.equal(mgr.controllers.session.current(PLAYER_ID), null, "no session should be observable for an unattached playerId");
});
