const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager, CONTROLLER_RPC } = require("../core/dist");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('bus answers "runtime.ping" for a tracked, live player', async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	assert.equal(mgr.bus.hasRpc(CONTROLLER_RPC.runtimePing), true, "a handler must be registered");
	await mgr.create("g-ping");

	const ok = await mgr.bus.requestRpc("g-ping", CONTROLLER_RPC.runtimePing, { playerId: "g-ping" }, { timeoutMs: 500 });
	assert.equal(ok, true);
	assert.equal(await mgr.controllerRegistry.ping("g-ping"), true, "the heartbeat must accept an explicit alive response");
});

test("a player is not heartbeat-monitored until PlayerManager tracks it", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	mgr.attachPlayerControllers("g-initializing", {});
	assert.equal(mgr.controllerRegistry.has("g-initializing"), false);
	await mgr.detachControllers("g-initializing");

	const player = await mgr.create("g-initialized");
	assert.equal(mgr.playersByRoutingId.get(player.routingPlayerId), player);
	assert.equal(mgr.controllerRegistry.has(player.routingPlayerId), true);
});

test("runtime.ping response false is not treated as alive", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await mgr.create("g-ping-false");
	mgr.bus.registerRpc(CONTROLLER_RPC.runtimePing, () => false);

	assert.equal(await mgr.controllerRegistry.ping("g-ping-false"), false);
	const entry = mgr.controllerRegistry.get("g-ping-false");
	assert.ok(entry.unreachableSince, "false response must start unreachable tracking");

	mgr.bus.registerRpc(CONTROLLER_RPC.runtimePing, () => true);
	assert.equal(await mgr.controllerRegistry.ping("g-ping-false"), true);
	assert.equal(entry.unreachableSince, undefined, "a later explicit alive response must clear unreachable tracking");
});

test('"runtime.ping" rejects for a playerId the manager no longer tracks', async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await assert.rejects(() =>
		mgr.bus.requestRpc("g-unknown", CONTROLLER_RPC.runtimePing, { playerId: "g-unknown" }, { timeoutMs: 500 }),
	);
});

test("a healthy, reachable player survives multiple heartbeat cycles untouched", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await mgr.create("g-healthy");
	// Default heartbeatMs is 2000ms; wait past two cycles. Before "runtime.ping" had a real
	// handler, this alone was enough to get every player disposed as "unreachable".
	await sleep(4500);

	assert.equal(mgr.has("g-healthy"), true, "the player must still be tracked");
	const player = mgr.get("g-healthy");
	assert.equal(player.destroyed, false, "the player must not have been disposed by its own heartbeat");
	assert.equal(mgr.controllers.connection.slots.has("g-healthy"), true, "controller state must still be attached");
});

test("a player that becomes untrackable (e.g. its facade is lost) is auto-detected and fully cleaned up", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	await mgr.create("g-orphan");
	assert.equal(mgr.controllers.connection.slots.has("g-orphan"), true);

	// Simulate the player becoming unreachable from PlayerManager's point of view without an
	// explicit destroy() — this is the scenario "runtime.ping" is meant to catch.
	mgr.playersByRoutingId.delete("g-orphan");

	// Default staleAfterMs is 10s and heartbeatMs is 2s; give it enough time to be detected and
	// disposed automatically, with no manual sweep call.
	await sleep(13_000);

	assert.equal(mgr.controllers.connection.slots.has("g-orphan"), false, "connection state must be cleaned up");
	assert.equal(mgr.controllers.queue.states.has("g-orphan"), false, "queue state must be cleaned up");
	assert.equal(mgr.controllers.stream.has("g-orphan"), false, "stream controller state must be cleaned up");
	assert.equal(mgr.controllers.plugin.has("g-orphan"), false, "plugin manager must be cleaned up");
	assert.equal(mgr.controllers.extension.has("g-orphan"), false, "extension manager must be cleaned up");
});
