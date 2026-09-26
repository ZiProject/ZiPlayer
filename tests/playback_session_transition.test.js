const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const {
	Player,
	Bus,
	PlaybackOrchestrator,
	createPlaybackOrchestrator,
	PlaybackSession,
	QueueController,
	PlaybackSessionController,
	TrackLoader,
	BUS_REQUEST,
	BUS_OUTPUT,
} = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createOrchestrator = ({ autoPlay, related, relatedResolver, loop = "off", preloadController } = {}) => {
	const playerId = "test-guild";
	const globalBus = new Bus();
	const queueController = new QueueController(globalBus);
	const queue = queueController.attach(playerId);
	const sessionController = new PlaybackSessionController(globalBus);
	sessionController.attach(playerId);
	const played = [];
	const errors = [];
	const trackLoader = new TrackLoader(globalBus);
	trackLoader.attach(playerId, {
		context: {},
		resolvers: [async (track) => ({ stream: new Readable({ read() {} }), type: "arbitrary" })],
	});
	globalBus.registerQuery("filterString", () => "");
	globalBus.registerRpc("preload.has", ({ track }) => Boolean(preloadController?.has?.(playerId, track)));
	globalBus.registerRpc("preload.cancel", () => undefined);
	globalBus.registerRpc("resource.create", ({ stream, track }) => ({ stream, metadata: track }));
	globalBus.registerRpc("controller.stream.replace", ({ streamInfo, session }) => ({
		sessionId: session.id,
		session,
		track: session.track,
		stream: streamInfo.stream,
		streamId: null,
		inputType: streamInfo.inputType,
	}));
	globalBus.registerRpc("controller.playback.stop", () => true);
	globalBus.registerRpc("controller.track.resetRecovery", () => undefined);
	globalBus.registerRpc("controller.playback.play", ({ session }) => {
		played.push(session.track.id);
		return undefined;
	});
	globalBus.registerRpc("plugin.relatedTracks", relatedResolver ?? (async () => related ?? []));
	globalBus.subscribe(playerId, "TRACK_ERROR", (event) => errors.push(event.error?.message ?? String(event.error)));
	globalBus.onInput(BUS_REQUEST.preloadRequest, (event) => {
		globalBus.emitOutput({
			type: BUS_OUTPUT.preloadReady,
			requestId: event.requestId,
			track: event.track,
			playerId: event.playerId,
		});
	});
	queue.setAutoPlay(autoPlay);
	queue.setLoop(loop);
	const orchestrator = createPlaybackOrchestrator(globalBus, { sessionController });
	orchestrator.attach(playerId);
	return { bus: globalBus, playerId, queueController: queue, orchestrator, played, errors, trackLoader };
};

const context = () => ({
	requestId: "test-request",
	signal: new AbortController().signal,
	priority: 10,
});

const play = (harness, track) => harness.bus.action(harness.playerId, { type: "PLAY", track }, context());

