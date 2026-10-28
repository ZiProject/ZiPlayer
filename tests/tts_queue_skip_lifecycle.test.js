"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { AudioPlayerStatus } = require("@discordjs/voice");
const {
	Bus,
	TTSController,
	PlaybackSkipController,
	CONTROLLER_RPC,
	PLAYER_QUERY,
	PLAYER_RPC,
	PLAYER_ACTION,
	BUS_EVENT,
} = require("../core/dist");

function createMockAudioPlayer() {
	const emitter = new EventEmitter();
	emitter.state = { status: AudioPlayerStatus.Idle };
	emitter.play = (resource) => {
		emitter.state = { status: AudioPlayerStatus.Playing, resource };
		emitter.emit("stateChange", { status: AudioPlayerStatus.Idle }, { status: AudioPlayerStatus.Playing, resource });
	};
	emitter.pause = () => {
		if (emitter.state.status === AudioPlayerStatus.Playing) {
			const old = emitter.state;
			emitter.state = { status: AudioPlayerStatus.Paused };
			emitter.emit("stateChange", old, emitter.state);
		}
		return true;
	};
	emitter.unpause = () => {
		if (emitter.state.status === AudioPlayerStatus.Paused) {
			const old = emitter.state;
			emitter.state = { status: AudioPlayerStatus.Playing };
			emitter.emit("stateChange", old, emitter.state);
		}
		return true;
	};
	emitter.stop = () => {
		const old = emitter.state;
		emitter.state = { status: AudioPlayerStatus.Idle };
		emitter.emit("stateChange", old, emitter.state);
		return true;
	};
	return emitter;
}

function createMockVoiceConnection() {
	return {
		state: { status: "ready" },
		subscribedPlayer: null,
		subscribe(player) {
			this.subscribedPlayer = player;
			return {
				player,
				connection: this,
				unsubscribe: () => {
					if (this.subscribedPlayer === player) this.subscribedPlayer = null;
				},
			};
		},
	};
}

function createMockPluginManager(customStreams = new Map()) {
	return {
		async getStream(track, { context } = {}) {
			if (customStreams.has(track.id)) {
				const handler = customStreams.get(track.id);
				return typeof handler === "function" ? handler(context?.signal) : handler;
			}
			const stream = new Readable({
				read() {
					this.push(Buffer.from([0x00, 0x01]));
					this.push(null);
				},
			});
			return { stream, remote: false };
		},
	};
}

function makeTtsTrack(id, title = `TTS ${id}`) {
	return {
		id: `tts-${id}`,
		title,
		source: "tts",
		duration: 1,
		metadata: { tts: { text: title } },
	};
}

test("TTS Controller enforces sequential FIFO queue execution A -> B -> C", async () => {
	const bus = new Bus();
	const playerId = "guild-tts-fifo";
	const ttsController = new TTSController(bus);
	const voiceConnection = createMockVoiceConnection();
	const musicAudioPlayer = createMockAudioPlayer();

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => null);

	const executedOrder = [];
	const deferreds = new Map();

	const customStreams = new Map();
	for (const id of ["A", "B", "C"]) {
		customStreams.set(`tts-${id}`, async () => {
			executedOrder.push(`start-${id}`);
			const stream = new Readable({ read() {} });
			const def = {};
			def.promise = new Promise((resolve) => {
				def.finish = () => {
					executedOrder.push(`end-${id}`);
					stream.push(null);
					resolve({ stream, remote: false });
				};
			});
			deferreds.set(id, def);
			def.finish();
			return { stream, remote: false };
		});
	}

	ttsController.attach(playerId, {
		audioPlayer: musicAudioPlayer,
		pluginManager: createMockPluginManager(customStreams),
		maxTimeTts: 10_000,
	});

	const trackA = makeTtsTrack("A");
	const trackB = makeTtsTrack("B");
	const trackC = makeTtsTrack("C");

	let settledA = false;
	let settledB = false;
	let settledC = false;

	const pA = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackA }).then(() => {
		settledA = true;
	});
	const pB = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackB }).then(() => {
		settledB = true;
	});
	const pC = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackC }).then(() => {
		settledC = true;
	});

	// B and C should not have settled yet when A is running
	assert.equal(settledB, false, "Request B must have its own promise and not resolve when accepted");
	assert.equal(settledC, false, "Request C must have its own promise and not resolve when accepted");

	// Wait for all to complete
	await Promise.all([pA, pB, pC]);

	assert.equal(settledA, true);
	assert.equal(settledB, true);
	assert.equal(settledC, true);

	assert.deepEqual(
		executedOrder,
		["start-A", "end-A", "start-B", "end-B", "start-C", "end-C"],
		"Requests must execute in strict sequential FIFO order: A -> B -> C",
	);

	ttsController.detach(playerId);
});

