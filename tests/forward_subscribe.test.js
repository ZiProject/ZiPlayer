const test = require("node:test");
const assert = require("node:assert/strict");

const { Bus, createSharedControllers, PlaybackMode, PLAYER_QUERY } = require("../core/dist");

/**
 * Fake queries are registered BEFORE createSharedControllers (the bus answers from the first
 * registered handler); fake RPCs are registered AFTER it (the last registration wins).
 */
function setup({ followerConn = true, leaderConn = false, leaderAudio = true } = {}) {
	const bus = new Bus();
	const audio = { leader: { id: "leader-audio" }, follower: { id: "follower-audio" } };
	const calls = [];
	bus.registerQuery(PLAYER_QUERY.voiceConnection, (id) => (id === "f" ? (followerConn ? {} : null) : leaderConn ? {} : null));
	bus.registerQuery(PLAYER_QUERY.audioPlayer, (id) => (id === "f" ? audio.follower : leaderAudio ? audio.leader : null));
	const { forward } = createSharedControllers({ bus });
	bus.registerRpc("queue.clear", () => undefined);
	bus.registerRpc("queue.setCurrent", () => undefined);
	bus.registerRpc("volume.set", () => undefined);
	bus.registerRpc("connection.setAudioPlayer", ({ audioPlayer }, ctx) => {
		calls.push({ playerId: ctx.playerId, audioPlayer });
	});
	forward.attach("l");
	forward.attach("f");
	return { bus, forward, audio, calls };
}

test("requestRpcSync cannot drive forward.subscribe (regression: why subscribeTo must be async)", (t) => {
	const { bus } = setup();
	t.after(() => bus.dispose());
	assert.throws(() => bus.requestRpcSync("f", "forward.subscribe", { leader: "l" }), /asynchronous/);
});

test("follower subscribes to a leader that has no voice connection (e.g. WebAudio-only)", async (t) => {
	const { bus, forward, audio, calls } = setup({ leaderConn: false });
	t.after(() => bus.dispose());

	assert.equal(await bus.requestRpc("f", "forward.subscribe", { leader: "l" }), true);
	assert.equal(forward.playbackMode("f"), PlaybackMode.FORWARD);
	assert.deepEqual(
		calls.filter((c) => c.playerId === "f").map((c) => c.audioPlayer),
		[audio.leader],
	);

	assert.equal(bus.requestRpcSync("f", "forward.unsubscribe", {}), true);
	assert.equal(forward.playbackMode("f"), PlaybackMode.NATIVE);
	assert.equal(calls.at(-1).audioPlayer, audio.follower);
});

test("subscribe is refused without a follower voice connection or a leader audio player", async (t) => {
	const noFollowerConn = setup({ followerConn: false });
	t.after(() => noFollowerConn.bus.dispose());
	assert.equal(await noFollowerConn.bus.requestRpc("f", "forward.subscribe", { leader: "l" }), false);

	const noLeaderAudio = setup({ leaderAudio: false });
	t.after(() => noLeaderAudio.bus.dispose());
	assert.equal(await noLeaderAudio.bus.requestRpc("f", "forward.subscribe", { leader: "l" }), false);
});
