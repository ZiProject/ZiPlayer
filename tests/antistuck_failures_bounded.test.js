const test = require("node:test");
const assert = require("node:assert/strict");

const { createSharedControllers } = require("../core/dist");

// Nothing in the codebase ever calls `AntiStuckWorker.clearTrack()`/`.clear()` when a track is
// simply skipped after exhausting its retries (only a *successful* retry, or the whole worker
// being `reset()`/`dispose()`d, removes an entry) — so for one long-running player, every
// distinct track that ever needed a retry attempt across its *entire* uptime used to accumulate
// in `failures` forever. It is now bounded (LRU-evicted) at `AntiStuckWorker.MAX_FAILURE_ENTRIES`
// (500). This test drives the internal bookkeeping directly (`recordFailure`) rather than the
// full `recover()` flow, which involves real bus events and a (by default 90s) retry delay.
const PLAYER_ID = "g-antistuck";

test("AntiStuckWorker's failures Map does not grow past MAX_FAILURE_ENTRIES", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const worker = antiStuck.workers.get(PLAYER_ID);

	for (let i = 0; i < 2000; i++) {
		worker.recordFailure(`track-${i}`, 1);
	}

	assert.equal(worker.failures.size, 500, "the Map must be capped, not grow with every distinct failing track");
	// LRU: the most recently recorded entries survive, the oldest ones are evicted first.
	assert.equal(worker.failures.has("track-1999"), true, "the most recent entry must still be present");
	assert.equal(worker.failures.has("track-0"), false, "the oldest entry must have been evicted");
});

test("re-recording an already-tracked key does not evict anything (in-place update)", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const worker = antiStuck.workers.get(PLAYER_ID);

	for (let i = 0; i < 500; i++) worker.recordFailure(`track-${i}`, 1);
	assert.equal(worker.failures.size, 500);

	worker.recordFailure("track-0", 2); // already tracked — updates in place, no eviction needed
	assert.equal(worker.failures.size, 500);
	assert.equal(worker.failures.get("track-0"), 2);
});

test("dispose() (via detach) still clears failures entirely, same as before", () => {
	const { antiStuck } = createSharedControllers({});
	antiStuck.attach(PLAYER_ID, {});
	const worker = antiStuck.workers.get(PLAYER_ID);
	worker.recordFailure("track-x", 1);
	assert.equal(worker.failures.size, 1);

	antiStuck.detach(PLAYER_ID);
	assert.equal(worker.failures.size, 0, "detach()/dispose() must still fully clear the bounded Map");
});