test("Skipping active TTS utterance advances to the next queued utterance", async () => {
	const bus = new Bus();
	const playerId = "guild-tts-skip-advance";
	const ttsController = new TTSController(bus);
	const voiceConnection = createMockVoiceConnection();
	const musicAudioPlayer = createMockAudioPlayer();

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => null);

	const started = [];
	const customStreams = new Map();
	for (const id of ["1", "2"]) {
		customStreams.set(`tts-${id}`, async () => {
			started.push(id);
			const stream = new Readable({ read() {} });
			return { stream, remote: false };
		});
	}

	ttsController.attach(playerId, {
		audioPlayer: musicAudioPlayer,
		pluginManager: createMockPluginManager(customStreams),
		maxTimeTts: 20_000,
	});

	const track1 = makeTtsTrack("1");
	const track2 = makeTtsTrack("2");

	let track1Error = null;
	const p1 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: track1 }).catch((err) => {
		track1Error = err;
	});
	const p2 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: track2 });

	// Wait until track 1 starts playing
	for (let i = 0; i < 50 && started.length === 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(started[0], "1");

	// Skip track 1
	const skipResult = await bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {});
	assert.equal(skipResult.skipped, true, "ttsSkip should return skipped: true");

	// p1 should reject with AbortError
	await p1;
	assert.ok(track1Error, "Skipped utterance must reject its promise");
	assert.equal(track1Error.name, "AbortError");

	// Wait until track 2 starts and completes
	for (let i = 0; i < 50 && started.length < 2; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(started[1], "2", "Next queued utterance 2 must start playing after skipping 1");

	// Now skip track 2 to finish cleanly
	await bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {});
	await p2.catch(() => {});

	ttsController.detach(playerId);
});

test("PlaybackSkipController skips TTS without skipping underlying music track", async () => {
	const bus = new Bus();
	const playerId = "guild-skip-ctrl-tts";
	const voiceConnection = createMockVoiceConnection();
	const musicAudioPlayer = createMockAudioPlayer();

	let musicTrackSkipped = false;
	const activeSession = {
		id: 1,
		sessionId: "music-session-1",
		track: { id: "song-1", title: "Playing Music Song" },
		isActive: () => true,
		snapshot: () => ({ id: 1, status: "playing" }),
		markEnded: () => {
			musicTrackSkipped = true;
		},
	};

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => activeSession);

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: musicAudioPlayer,
		pluginManager: createMockPluginManager(),
		maxTimeTts: 10_000,
	});

	const skipController = new PlaybackSkipController({
		bus,
		playerId,
		nextThroughBus: async () => ({ id: "song-2", title: "Next Music Track" }),
		stopPlayback: async () => {},
		publishState: () => {},
		setWaitingForQueue: () => {},
	});

	musicAudioPlayer.play({});
	assert.equal(musicAudioPlayer.state.status, AudioPlayerStatus.Playing);

	// Start TTS utterance
	const trackA = makeTtsTrack("A");
	const ttsPromise = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackA });

	// Wait for TTS to start and pause music
	for (let i = 0; i < 50 && musicAudioPlayer.state.status !== AudioPlayerStatus.Paused; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(musicAudioPlayer.state.status, AudioPlayerStatus.Paused, "Music player should be paused when TTS plays");

	// Call skip through PlaybackSkipController
	const context = { signal: new AbortController().signal };
	const skipSuccess = await skipController.skip(context);

	assert.equal(skipSuccess, true, "skip should return true");
	assert.equal(musicTrackSkipped, false, "Underlying music track must NOT be skipped when TTS is playing");

	await ttsPromise.catch(() => {});

	// Check that music playback is restored
	assert.equal(
		musicAudioPlayer.state.status,
		AudioPlayerStatus.Playing,
		"Underlying music must be unpaused after TTS utterance completes/is skipped",
	);

	ttsController.detach(playerId);
});

