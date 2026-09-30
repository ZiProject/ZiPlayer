const test = require("node:test");
const assert = require("node:assert/strict");

const {
	Bus,
	BUS_REQUEST,
	BUS_OUTPUT,
	PlaybackOrchestrator,
	createPlaybackOrchestrator,
	QueueController,
	PlaybackSessionController,
	Player,
} = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createHarness = ({ autoPlay = false, related = [] } = {}) => {
	const playerId = "test-guild-skip-abort";
	const bus = new Bus();
	const queueController = new QueueController(bus);
	const queue = queueController.attach(playerId);
	const sessionController = new PlaybackSessionController(bus);
	sessionController.attach(playerId);
	const played = [];

	let transitionSettings = { enabled: false, durationMs: 0 };
	bus.registerQuery("filterString", () => "");
	bus.registerQuery("transitionSettings", () => transitionSettings);
	bus.registerQuery("ttsInterrupt", () => false);
	bus.registerQuery("previousTracks", () => []);
	bus.registerRpc("resource.create", () => ({}));
	bus.registerRpc("preload.has", () => false);
	bus.registerRpc("preload.cancel", () => {});
	bus.registerRpc("controller.stream.replace", ({ streamInfo }) => ({
		stream: streamInfo.stream,
		inputType: streamInfo.inputType,
	}));
	bus.registerRpc("controller.track.loadWithRecovery", async (track) => ({ track, stream: { stream: null, remote: false } }));
	bus.registerRpc("controller.track.resetRecovery", () => {});
	bus.registerRpc("controller.transition.plan", () => ({
		enabled: false,
		durationMs: 0,
		waitForBeat: false,
		beatAlignMaxWaitMs: 0,
	}));
	bus.registerRpc("controller.volume.target", () => 1);
	bus.registerRpc("controller.playback.play", ({ session }) => {
		played.push(session.track.id);
	});
	bus.registerRpc("controller.playback.stop", () => {});
	bus.registerRpc("plugin.relatedTracks", async () => related ?? []);
	bus.onInput(BUS_REQUEST.preloadRequest, (event) => {
		bus.emitOutput({
			type: BUS_OUTPUT.preloadReady,
			requestId: event.requestId,
			track: event.track,
			playerId: event.playerId,
		});
	});

	queue.setAutoPlay(autoPlay);
	const orchestrator = createPlaybackOrchestrator(bus, { sessionController });
	orchestrator.attach(playerId);

	const player = new Player(playerId, bus);

	return {
		bus,
		playerId,
		queue,
		orchestrator,
		sessionController,
		played,
		player,
		setTransitionSettings: (s) => {
			transitionSettings = s;
		},
	};
};

test("Normal skip returns true and advances to the next track", async () => {
	const harness = createHarness();
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});
	harness.queue.add(trackB);

	const result = await harness.player.skip();
	assert.equal(result, true, "Normal skip should return true");

	await waitFor(() => harness.played.includes("track-b"));
	assert.equal(harness.sessionController.current(harness.playerId)?.track?.id, "track-b");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Skip aborted before execution returns false and preserves active state and queue", async () => {
	const harness = createHarness();
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});
	harness.queue.add(trackB);

	const abortController = new AbortController();
	abortController.abort();

	const worker = harness.orchestrator.workers?.get?.(harness.playerId);
	const result = await harness.player.skip({ signal: abortController.signal });
	assert.equal(result, false, "Pre-aborted skip should return false");

	// Active session remains trackA and queue still contains trackB
	assert.equal(harness.sessionController.current(harness.playerId)?.track?.id, "track-a");
	assert.equal(harness.queue.getTracks().length, 1);
	assert.equal(harness.queue.getTracks()[0].id, "track-b");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Skip aborted during prepare phase returns false and does not commit new track", async () => {
	const harness = createHarness();
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});
	harness.queue.add(trackB);

	const abortController = new AbortController();

	// Intercept transition fade to simulate async prepare phase and abort midway
	harness.bus.registerRpc("transition.fadeOutCurrent", async () => {
		abortController.abort();
		await new Promise((r) => setTimeout(r, 10));
	});

	// Enable transition so fadeOutCurrent is triggered
	harness.setTransitionSettings({ enabled: true, durationMs: 50 });

	const skipPromise = harness.player.skip({ signal: abortController.signal });
	const result = await skipPromise;

	assert.equal(result, false, "Skip aborted during prepare must return false");
	// Should not have committed track-b as new playing session
	assert.notEqual(harness.sessionController.current(harness.playerId)?.track?.id, "track-b");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Queued skip aborted externally resolves false without mutating playback or queue", async () => {
	const harness = createHarness();
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	let releaseLoad;
	let notifyLoadStarted;
	const loadStarted = new Promise((resolve) => {
		notifyLoadStarted = resolve;
	});
	const loadGate = new Promise((resolve) => {
		releaseLoad = resolve;
	});
	harness.bus.registerRpc("controller.track.loadWithRecovery", async (track) => {
		notifyLoadStarted();
		await loadGate;
		return { track, stream: { stream: null, remote: false } };
	});

	const firstAction = harness.player.action({ type: "PLAY", track: trackA });
	await loadStarted;
	harness.queue.add(trackB);
	const abortController = new AbortController();
	const queuedSkip = harness.player.skip({ signal: abortController.signal });
	abortController.abort();
	releaseLoad();
	await firstAction;

	assert.equal(await queuedSkip, false);
	assert.equal(harness.sessionController.current(harness.playerId)?.track?.id, "track-a");
	assert.deepEqual(harness.queue.getTracks().map((track) => track.id), ["track-b"]);
	await harness.orchestrator.dispose();
	harness.player.destroy();
});
