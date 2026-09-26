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

test("PlaybackOrchestrator.dispose() resolves only after every worker finished its cleanup", async () => {
	const { Bus, PlaybackSessionController, createPlaybackOrchestrator } = require("../core/dist");
	const bus = new Bus();
	const sessionController = new PlaybackSessionController(bus);
	const orchestrator = createPlaybackOrchestrator(bus, { sessionController });
	const cleaned = [];
	for (const playerId of ["orch-a", "orch-b", "orch-c"]) {
		sessionController.attach(playerId);
		orchestrator.attach(playerId);
		const worker = orchestrator.workers.get(playerId);
		worker.trackEnd.dispose = async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			cleaned.push(playerId);
		};
	}

	const pending = orchestrator.dispose();
	assert.ok(pending instanceof Promise);
	assert.deepEqual(cleaned, [], "cleanup is asynchronous");

	await pending;
	assert.deepEqual([...cleaned].sort(), ["orch-a", "orch-b", "orch-c"]);
	for (const playerId of ["orch-a", "orch-b", "orch-c"]) assert.equal(orchestrator.has(playerId), false);
});

test("PlaybackOrchestrator.dispose() cleans the other workers when one fails, then reports the failure", async () => {
	const { Bus, PlaybackSessionController, createPlaybackOrchestrator } = require("../core/dist");
	const bus = new Bus();
	const sessionController = new PlaybackSessionController(bus);
	const orchestrator = createPlaybackOrchestrator(bus, { sessionController });
	const cleaned = [];
	for (const playerId of ["fail", "ok"]) {
		sessionController.attach(playerId);
		orchestrator.attach(playerId);
	}
	orchestrator.workers.get("fail").trackEnd.dispose = async () => {
		throw new Error("boom");
	};
	orchestrator.workers.get("ok").trackEnd.dispose = async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		cleaned.push("ok");
	};

	await assert.rejects(() => orchestrator.dispose(), (error) => error instanceof AggregateError && error.errors[0].message === "boom");
	assert.deepEqual(cleaned, ["ok"]);
	assert.equal(orchestrator.has("fail"), false);
	assert.equal(orchestrator.has("ok"), false);
});

test("PlayerManager.dispose() finishes the orchestrator cleanup before the Bus is disposed", async () => {
	const mgr = new PlayerManager();
	await mgr.create("g-shutdown");
	const order = [];
	const orchestrator = mgr.controllers.orchestrator;
	const disposeOrchestrator = orchestrator.dispose.bind(orchestrator);
	orchestrator.dispose = async () => {
		await disposeOrchestrator();
		await new Promise((resolve) => setTimeout(resolve, 30));
		order.push("orchestrator.dispose done");
	};
	const disposeBus = mgr.bus.dispose.bind(mgr.bus);
	mgr.bus.dispose = () => {
		order.push("bus.dispose");
		return disposeBus();
	};

	await mgr.destroy();

	assert.deepEqual(order, ["orchestrator.dispose done", "bus.dispose"]);
});

test("PlayerManager.dispose() waits for a destroy(playerId) that is still detaching", async () => {
	const mgr = new PlayerManager();
	await mgr.create("g-race");
	const order = [];
	const connection = mgr.controllers.connection;
	const detachConnection = connection.detach.bind(connection);
	connection.detach = async (playerId) => {
		await new Promise((resolve) => setTimeout(resolve, 40));
		await detachConnection(playerId);
		if (playerId === "g-race") order.push("connection.detached");
	};
	const disposeBus = mgr.bus.dispose.bind(mgr.bus);
	mgr.bus.dispose = () => {
		order.push("bus.dispose");
		return disposeBus();
	};

	const destroying = mgr.destroy("g-race"); // teardown still in flight...
	await mgr.destroy(); // ...when the whole manager is disposed
	await destroying;

	assert.deepEqual(order, ["connection.detached", "bus.dispose"]);
});

test("Player.dispose() cannot skip the controller detach", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());
	const player = await mgr.create("g-dispose");
	const order = traceTeardown(mgr, player);

	player.dispose();

	await waitFor(() => order.includes("bus.disposePlayer"));
	assertOrdered(order, "abortWorkflow", "detach:orchestrator", "detach:connection", "bus.disposePlayer");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extension whose activation is slow, which keeps `PlayerManager.create()` in flight for a while. */
const slowExtension = (ms) => ({
	name: "slow-ext",
	version: "0.0.0",
	player: null,
	async active() {
		await sleep(ms);
		return true;
	},
});

const assertNothingAttached = (mgr, playerId) => {
	assert.equal(mgr.has(playerId), false);
	assert.equal(mgr.controllers.queue.states.has(playerId), false, "queue state released");
	assert.equal(mgr.controllers.orchestrator.has(playerId), false, "orchestrator worker released");
	assert.equal(mgr.controllers.connection.slots.has(playerId), false, "connection slot released");
	assert.equal(mgr.perPlayerResources.has(playerId), false, "per-player resources released");
};

test("dispose() during create() rolls the creation back instead of leaking its controllers", async () => {
	const mgr = new PlayerManager({ extensions: [slowExtension(60)], autoCleanup: false });
	const creating = mgr.create("g-create-race", { extensions: ["slow-ext"] });
	creating.catch(() => undefined);
	await sleep(15); // controllers attached, extension activation still pending

	assert.equal(mgr.controllers.queue.states.has("g-create-race"), true);
	await mgr.destroy();

	await assert.rejects(creating, /disposed/);
	assertNothingAttached(mgr, "g-create-race");
	assert.equal(mgr.size, 0);
	assert.equal(mgr.pendingPlayers.size, 0);
});

test("create() after dispose() is rejected", async () => {
	const mgr = new PlayerManager({ autoCleanup: false });
	await mgr.destroy();

	await assert.rejects(() => mgr.create("g-late"), /disposed/);
	await assert.rejects(() => mgr.search("dummy:late", "tester"), /disposed/);
});

test("destroy(playerId) during create() destroys the player once it exists", async (t) => {
	const mgr = new PlayerManager({ extensions: [slowExtension(40)], autoCleanup: false });
	t.after(() => mgr.destroy());
	const creating = mgr.create("g-destroy-race", { extensions: ["slow-ext"] });
	await sleep(10);

	const destroying = mgr.destroy("g-destroy-race");
	const player = await creating;
	await destroying;

	assert.equal(player.destroyed, true);
	assertNothingAttached(mgr, "g-destroy-race");
});

test("a failed create() releases what it attached and the guild can be created again", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const eventBridge = mgr.controllers.eventBridge;
	const attachPlayer = eventBridge.attachPlayer.bind(eventBridge);
	eventBridge.attachPlayer = () => {
		throw new Error("boom");
	};

	await assert.rejects(() => mgr.create("g-fail"), /boom/);
	assertNothingAttached(mgr, "g-fail");
	assert.equal(mgr.pendingPlayers.size, 0);

	eventBridge.attachPlayer = attachPlayer;
	const player = await mgr.create("g-fail");
	assert.equal(mgr.get("g-fail"), player);
	assert.equal(player.destroyed, false);
});

test("createSharedControllers builds the whole set from a Bus alone (no PlayerManager needed)", () => {
	const { Bus, createSharedControllers } = require("../core/dist");
	const bus = new Bus();
	const controllers = createSharedControllers({ bus });

	assert.equal(controllers.bus, bus);
	for (const name of ["connection", "playback", "preload", "trackLoader", "orchestrator", "queue", "lifecycle", "eventBridge"]) {
		assert.ok(controllers[name], `${name} controller is created`);
	}
	bus.dispose();
});
