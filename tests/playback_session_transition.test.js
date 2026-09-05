const test = require("node:test");
const assert = require("node:assert/strict");

const { Player, PlayerBus, PlaybackOrchestrator, PlaybackSession, Queue, QueueController } = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createOrchestrator = ({ autoPlay, related, relatedResolver }) => {
	const bus = new PlayerBus();
	const queueController = new QueueController({ queue: new Queue(), bus });
	const played = [];
	const trackLoader = {
		loadWithRecovery: async (track) => ({ track, stream: { stream: null, remote: false } }),
		resetRecovery: () => {},
		cancelPreload: () => {},
	};
	const playbackController = {
		play: (_resource, session) => played.push(session.track.id),
		stop: () => {},
	};
	bus.registerQuery("filterString", () => "");
	bus.registerRpc("resource.create", () => ({}));
	queueController.setAutoPlay(autoPlay);
	const orchestrator = new PlaybackOrchestrator(bus, {
		queueController,
		trackLoader,
		playbackController,
		relatedTrackResolver: relatedResolver ?? (async () => related),
	});
	return { bus, queueController, orchestrator, played };
};

const context = () => ({
	requestId: "test-request",
	signal: new AbortController().signal,
	priority: 10,
});

test("autoplay starts the related track after TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await harness.orchestrator.start(trackA, context());
	const endedSession = harness.orchestrator.currentSession;
	harness.bus.event({ type: "TRACK_END", session: endedSession.snapshot() });
	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"]);
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});

test("the next session keeps a valid signal after the ended session is destroyed", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await harness.orchestrator.start(trackA, context());
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

	await harness.orchestrator.start(trackA, context());
	assert.equal(resolveCount, 1);
	assert.deepEqual(harness.queueController.relatedTracks, [trackB]);
	assert.equal(harness.queueController.willNext, null);

	harness.bus.event({ type: "TRACK_END", session: harness.orchestrator.currentSession.snapshot() });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.orchestrator.currentSession.track, trackA);
	harness.orchestrator.dispose();
	harness.queueController.dispose();
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
