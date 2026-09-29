const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager, PlaybackMode } = require("../core/dist");

test("player.filter exposes filter engine and queryState", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-filter");
	assert.ok(player.filter, "player.filter should exist");
	assert.equal(typeof player.filter.getFilterString, "function");
	assert.equal(typeof player.filter.applyFilter, "function");
	assert.equal(typeof player.filter.applyFilters, "function");
	assert.equal(typeof player.filter.clearFilters, "function");
	assert.equal(player.filter.getFilterString(), "");
});

test("player.loop normalizes numbers 0, 1, 2 to off, track, queue", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-loop");
	assert.equal(player.loop(), "off");

	player.loop(1);
	assert.equal(player.loop(), "track");

	player.loop(2);
	assert.equal(player.loop(), "queue");

	player.loop(0);
	assert.equal(player.loop(), "off");

	player.loop("track");
	assert.equal(player.loop(), "track");
});

test("player.skip with invalid index returns false", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-skip");
	assert.equal(player.skip(0), false);
	assert.equal(player.skip(-1), false);
	assert.equal(player.skip(5), false);
});

test("player pause/resume state verification returns boolean", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-pause-resume");
	// Not playing, cannot pause
	assert.equal(player.pause(), false);
	// Not paused, cannot resume
	assert.equal(player.resume(), false);
});

test("player saveSession, getSerializableState, and restoreState", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-state");
	player.setVolume(75);
	player.loop(1);
	player.autoPlay(true);

	const track1 = { id: "t1", title: "Track 1", url: "https://example.com/1", duration: 180000, requestedBy: "user", source: "test" };
	const track2 = { id: "t2", title: "Track 2", url: "https://example.com/2", duration: 200000, requestedBy: "user", source: "test" };
	player.queue.addMultiple([track1, track2]);

	const session = player.saveSession();
	assert.equal(session.guildId, "guild-state");
	assert.equal(session.volume, 75);
	assert.equal(session.loopMode, "track");
	assert.equal(session.autoPlay, true);
	assert.equal(session.queue.length, 2);
	assert.equal(session.queue[0].id, "t1");
	assert.ok(Array.isArray(session.extensions));
	assert.ok(Array.isArray(session.plugins));

	const state = player.getSerializableState();
	assert.equal(state.guildId, "guild-state");
	assert.equal(state.volume, 75);
	assert.equal(state.loopMode, "track");
	assert.equal(state.autoPlay, true);
	assert.equal(state.queue.length, 2);
	assert.equal(typeof state.filters, "string");
	assert.equal(typeof state.timestamp, "number");

	// Create another player and restore state
	const player2 = await mgr.create("guild-state-2");
	const restored = await player2.restoreState(state);
	assert.equal(restored, true);
	assert.equal(player2.volume, 75);
	assert.equal(player2.loop(), "track");
	assert.equal(player2.autoPlay(), true);
	assert.equal(player2.queue.size, 2);
	assert.equal(player2.queue.getTrack(0)?.id, "t1");
});

test("FORWARD mode guards prevent mutating actions and return false", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const leader = await mgr.create("leader-guild");
	const follower = await mgr.create("follower-guild");

	mgr.controllers.forward.states.get("follower-guild").mode = PlaybackMode.FORWARD;

	assert.equal(await follower.play("query"), false);
	assert.equal(await follower.playNext(), false);
	assert.equal(follower.pause(), false);
	assert.equal(follower.resume(), false);
	assert.equal(follower.stop(), false);
	assert.equal(await follower.seek(1000), false);
	assert.equal(follower.skip(), false);
	assert.equal(follower.skip(0), false);
	assert.equal(await follower.previous(), false);
	assert.equal(follower.setVolume(80), false);
	assert.equal(await follower.insert("query"), false);
	follower.clearQueue(); // should not throw, just guard and return
});

test("QueueController emits queueAdd, queueAddList, queueRemove direct events", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-queue-events");
	const events = [];
	player.on("queueAdd", (track) => events.push({ type: "queueAdd", track }));
	player.on("queueAddList", (tracks) => events.push({ type: "queueAddList", count: tracks.length }));
	player.on("queueRemove", (track, index) => events.push({ type: "queueRemove", track, index }));

	const track1 = { id: "t1", title: "Track 1", url: "https://example.com/1", duration: 180000, requestedBy: "user", source: "test" };
	const track2 = { id: "t2", title: "Track 2", url: "https://example.com/2", duration: 200000, requestedBy: "user", source: "test" };
	const track3 = { id: "t3", title: "Track 3", url: "https://example.com/3", duration: 220000, requestedBy: "user", source: "test" };

	player.queue.add(track1);
	player.queue.addMultiple([track2, track3]);
	player.queue.remove(0);

	assert.equal(events.length, 3);
	assert.equal(events[0].type, "queueAdd");
	assert.equal(events[0].track.id, "t1");
	assert.equal(events[1].type, "queueAddList");
	assert.equal(events[1].count, 2);
	assert.equal(events[2].type, "queueRemove");
	assert.equal(events[2].track.id, "t1");
	assert.equal(events[2].index, 0);
});
