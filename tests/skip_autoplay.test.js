const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerBus, PlaybackOrchestrator, QueueController } = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createOrchestrator = ({ autoPlay, related } = {}) => {
	const bus = new PlayerBus();
	const queueController = new QueueController({ bus });
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
		relatedTrackResolver: async () => related,
	});
	return { bus, queueController, orchestrator, played };
};

const context = () => ({
	requestId: "test-request",
	signal: new AbortController().signal,
	priority: 10,
});

test("manual SKIP should also trigger autoplay fallback like natural TRACK_END", async () => {
	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };
	const harness = createOrchestrator({ autoPlay: true, related: [trackB] });

	await harness.orchestrator.start(trackA, context());
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(harness.queueController.relatedTracks, [trackB]);

	await harness.bus.action({ type: "SKIP" }, context());

	await waitFor(() => harness.orchestrator.currentSession?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], "autoplay should have started track-b after manual skip");
	harness.orchestrator.dispose();
	harness.queueController.dispose();
});