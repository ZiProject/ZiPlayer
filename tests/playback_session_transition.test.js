const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { Player, PlayerBus, PlaybackOrchestrator, PlaybackSession, QueueController, TrackLoader } = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createOrchestrator = ({ autoPlay, related, relatedResolver, loop = "off", preloadController } = {}) => {
	const bus = new PlayerBus();
	const queueController = new QueueController({ bus });
	const played = [];
	const errors = [];
	const trackLoader = new TrackLoader({
		context: {},
		bus,
		resolvers: [async (track) => ({ stream: new Readable({ read() {} }), type: "arbitrary" })],
	});
	bus.registerQuery("filterString", () => "");
	bus.registerRpc("preload.has", ({ track }) => Boolean(preloadController?.has?.(track)));
	bus.registerRpc("preload.cancel", () => undefined);
	bus.registerRpc("resource.create", ({ stream, track }) => ({ stream, metadata: track }));
	bus.registerRpc("controller.stream.replace", ({ streamInfo, session }) => ({
		sessionId: session.id,
		session,
		track: session.track,
		stream: streamInfo.stream,
		streamId: null,
		inputType: streamInfo.inputType,
	}));
	bus.registerRpc("controller.playback.stop", () => true);
	bus.registerRpc("controller.track.resetRecovery", () => undefined);
	bus.registerRpc("controller.playback.play", ({ session }) => {
		played.push(session.track.id);
		return undefined;
	});
	bus.registerRpc("plugin.relatedTracks", relatedResolver ?? (async () => related ?? []));
	bus.subscribe("TRACK_ERROR", (event) => errors.push(event.error?.message ?? String(event.error)));
	bus.onInput("[Player]->[Preload]:request", (event) => {
		bus.emitOutput({ type: "[Preload]->[Player]:ready", requestId: event.requestId, track: event.track });
	});
	queueController.setAutoPlay(autoPlay);
	queueController.setLoop(loop);
	const orchestrator = new PlaybackOrchestrator(bus);
	return { bus, queueController, orchestrator, played, errors, trackLoader };
};

const context = () => ({
	requestId: "test-request",
	signal: new AbortController().signal,
	priority: 10,
});

const play = (harness, track) => harness.bus.action({ type: "PLAY", track }, context());

test("autoplay starts the related track after TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await play(harness, trackA);
	const endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("the next session keeps a valid signal after the ended session is destroyed", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await play(harness, trackA);
	const endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	const nextSession = harness.orchestrator.currentSession;
	assert.equal(endedSession.signal.aborted, true);
	assert.equal(nextSession.signal.aborted, false);
	harness.orchestrator.dispose();
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

	harness.bus.event({ type: "TRACK_END", session: harness.orchestrator.currentSession.snapshot() });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.orchestrator.currentSession.track, trackA);
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop off advances to the queued track after TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator();

	await play(harness, trackA);
	harness.queueController.add(trackB);
	const endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop track repeats the current track without retaining an autoplay hint", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB], loop: "track" });

	await play(harness, trackA);
	assert.equal(harness.queueController.willNext, null);
	const endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.id !== endedSession.id);

	assert.equal(harness.orchestrator.currentSession.track, trackA);
	assert.equal(harness.queueController.willNext, null);
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("loop queue cycles back to the first track after the queue ends", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ loop: "queue" });

	await play(harness, trackA);
	harness.queueController.add(trackB);
	let endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackA);

	assert.deepEqual(harness.played, ["track-a", "track-b", "track-a"]);
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("Bus PLAY starts a replacement track without legacy orchestrator arguments", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator();

	await play(harness, trackA);
	await play(harness, trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], harness.errors.join("; "));
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("TrackLoader promotes the existing preloaded stream instead of resolving again", async () => {
	const track = { id: "track-preloaded", title: "Preloaded", duration: 180000 };
	const preloadedStream = { name: "preloaded-stream" };
	let takeCount = 0;
	const loader = new TrackLoader({
		context: {},
		preloadManager: {
			takePreloaded: (requestedTrack) => {
				assert.equal(requestedTrack, track);
				takeCount++;
				return { track, stream: preloadedStream };
			},
		},
		resolvers: [
			() => {
				throw new Error("stream resolver should not run");
			},
		],
	});
	const session = new PlaybackSession();
	session.begin(track);

	const loaded = await loader.loadWithRecovery(track, session);
	assert.equal(takeCount, 1);
	assert.equal(loaded.stream.stream, preloadedStream);
});

test("TrackLoader rejects new loads after dispose", async () => {
	const loader = new TrackLoader({ context: {}, resolvers: [] });
	loader.dispose();

	await assert.rejects(() => loader.load({ id: "disposed-track", title: "Disposed" }, new PlaybackSession()), {
		message: "TrackLoader is disposed",
	});
});

test("Player.getTime follows the active session across track transitions and seek", () => {
	const bus = new PlayerBus();
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
	const bus = new PlayerBus();
	bus.registerRpc("play", async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		return true;
	});
	const player = Object.create(Player.prototype);
	player.bus = bus;
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
	bus.dispose();
});

test("PlayerBus materializes seek and queueEnd public events", () => {
	const bus = new PlayerBus();
	const events = [];
	bus.subscribe("seek", (event) => events.push(event));
	bus.subscribe("queueEnd", (event) => events.push(event));
	const track = { id: "track-a", title: "Track A", url: "url", duration: 1000, requestedBy: "test", source: "test" };

	bus.event({ type: "seek", track, position: 250 });
	bus.event({ type: "queueEnd" });

	assert.equal(events[0].track, track);
	assert.equal(events[0].position, 250);
	assert.equal(events[1].type, "queueEnd");
	bus.dispose();
});

test("PreloadManager manages StreamInfo directly without AudioResource and preserves stream metadata on promotion", async () => {
	const { PreloadManager, StreamManager } = require("../core/dist");
	const { Readable } = require("stream");

	const streamManager = new StreamManager();
	const trackB = { id: "track-b", title: "Track B", duration: 200000 };
	const sourceStream = new Readable({ read() {} });

	let streamRequested = false;
	const preloadManager = new PreloadManager({
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

	await preloadManager.preloadNextTrack();
	assert.ok(streamRequested);
	assert.ok(preloadManager.hasValidPreload(trackB));

	// Preloaded stream should NOT be in flowing mode (not drained by StreamManager data counter)
	assert.notEqual(sourceStream.readableFlowing, true);

	// Promote preloaded track
	const promoted = preloadManager.takePreloaded(trackB);
	assert.ok(promoted);
	assert.equal(promoted.track, trackB);
	assert.equal(promoted.stream, sourceStream);
	assert.equal(promoted.streamInfo?.type, "webm/opus");
	assert.equal(promoted.streamInfo?.inputType, 1);

	// Preload slot should now be empty and not valid
	assert.equal(preloadManager.hasValidPreload(trackB), false);

	preloadManager.dispose();
	streamManager.dispose();
});
