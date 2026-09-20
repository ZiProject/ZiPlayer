const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const makeTrack = (id) => ({ id, title: id, url: `https://example.com/${id}`, duration: 1000, requestedBy: "tester", source: "test" });

/** Records the teardown order of one player: workflow abort, controller detaches, bus disposal. */
const traceTeardown = (mgr, player) => {
	const order = [];
	const controllers = mgr.controllers;
	for (const name of ["orchestrator", "lifecycle", "queue", "playback", "connection"]) {
		const controller = controllers[name];
		const original = controller.detach.bind(controller);
		controller.detach = (playerId) => {
			if (playerId === player.playerId) order.push(`detach:${name}`);
			return original(playerId);
		};
	}
	const abort = player.abortWorkflow.bind(player);
	player.abortWorkflow = () => {
		order.push("abortWorkflow");
		return abort();
	};
	const disposePlayer = player.bus.disposePlayer.bind(player.bus);
	player.bus.disposePlayer = (playerId) => {
		if (playerId === player.playerId) order.push("bus.disposePlayer");
		return disposePlayer(playerId);
	};
	return order;
};

const assertOrdered = (order, ...names) => {
	const indexes = names.map((name) => order.indexOf(name));
	assert.ok(
		indexes.every((index) => index >= 0),
		`missing step in ${order.join(" > ")}`,
	);
	assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), `unexpected order: ${order.join(" > ")}`);
};

test("PlayerManager.destroy aborts the workflow, detaches controllers, then disposes the bus", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const player = await mgr.create("g-order");
	const order = traceTeardown(mgr, player);

	await mgr.destroy("g-order");

	assertOrdered(order, "abortWorkflow", "detach:orchestrator", "detach:lifecycle", "detach:queue", "detach:connection", "bus.disposePlayer");
	assert.equal(player.destroyed, true);
	assert.equal(mgr.has("g-order"), false);
});

test("player.destroy() on a managed player takes the same ordered path", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const player = await mgr.create("g-direct");
	const order = traceTeardown(mgr, player);

	player.destroy();
	assert.equal(player.destroyed, true, "destroyed is visible synchronously");
	assert.equal(mgr.has("g-direct"), false);

	await waitFor(() => order.includes("bus.disposePlayer"));
	assertOrdered(order, "abortWorkflow", "detach:orchestrator", "detach:connection", "bus.disposePlayer");
	assert.equal(mgr.controllers.queue.states.has("g-direct"), false);
});

test("cleanupInactivePlayers detaches the shared controllers, not just the player", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const player = await mgr.create("g-idle");
	assert.equal(mgr.controllers.queue.states.has("g-idle"), true);

	mgr.cleanupTimeout = 0;
	player._lastActivity = Date.now() - 1000;
	mgr.cleanupInactivePlayers();

	await waitFor(() => !mgr.controllers.queue.states.has("g-idle"));
	assert.equal(mgr.has("g-idle"), false);
	assert.equal(player.destroyed, true);
});

test("delete() and deleteWhere() release the shared controllers too", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	await mgr.create("g-del-1");
	await mgr.create("g-del-2");

	assert.equal(mgr.delete("g-del-1"), true);
	assert.equal(mgr.deleteWhere((p) => p.playerId === "g-del-2"), 1);
	assert.equal(mgr.size, 0);

	await waitFor(() => mgr.controllers.queue.states.size === 0);
	assert.equal(mgr.controllers.orchestrator.has("g-del-1"), false);
	assert.equal(mgr.controllers.orchestrator.has("g-del-2"), false);
});

test("destroying one player leaves the other players' controller state alone", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const a = await mgr.create("g-a");
	const b = await mgr.create("g-b");
	b.queue.add(makeTrack("keep"));

	await mgr.destroy("g-a");

	assert.equal(a.destroyed, true);
	assert.equal(b.destroyed, false);
	assert.equal(b.queue.size, 1);
	assert.equal(mgr.controllers.orchestrator.has("g-b"), true);
});

test("player.queue operates on that player's queue only", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const a = await mgr.create("g-queue-a");
	const b = await mgr.create("g-queue-b");

	a.queue.add(makeTrack("1"));
	a.queue.addMultiple([makeTrack("2"), makeTrack("3")]);
	assert.equal(a.queue.size, 3);
	assert.equal(a.queueSize, 3);
	assert.equal(b.queue.size, 0);
	assert.equal(b.queue.isEmpty, true);

	a.queue.move(2, 0);
	assert.equal(a.queue.getTrack(0).id, "3");
	a.queue.swap(0, 1);
	assert.deepEqual(
		a.queue.getTracks().map((track) => track.id),
		["1", "3", "2"],
	);
	assert.equal(a.queue.indexOf("2"), 2);
	assert.equal(a.queue.has(makeTrack("3")), true);
	assert.equal(a.queue.remove(0).id, "1");
	assert.equal(a.queue.removeWhere((track) => track.id === "2").length, 1);
	assert.equal(a.queue.size, 1);

	assert.equal(a.queue.setLoop("queue"), "queue");
	assert.equal(a.loop(), "queue");
	a.queue.setAutoPlay(true);
	assert.equal(a.autoPlay(), true);

	a.queue.clear();
	assert.equal(a.queue.isEmpty, true);
	assert.equal(a.upcomingTracks.length, 0);
});

test("player.queue throws after the player is destroyed", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const player = await mgr.create("g-queue-gone");
	player.queue.add(makeTrack("1"));

	await mgr.destroy("g-queue-gone");

	assert.throws(() => player.queue, /Queue is not available/);
	assert.equal(player.queueSize, 0);
});