test("autoplay starts the related track after TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await play(harness, trackA);
	const endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("the next session keeps a valid signal after the ended session is destroyed", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await play(harness, trackA);
	const endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.track === trackB);

	const nextSession = harness.orchestrator.getCurrentSession(harness.playerId);
	assert.equal(endedSession.signal.aborted, true);
	assert.equal(nextSession.signal.aborted, false);
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("related tracks resolve without setting willNext when autoplay is disabled", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	let resolveCount = 0;
	const harness = createOrchestrator({
		autoPlay: false,
		related: [trackB],
		relatedResolver: async () => {
			resolveCount++;
			return [trackB];
		},
	});

	await play(harness, trackA);
	assert.equal(resolveCount, 1);
	assert.deepEqual(harness.queueController.relatedTracks, [trackB]);
	assert.equal(harness.queueController.willNext, null);

	harness.bus.event(harness.playerId, {
		type: "TRACK_END",
		session: harness.orchestrator.getCurrentSession(harness.playerId).snapshot(),
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.orchestrator.getCurrentSession(harness.playerId).track, trackA);
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop off advances to the queued track after TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator();

	await play(harness, trackA);
	harness.queueController.add(trackB);
	const endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop track repeats the current track without retaining an autoplay hint", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB], loop: "track" });

	await play(harness, trackA);
	assert.equal(harness.queueController.willNext, null);
	const endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.id !== endedSession.id);

	assert.equal(harness.orchestrator.getCurrentSession(harness.playerId).track, trackA);
	assert.equal(harness.queueController.willNext, null);
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop queue cycles back to the first track after the queue ends", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ loop: "queue" });

	await play(harness, trackA);
	harness.queueController.add(trackB);
	let endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.track === trackB);

	endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.getCurrentSession(harness.playerId)?.track === trackA);

	assert.deepEqual(harness.played, ["track-a", "track-b", "track-a"]);
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("Bus PLAY starts a replacement track without legacy orchestrator arguments", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator();

	await play(harness, trackA);
	await play(harness, trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("Player.play resolves true when the next session is not materialized yet", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator();
	const player = Object.create(Player.prototype);
	player.bus = harness.bus;
	player.playerId = harness.playerId;
	player.playOperation = Promise.resolve(false);
	player.playGeneration = 0;
	player.playAbortController = null;
	player.action = async () => {};

	await player.play(trackA);
	const endedSession = harness.orchestrator.getCurrentSession(harness.playerId);
	assert.ok(endedSession);
	harness.bus.event(harness.playerId, { type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(
		() =>
			!harness.orchestrator.getCurrentSession(harness.playerId) ||
			harness.orchestrator.getCurrentSession(harness.playerId)?.status === "ended",
	);

	const result = await player.play(trackB);
	assert.equal(result, true);
	await waitFor(() => harness.played.at(-1) === "track-b");
	assert.deepEqual(harness.played.slice(-1), ["track-b"], harness.errors.join("; "));
	await harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("TrackLoader promotes the existing preloaded stream instead of resolving again", async () => {
	const track = { id: "track-preloaded", title: "Preloaded", duration: 180000 };
	const preloadedStream = { name: "preloaded-stream" };
	let takeCount = 0;
	const loader = new TrackLoader(undefined, {
		takePreloaded: (playerId, requestedTrack) => {
			assert.equal(playerId, "test-guild");
			assert.equal(requestedTrack, track);
			takeCount++;
			return { track, stream: preloadedStream };
		},
	});
	loader.attach("test-guild", {
		context: {},
		resolvers: [
			() => {
				throw new Error("stream resolver should not run");
			},
		],
	});
	const session = new PlaybackSession();
	session.begin(track);

	const loaded = await loader.loadWithRecovery("test-guild", track, session);
	assert.equal(takeCount, 1);
	assert.equal(loaded.stream.stream, preloadedStream);
});

test("TrackLoader rejects new loads after dispose", async () => {
	const loader = new TrackLoader();
	loader.attach("test-guild", { context: {}, resolvers: [] });
	loader.dispose();

	await assert.rejects(() => loader.load("test-guild", { id: "disposed-track", title: "Disposed" }, new PlaybackSession()), {
		message: "TrackLoader is disposed",
	});
});

test("Player.getTime follows the active session across track transitions and seek", () => {
	const bus = new Bus();
	const guildId = "test-guild";
	let activeSession = new PlaybackSession();
	const track1 = { id: "track-1", title: "Track 1", duration: 180000 };
	const track2 = { id: "track-2", title: "Track 2", duration: 240000 };

	bus.registerQuery("playbackSession", () => activeSession.snapshot());
	bus.registerQuery("position", () => activeSession.position);
	bus.registerQuery("currentTrack", () => activeSession.track);

	activeSession.begin(track1);
	activeSession.markPlaying();
	activeSession.updatePosition(12000);
	const player = Object.create(Player.prototype);
	player.bus = bus;
	player.guildId = guildId;
	assert.equal(player.getTime().current, 12000);

	activeSession = new PlaybackSession();
	activeSession.begin(track2);
	activeSession.markPlaying();
	assert.equal(activeSession.position, 0);
	assert.equal(player.getTime().current, 0);

	activeSession.updatePosition(42000);
	assert.equal(player.getTime().current, 42000);
});

test("stop invalidates an in-flight play RPC", async () => {
	const bus = new Bus();
	const guildId = "test-guild";
	bus.registerRpc("play", async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		return true;
	});
	const player = Object.create(Player.prototype);
	player.bus = bus;
	player.guildId = guildId;
	player.playOperation = Promise.resolve(false);
	player.playGeneration = 0;
	player.playAbortController = null;
	player.action = async () => {};

	const playResult = player.play({
		id: "track-a",
		title: "Track A",
		url: "url",
		duration: 1000,
		requestedBy: "test",
		source: "test",
	});
	await new Promise((resolve) => setTimeout(resolve, 2));
	player.stop();

	assert.equal(await playResult, false);
	bus.disposePlayer(guildId);
});

test("Bus materializes seek and queueEnd public events", () => {
	const bus = new Bus();
	const guildId = "test-guild";
	const events = [];
	bus.subscribe(guildId, "seek", (event) => events.push(event));
	bus.subscribe(guildId, "queueEnd", (event) => events.push(event));
	const track = { id: "track-a", title: "Track A", url: "url", duration: 1000, requestedBy: "test", source: "test" };

	bus.event(guildId, { type: "seek", track, position: 250 });
	bus.event(guildId, { type: "queueEnd" });

	assert.equal(events[0].track, track);
	assert.equal(events[0].position, 250);
	assert.equal(events[1].type, "queueEnd");
	bus.disposePlayer(guildId);
});

test("PreloadManager manages StreamInfo directly without AudioResource and preserves stream metadata on promotion", async () => {
	const { PreloadManager, StreamManager } = require("../core/dist");
	const { Readable } = require("stream");

	const streamManager = new StreamManager();
	const trackB = { id: "track-b", title: "Track B", duration: 200000 };
	const sourceStream = new Readable({ read() {} });

	let streamRequested = false;
	const preloadManager = new PreloadManager();
	preloadManager.attach("test-guild", {
		streamManager,
		debug: () => {},
		getNextTrack: () => trackB,
		getStream: async () => {
			streamRequested = true;
			return { stream: sourceStream, type: "webm/opus", inputType: 1 };
		},
		isDestroyed: () => false,
		isEnabled: () => true,
	});

	await preloadManager.preloadNextTrack("test-guild");
	assert.ok(streamRequested);
	assert.ok(preloadManager.hasValidPreload("test-guild", trackB));

	// Preloaded stream should NOT be in flowing mode (not drained by StreamManager data counter)
	assert.notEqual(sourceStream.readableFlowing, true);

	// Promote preloaded track
	const promoted = preloadManager.takePreloaded("test-guild", trackB);
	assert.ok(promoted);
	assert.equal(promoted.track, trackB);
	assert.equal(promoted.stream, sourceStream);
	assert.equal(promoted.streamInfo?.type, "webm/opus");
	assert.equal(promoted.streamInfo?.inputType, 1);

	// Preload slot should now be empty and not valid
	assert.equal(preloadManager.hasValidPreload("test-guild", trackB), false);

	preloadManager.dispose();
	streamManager.dispose();
});
