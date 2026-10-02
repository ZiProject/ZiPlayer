const test = require("node:test");
const assert = require("node:assert/strict");

const { createSharedControllers } = require("../core/dist");

// Failure accounting is bounded per player to prevent unbounded growth over long uptimes.
// Drive the internal bookkeeping directly rather than the full recovery flow, which emits bus
// events and includes a (by default 90s) retry delay.
const PLAYER_ID = "g-antistuck";

test("anti-stuck failures do not grow past MAX_FAILURE_ENTRIES", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const state = antiStuck.states.get(PLAYER_ID);

	for (let i = 0; i < 2000; i++) {
		state.recordFailure(`track-${i}`, 1);
	}

	assert.equal(state.failures.size, 500, "the Map must be capped, not grow with every distinct failing track");
	// LRU: the most recently recorded entries survive, the oldest ones are evicted first.
	assert.equal(state.failures.has("track-1999"), true, "the most recent entry must still be present");
	assert.equal(state.failures.has("track-0"), false, "the oldest entry must have been evicted");
});

test("re-recording an already-tracked key does not evict anything (in-place update)", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const state = antiStuck.states.get(PLAYER_ID);

	for (let i = 0; i < 500; i++) state.recordFailure(`track-${i}`, 1);
	assert.equal(state.failures.size, 500);

	state.recordFailure("track-0", 2); // already tracked — updates in place, no eviction needed
	assert.equal(state.failures.size, 500);
	assert.equal(state.failures.get("track-0"), 2);
});

test("detach clears per-player failure data", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const state = antiStuck.states.get(PLAYER_ID);
	state.recordFailure("track-x", 1);
	assert.equal(state.failures.size, 1);

	antiStuck.detach(PLAYER_ID);
	assert.equal(state.failures.size, 0, "detach must clear the removed player's state");
});