test("Skip during TTS preparation phase cleanly cancels preparation without falling back to music skip", async () => {
	const bus = new Bus();
	const playerId = "guild-skip-prepare";
	const voiceConnection = createMockVoiceConnection();
	const musicAudioPlayer = createMockAudioPlayer();

	let musicTrackSkipped = false;
	const activeSession = {
		id: 1,
		sessionId: "music-session-prepare",
		track: { id: "song-prep", title: "Song" },
		isActive: () => true,
		snapshot: () => ({ id: 1, status: "playing" }),
		markEnded: () => {
			musicTrackSkipped = true;
		},
	};

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => activeSession);

	let resolvePrepare;
	const customStreams = new Map();
	customStreams.set("tts-slow", () => {
		return new Promise((resolve) => {
			resolvePrepare = resolve;
		});
	});

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: musicAudioPlayer,
		pluginManager: createMockPluginManager(customStreams),
		maxTimeTts: 10_000,
	});

	const skipController = new PlaybackSkipController({
		bus,
		playerId,
		nextThroughBus: async () => ({ id: "song-next", title: "Next Song" }),
		stopPlayback: async () => {},
		publishState: () => {},
		setWaitingForQueue: () => {},
	});

	// Start preparing TTS
	const slowTrack = makeTtsTrack("slow");
	let ttsError = null;
	const ttsPromise = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: slowTrack }).catch((err) => {
		ttsError = err;
	});

	// Wait until TTS state is preparing
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(bus.querySync(playerId, PLAYER_QUERY.ttsIsActive), true, "TTS should be active while preparing");

	// Skip while preparing
	const context = { signal: new AbortController().signal };
	const skipSuccess = await skipController.skip(context);

	assert.equal(skipSuccess, true);
	assert.equal(musicTrackSkipped, false, "Music track must NOT be skipped during TTS preparation skip");

	// Clean up resolve
	if (resolvePrepare) {
		const s = new Readable({ read() {} });
		resolvePrepare({ stream: s, remote: false });
	}

	await ttsPromise;
	assert.ok(ttsError, "TTS promise should reject when skipped during preparation");
	assert.equal(ttsError.name, "AbortError");

	ttsController.detach(playerId);
});

test("When TTS is not playing, PlaybackSkipController executes normal music skip", async () => {
	const bus = new Bus();
	const playerId = "guild-music-skip";
	const voiceConnection = createMockVoiceConnection();

	let musicEnded = false;
	let nextStarted = false;

	const activeSession = {
		id: 1,
		sessionId: "music-sess",
		track: { id: "song-a", title: "Song A" },
		isActive: () => true,
		snapshot: () => ({ id: 1, status: "playing" }),
		markEnded: () => {
			musicEnded = true;
		},
	};

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => activeSession);
	bus.registerRpc(CONTROLLER_RPC.playbackStart, () => {
		nextStarted = true;
	});
	bus.registerRpc(CONTROLLER_RPC.playbackTransitionLock, () => {});

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: createMockAudioPlayer(),
		pluginManager: createMockPluginManager(),
	});

	const skipController = new PlaybackSkipController({
		bus,
		playerId,
		nextThroughBus: async () => ({ id: "song-b", title: "Song B" }),
		stopPlayback: async () => {},
		publishState: () => {},
		setWaitingForQueue: () => {},
	});

	const context = { signal: new AbortController().signal };
	const result = await skipController.skip(context);

	assert.equal(result, true);
	assert.equal(musicEnded, true, "Music session should end when skip is invoked without active TTS");
	assert.equal(nextStarted, true, "Next music track should be started");

	ttsController.detach(playerId);
});

test("TTS queue processing continues after an utterance fails", async () => {
	const bus = new Bus();
	const playerId = "guild-tts-failure-recovery";
	const voiceConnection = createMockVoiceConnection();

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => null);

	const customStreams = new Map();
	customStreams.set("tts-fail", async () => {
		throw new Error("Failed to generate TTS audio stream");
	});
	customStreams.set("tts-success", async () => {
		const stream = new Readable({
			read() {
				this.push(null);
			},
		});
		return { stream, remote: false };
	});

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: createMockAudioPlayer(),
		pluginManager: createMockPluginManager(customStreams),
	});

	const trackFail = makeTtsTrack("fail");
	const trackSuccess = makeTtsTrack("success");

	let failError = null;
	const pFail = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackFail }).catch((err) => {
		failError = err;
	});
	const pSuccess = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: trackSuccess });

	await pFail;
	assert.ok(failError, "Failing request must reject");
	assert.equal(failError.message, "Failed to generate TTS audio stream");

	// Subsequent request must still succeed!
	await pSuccess;
	assert.equal(bus.querySync(playerId, PLAYER_QUERY.ttsIsActive), false);

	ttsController.detach(playerId);
});

