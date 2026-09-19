const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const {
	ConnectionController,
	PlaybackOrchestrator,
	PlaybackController,
	StreamController,
	StreamWorker,
	TrackLoader,
	PlayerBus,
	GlobalPlayerBus,
	PlaybackSession,
	PlaybackSessionController,
	QueueController,
	VolumeController,
	TransitionController,
	SaveController,
	SaveWorker,
} = require("../core/dist");

const createContext = () => ({
	requestId: "test-req",
	signal: new AbortController().signal,
	priority: 10,
});

test("ConnectionController ensures subscription on Ready and cleans up on Destroyed", () => {
	const globalBus = new GlobalPlayerBus();
	const bus = new PlayerBus(globalBus, "g-test");
	const mockAudioPlayer = {};
	const controller = new ConnectionController({
		guildId: "g-test",
		bus,
		audioPlayer: mockAudioPlayer,
	});

	let subscribedPlayer = null;
	const mockConnection = Object.assign(new EventEmitter(), {
		state: { status: "ready" },
		subscribe(player) {
			subscribedPlayer = player;
			const sub = {
				connection: mockConnection,
				player,
				unsubscribed: false,
				unsubscribe() {
					this.unsubscribed = true;
					mockConnection.state.subscription = undefined;
				},
			};
			mockConnection.state.subscription = sub;
			return sub;
		},
	});

	const sub = controller.ensureSubscription(mockConnection);
	assert.ok(sub);
	assert.equal(subscribedPlayer, mockAudioPlayer);

	// When subscription is active, ensureSubscription returns existing subscription
	const sub2 = controller.ensureSubscription(mockConnection);
	assert.equal(sub2, sub);

	// Cleaning up subscription unsubscribes
	controller.cleanupSubscription();
	assert.equal(sub.unsubscribed, true);
	assert.equal(controller.activeSubscription, null);

	bus.dispose();
});

test("Bus PLAY replaces the previous stream through StreamController", async () => {
	const playerId = "g-stream-test";
	const globalBus = new GlobalPlayerBus();
	const queueController = new QueueController(globalBus);
	queueController.attach(playerId);
	const streamController = new StreamController(globalBus);
	streamController.attach(playerId);
	const sessionController = new PlaybackSessionController(globalBus);
	sessionController.attach(playerId);
	const bus = new PlayerBus(globalBus, playerId);

	const trackA = { id: "track-a", title: "Track A", duration: 180000 };
	const trackB = { id: "track-b", title: "Track B", duration: 180000 };

	const streamA = new Readable({ read() {} });
	const streamB = new Readable({ read() {} });

	const trackLoader = new TrackLoader({
		context: {},
		bus,
		playerId,
		resolvers: [async (track) => ({ stream: track.id === "track-a" ? streamA : streamB, type: "arbitrary" })],
	});

	let playedArgs = null;
	globalBus.registerQuery("filterString", () => "");
	globalBus.registerRpc("resource.create", ({ stream, track }) => ({ stream, metadata: track }));
	globalBus.registerRpc("preload.has", () => false);
	globalBus.registerRpc("preload.cancel", () => undefined);
	globalBus.registerRpc("controller.playback.stop", () => true);
	globalBus.registerRpc("controller.playback.play", ({ resource, session, from, to }) => {
		playedArgs = { resource, session, from, to };
		return undefined;
	});
	globalBus.registerRpc("plugin.relatedTracks", () => []);
	const orchestrator = new PlaybackOrchestrator(playerId, bus, { sessionController });

	// Start track A
	await bus.action({ type: "PLAY", track: trackA }, createContext());
	assert.equal(bus.querySync("stream.current")?.track.id, "track-a");
	assert.equal(playedArgs.to.id, "track-a");
	assert.equal(playedArgs.from, null);

	// Start track B through the public Bus action
	await bus.action({ type: "PLAY", track: trackB }, createContext());
	assert.equal(bus.querySync("stream.current")?.track.id, "track-b");
	assert.equal(playedArgs.to.id, "track-b");

	// Stream A should have been destroyed by streamController.replace -> abortCurrent
	assert.equal(streamA.destroyed, true);

	orchestrator.dispose();
	streamController.detach(playerId);
	trackLoader.dispose();
	queueController.detach(playerId);
});

