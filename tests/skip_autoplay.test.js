const test = require("node:test");
const assert = require("node:assert/strict");

const { Bus, PlaybackOrchestrator, createPlaybackOrchestrator, QueueController, PlaybackSessionController } = require("../core/dist");

const waitFor = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const createOrchestrator = ({ autoPlay, related } = {}) => {
	const playerId = "test-guild";
	const globalBus = new Bus();
	const queueController = new QueueController(globalBus);
	const queue = queueController.attach(playerId);
	const sessionController = new PlaybackSessionController(globalBus);
	sessionController.attach(playerId);
	const played = [];
	const trackLoader = {
		loadWithRecovery: async (track) => ({ track, stream: { stream: null, remote: false } }),
	};
	globalBus.registerQuery("filterString", () => "");
	globalBus.registerQuery("transitionSettings", () => ({ enabled: false, durationMs: 0 }));
	globalBus.registerQuery("ttsInterrupt", () => false);
	globalBus.registerQuery("previousTracks", () => []);
	globalBus.registerRpc("resource.create", () => ({}));
	globalBus.registerRpc("preload.has", () => false);
	globalBus.registerRpc("preload.cancel", () => {});
	globalBus.registerRpc("controller.stream.replace", ({ streamInfo }) => ({
		stream: streamInfo.stream,
		inputType: streamInfo.inputType,
	}));
	globalBus.registerRpc("controller.track.loadWithRecovery", trackLoader.loadWithRecovery);
	globalBus.registerRpc("controller.track.resetRecovery", () => {});
	globalBus.registerRpc("controller.transition.plan", () => ({
		enabled: false,
		durationMs: 0,
		waitForBeat: false,
		beatAlignMaxWaitMs: 0,
	}));
	globalBus.registerRpc("controller.volume.target", () => 1);
	globalBus.registerRpc("controller.playback.play", ({ session }) => {
		played.push(session.track.id);
	});
	globalBus.registerRpc("controller.playback.stop", () => {});
	globalBus.registerRpc("plugin.relatedTracks", async () => related ?? []);
	globalBus.onInput("[Player]->[Preload]:request", (event) => {
		globalBus.emitOutput({
			type: "[Preload]->[Player]:ready",
			requestId: event.requestId,
			track: event.track,
			playerId: event.playerId,
		});
	});
	queue.setAutoPlay(autoPlay);
	const orchestrator = createPlaybackOrchestrator(globalBus, { sessionController });
	orchestrator.attach(playerId);
	return { bus: globalBus, playerId, queue, orchestrator, played };
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

	await harness.bus.action(harness.playerId, { type: "PLAY", track: trackA }, context());
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(harness.queue.relatedTracks, [trackB]);

	await harness.bus.action(harness.playerId, { type: "SKIP" }, context());

	await waitFor(() => harness.played.length === 2 && harness.orchestrator.currentSession?.track === trackB);

	assert.deepEqual(harness.played, ["track-a", "track-b"], "autoplay should have started track-b after manual skip");
	harness.orchestrator.dispose();
	harness.queue.dispose();
});