test("TTSController stop terminates active playback and clears pending queue", async () => {
	const bus = new Bus();
	const playerId = "guild-tts-stop";
	const voiceConnection = createMockVoiceConnection();

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => null);

	const customStreams = new Map();
	for (const id of ["1", "2", "3"]) {
		customStreams.set(`tts-${id}`, async () => {
			const stream = new Readable({ read() {} });
			return { stream, remote: false };
		});
	}

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: createMockAudioPlayer(),
		pluginManager: createMockPluginManager(customStreams),
	});

	const p1 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("1") });
	const p2 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("2") });
	const p3 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("3") });

	let p1Err, p2Err, p3Err;
	p1.catch((e) => (p1Err = e));
	p2.catch((e) => (p2Err = e));
	p3.catch((e) => (p3Err = e));

	await new Promise((r) => setTimeout(r, 20));

	// Stop TTS
	await bus.requestRpc(playerId, CONTROLLER_RPC.ttsStop, {});

	await Promise.allSettled([p1, p2, p3]);

	assert.ok(p1Err, "p1 should reject on stop");
	assert.ok(p2Err, "p2 should reject on stop");
	assert.ok(p3Err, "p3 should reject on stop");
	assert.equal(bus.querySync(playerId, PLAYER_QUERY.ttsIsActive), false, "Queue should be empty after stop");

	ttsController.detach(playerId);
});

test("Session replacement while TTS is playing does not resurrect obsolete music track", async () => {
	const bus = new Bus();
	const playerId = "guild-session-replace";
	const voiceConnection = createMockVoiceConnection();
	const musicAudioPlayer = createMockAudioPlayer();

	let currentSession = {
		id: 1,
		sessionId: "session-old",
		track: { id: "old-song" },
		isActive: () => true,
	};

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => currentSession);

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: musicAudioPlayer,
		pluginManager: createMockPluginManager(),
	});

	musicAudioPlayer.play({});
	assert.equal(musicAudioPlayer.state.status, AudioPlayerStatus.Playing);

	// Start TTS
	const ttsPromise = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("A") });
	await new Promise((r) => setTimeout(r, 20));

	// While TTS is playing, replace the music session with a new one
	currentSession = {
		id: 2,
		sessionId: "session-NEW",
		track: { id: "new-song" },
		isActive: () => false, // New session is not playing yet
	};

	// Skip TTS to complete it
	await bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {});
	await ttsPromise.catch(() => {});

	// Ensure old music track was not unpaused
	assert.notEqual(
		musicAudioPlayer.state.status,
		AudioPlayerStatus.Playing,
		"Obsolete music session must not be unpaused after session replacement",
	);

	ttsController.detach(playerId);
});

test("Concurrent skip requests do not corrupt queue or leave inconsistent state", async () => {
	const bus = new Bus();
	const playerId = "guild-concurrent-skip";
	const voiceConnection = createMockVoiceConnection();

	bus.registerQuery(PLAYER_QUERY.voiceConnection, () => voiceConnection);
	bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, () => null);

	const customStreams = new Map();
	for (const id of ["1", "2"]) {
		customStreams.set(`tts-${id}`, async () => {
			const stream = new Readable({ read() {} });
			return { stream, remote: false };
		});
	}

	const ttsController = new TTSController(bus);
	ttsController.attach(playerId, {
		audioPlayer: createMockAudioPlayer(),
		pluginManager: createMockPluginManager(customStreams),
	});

	const p1 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("1") });
	const p2 = bus.requestRpc(playerId, CONTROLLER_RPC.ttsPlay, { track: makeTtsTrack("2") });
	p1.catch(() => {});
	p2.catch(() => {});

	await new Promise((r) => setTimeout(r, 20));

	// Fire 5 skips concurrently
	const skipPromises = [
		bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {}),
		bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {}),
		bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {}),
		bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {}),
		bus.requestRpc(playerId, CONTROLLER_RPC.ttsSkip, {}),
	];

	const results = await Promise.all(skipPromises);
	assert.ok(
		results.some((r) => r.skipped === true),
		"At least one skip should succeed",
	);

	await Promise.allSettled([p1, p2]);
	assert.equal(bus.querySync(playerId, PLAYER_QUERY.ttsIsActive), false);

	ttsController.detach(playerId);
});