test("PlaybackController.cancelFade restores resource volume to 100% when active", () => {
	const playerId = "g-cancelfade-test";
	const globalBus = new GlobalPlayerBus();
	const bus = new PlayerBus(globalBus, playerId);
	const mockAudioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		pause() {
			return true;
		},
		unpause() {
			return true;
		},
		stop() {
			return true;
		},
	});

	const volumeController = new VolumeController(globalBus);
	volumeController.attach(playerId, { initialVolume: 100 });
	const playbackController = new PlaybackController(playerId, {
		audioPlayer: mockAudioPlayer,
		bus,
	});

	let currentVolume = 0;
	const mockResource = {
		metadata: { id: "track-1", title: "Track 1" },
		volume: {
			volume: 0,
			setVolume(v) {
				currentVolume = v;
				this.volume = v;
			},
		},
	};

	playbackController.activeResource = mockResource;
	// Simulate fade in progress
	playbackController.fadeGain = 0;
	mockResource.volume.setVolume(0);

	// cancelFade should reset fadeGain and restore volume to 1.0 (100% volume / 100 = 1)
	playbackController.cancelFade();

	assert.equal(playbackController.fadeGain, null);
	assert.equal(currentVolume, 1);

	playbackController.dispose();
	volumeController.detach(playerId);
});

test("PlaybackController aborts an in-flight fade during dispose", async () => {
	const playerId = "g-fade-abort-test";
	const globalBus = new GlobalPlayerBus();
	const bus = new PlayerBus(globalBus, playerId);
	const mockAudioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		stop() {
			return true;
		},
	});
	const playbackController = new PlaybackController(playerId, { audioPlayer: mockAudioPlayer, bus });
	let volumeWrites = 0;
	const resource = {
		volume: {
			setVolume() {
				volumeWrites += 1;
			},
		},
	};

	const fade = playbackController.fadeResourceVolume(resource, 0, 1, 100);
	await new Promise((resolve) => setTimeout(resolve, 5));
	playbackController.dispose();
	const writesAtDispose = volumeWrites;
	await fade;
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.equal(volumeWrites, writesAtDispose);
});

test("SaveController aborts a pending resolver during dispose", async () => {
	const controller = new SaveWorker({
		middlewareContext: {},
		resolveStream: () => new Promise(() => {}),
		resolveVideoStream: async () => null,
	});
	const pending = controller.save({ id: "save-track", title: "Save track" });
	controller.dispose();

	await assert.rejects(pending, { name: "AbortError" });
});

test("StreamController.resolve follows fallback chain: stream -> url -> recreate -> throw", async () => {
	const streamController = new StreamWorker({});
	const session = new PlaybackSession();
	session.begin({ id: "t-1", title: "Track 1" });

	// 1. stream is present -> uses stream
	const directStream = new Readable({ read() {} });
	let recreateCalled = false;
	const resolvedDirect = await streamController.resolve(
		{
			stream: directStream,
			url: "https://example.com/audio.mp3",
			recreate: async () => {
				recreateCalled = true;
				return new Readable({ read() {} });
			},
			type: "arbitrary",
		},
		session,
	);
	assert.equal(resolvedDirect, directStream);
	assert.equal(recreateCalled, false);

	// 2. no stream, but valid local url -> resolves url
	const path = require("path");
	const testFilePath = path.resolve(__dirname, "audio_subscription_lifecycle.test.js");
	const resolvedUrl = await streamController.resolve(
		{
			url: testFilePath,
			type: "arbitrary",
		},
		session,
	);
	assert.ok(resolvedUrl instanceof Readable);
	resolvedUrl.destroy();

	// 3. no stream, invalid url, but recreate exists -> falls back to recreate
	let recreateUsed = false;
	const recreatedStream = new Readable({ read() {} });
	const resolvedRecreate = await streamController.resolve(
		{
			url: "https://invalid-non-existent-host-12345.com/audio.mp3",
			recreate: async () => {
				recreateUsed = true;
				return recreatedStream;
			},
			type: "arbitrary",
		},
		session,
	);
	assert.equal(recreateUsed, true);
	assert.equal(resolvedRecreate, recreatedStream);

	// 4. no stream, no url, no recreate -> throws
	await assert.rejects(
		async () => {
			await streamController.resolve({ type: "arbitrary" }, session);
		},
		{
			message: /StreamInfo does not contain a readable stream, url, or recreate factory/,
		},
	);

	session.destroy();
	streamController.dispose();
});
