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
	PlayerEventBridge,
	PlayerEventDebug,
} = require("../core/dist");

const waitFor = async (predicate, timeoutMs = 1000) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createHarness = ({ autoPlay = false, loopMode = "off", relatedMock = [] } = {}) => {
	const playerId = "test-guild-related-willplay";
	const bus = new Bus();
	const queueController = new QueueController(bus);
	const queue = queueController.attach(playerId);
	const sessionController = new PlaybackSessionController(bus);
	sessionController.attach(playerId);

	const played = [];
	let sourcePassedToRelated = null;

	bus.registerQuery("filterString", () => "");
	bus.registerQuery("transitionSettings", () => ({ enabled: false, durationMs: 0 }));
	bus.registerQuery("ttsInterrupt", () => false);
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
		played.push(session.track);
	});
	bus.registerRpc("controller.playback.stop", () => {});
	bus.registerRpc("plugin.relatedTracks", async ({ track }) => {
		sourcePassedToRelated = track;
		return typeof relatedMock === "function" ? relatedMock(track) : relatedMock;
	});
	bus.onInput(BUS_REQUEST.preloadRequest, (event) => {
		bus.emitOutput({
			type: BUS_OUTPUT.preloadReady,
			requestId: event.requestId,
			track: event.track,
			playerId: event.playerId,
		});
	});

	queue.setAutoPlay(autoPlay);
	queue.setLoop(loopMode);

	const orchestrator = createPlaybackOrchestrator(bus, { sessionController });
	orchestrator.attach(playerId);

	const eventBridge = new PlayerEventBridge(bus);
	eventBridge.attach(playerId, new PlayerEventDebug());

	const player = new Player(playerId, bus);
	eventBridge.attachPlayer(playerId, player);

	return {
		bus,
		playerId,
		queue,
		orchestrator,
		sessionController,
		played,
		player,
		getSourcePassedToRelated: () => sourcePassedToRelated,
	};
};

test("Queue has next: candidate is queue.next, willPlay emitted and track starts", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createHarness({ autoPlay: false });

	const willPlayEvents = [];
	harness.player.on("willPlay", (track, relatedTracks) => {
		willPlayEvents.push({ track, relatedTracks });
	});

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});
	harness.queue.add(trackB);

	// End track A
	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });

	await waitFor(() => harness.played.some((t) => t.id === "track-b"));

	assert.equal(willPlayEvents.length >= 1, true);
	const lastWillPlay = willPlayEvents.at(-1);
	assert.equal(lastWillPlay.track.id, "track-b", "willPlay candidate must be queue.next");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Queue empty + autoPlay=false: generates related, emits willPlay, sets willNext, but stops playback", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const relatedTrack = { id: "track-rel-1", title: "Related 1", duration: 200000 };

	const harness = createHarness({
		autoPlay: false,
		relatedMock: [relatedTrack],
	});

	const willPlayEvents = [];
	let queueEndEmitted = false;

	harness.player.on("willPlay", (track, relatedTracks) => {
		willPlayEvents.push({ track, relatedTracks });
	});
	harness.player.on("queueEnd", () => {
		queueEndEmitted = true;
	});

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});

	// Queue is empty. Trigger trackEnd
	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });

	await waitFor(() => queueEndEmitted);

	// Assert willNext was calculated
	const willNext = harness.player.generateWillNext();
	assert.ok(willNext);
	assert.equal(willNext.id, "track-rel-1", "willNext must be calculated even when autoPlay=false");

	// Assert willPlay was emitted with the candidate and relatedTracks
	assert.ok(willPlayEvents.length >= 1);
	const lastEvent = willPlayEvents.at(-1);
	assert.equal(lastEvent.track.id, "track-rel-1");
	assert.deepEqual(lastEvent.relatedTracks.map((t) => t.id), ["track-rel-1"]);

	// Assert relatedTracks were generated on player
	assert.equal(harness.player.relatedTracks.length, 1);
	assert.equal(harness.player.relatedTracks[0].id, "track-rel-1");

	// Assert playback stopped (did NOT start relatedTrack)
	assert.equal(harness.played.some((t) => t.id === "track-rel-1"), false, "Must not auto-play when autoPlay=false");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Queue empty + autoPlay=true: generates related, emits willPlay, and starts candidate track", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const relatedTrack = { id: "track-rel-auto", title: "Related Auto", duration: 200000 };

	const harness = createHarness({
		autoPlay: true,
		relatedMock: [relatedTrack],
	});

	const willPlayEvents = [];
	harness.player.on("willPlay", (track, relatedTracks) => {
		willPlayEvents.push({ track, relatedTracks });
	});

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});

	// Queue is empty. Trigger trackEnd
	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });

	await waitFor(() => harness.played.some((t) => t.id === "track-rel-auto"));

	assert.ok(willPlayEvents.length >= 1);
	assert.equal(willPlayEvents.at(-1).track.id, "track-rel-auto");
	assert.ok(harness.played.some((t) => t.id === "track-rel-auto"), "Candidate must be started when autoPlay=true");
	assert.deepEqual(harness.queue.getTracks(), [], "Related autoplay must not add the candidate to the queue");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Loop mode track repeats the current track as candidate", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const harness = createHarness({ loopMode: "track" });

	const willPlayEvents = [];
	harness.player.on("willPlay", (track) => {
		willPlayEvents.push(track);
	});

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});

	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });

	await waitFor(() => harness.played.length >= 2);

	assert.equal(willPlayEvents.at(-1).id, "track-a", "Candidate must be currentTrack when loop=track");
	assert.equal(harness.played.at(-1).id, "track-a");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Loop mode queue exposes and plays the oldest history entry", async () => {
	const trackA = { id: "track-loop-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-loop-b", title: "Track B", duration: 180000 };
	const trackC = { id: "track-loop-c", title: "Track C", duration: 180000 };
	const harness = createHarness({ loopMode: "queue" });
	harness.queue.addMultiple([trackA, trackB, trackC]);
	harness.queue.next();
	harness.queue.next();
	harness.queue.next();

	const willPlayEvents = [];
	harness.player.on("willPlay", (track) => willPlayEvents.push(track));
	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackC }, {
		requestId: "req-loop-queue",
		signal: new AbortController().signal,
		priority: 10,
	});

	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });
	await waitFor(() => harness.played.some((track) => track.id === "track-loop-a"));

	assert.equal(willPlayEvents.at(-1).id, "track-loop-a");
	assert.equal(harness.played.at(-1).id, "track-loop-a");
	await harness.orchestrator.dispose();
	harness.player.destroy();
});

test("Related source uses ended track as source for related generation", async () => {
	const trackA = { id: "track-source-ended", title: "Ended Track", duration: 180000 };
	const relatedTrack = { id: "track-from-ended", title: "Related from Ended", duration: 180000 };

	const harness = createHarness({
		autoPlay: false,
		relatedMock: [relatedTrack],
	});

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, {
		requestId: "req-1",
		signal: new AbortController().signal,
		priority: 10,
	});

	const session = harness.sessionController.current(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: session.snapshot() });

	await waitFor(() => harness.getSourcePassedToRelated() !== null);
	assert.equal(harness.getSourcePassedToRelated().id, "track-source-ended", "Source for related tracks must be the ended track");

	await harness.orchestrator.dispose();
	harness.player.destroy();
});
