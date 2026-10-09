const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

test("Player setVolume constraints and event", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("g1");

	// out of range
	assert.equal(player.setVolume(-10), false);
	assert.equal(player.setVolume(201), false);

	let evtOld = null,
		evtNew = null;
	player.on("volumeChange", (oldV, newV) => {
		evtOld = oldV;
		evtNew = newV;
	});

	const ok = player.setVolume(50);
	assert.equal(ok, true);
	assert.equal(player.volume, 50);
	assert.equal(evtOld, 100);
	assert.equal(evtNew, 50);
});

test("PlayerManager stats snapshot aggregates from runtime controllers", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	await mgr.create("g1");

	const stats = mgr.getStats();
	assert.equal(typeof stats.players, "number");
	assert.equal(stats.players, 1);
	assert.equal(typeof stats.playback, "object");
	assert.equal(typeof stats.playback.playing, "number");
	assert.equal(typeof stats.playback.paused, "number");
	assert.equal(typeof stats.playback.idle, "number");
	assert.equal(typeof stats.streams, "object");
	assert.equal(typeof stats.streams.active, "number");
	assert.equal(typeof stats.streams.loading, "number");
	assert.equal(typeof stats.queues, "object");
	assert.equal(typeof stats.queues.totalTracks, "number");
	assert.equal(typeof stats.preload, "object");
	assert.equal(typeof stats.preload.active, "number");
	assert.equal(typeof stats.transitions, "object");
	assert.equal(typeof stats.transitions.active, "number");
	assert.equal(stats.totalPlayers, 1);
	assert.equal(stats.totalTracksInQueue, stats.queues.totalTracks);
});
