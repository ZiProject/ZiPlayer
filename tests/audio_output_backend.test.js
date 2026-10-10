const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { PassThrough, Readable } = require("node:stream");
const { AudioOutputUnsupportedOperationError, DiscordVoiceOutputBackend, convertFloat32PcmToS16Le } = require("../core/dist");
const { StreamType, TransformerType } = require("@discordjs/voice");

function abortError() {
	const error = new Error("output aborted");
	error.name = "AbortError";
	return error;
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeAudioOutputHandle {
	constructor(backend, input, context = {}) {
		this.backend = backend;
		this.input = input;
		this.format = input.format;
		this.ready = backend.handleReady ?? backend.ready;
		this.state = "ready";
		this.bufferedBytes = 0;
		this.volumeValues = [];
		this.listeners = new Set();
		this.disposed = false;
		this.disposeCalls = 0;
		this.signal = context.signal;
		this.onAbort = () => {
			this.state = "stopped";
			this.emit({ type: "state", state: this.state });
			void this.dispose();
		};
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.ready.catch(() => {
			void this.dispose();
		});
		this.resource = { id: ++backend.nextId };
	}

	async start(signal) {
		if (signal?.aborted || this.signal?.aborted) throw abortError();
		await this.waitUntilReady(signal);
		if (signal?.aborted || this.signal?.aborted) throw abortError();
		if (this.backend.startFailure) throw this.backend.startFailure;
		this.state = "playing";
		this.emit({ type: "state", state: this.state });
		await this.backend.activate(this);
		if (this.backend.startFailureAfterActivation) throw this.backend.startFailureAfterActivation;
		this.backend.notifyStarted();
		this.consumePromise = (async () => {
			try {
				for await (const chunk of this.input.stream) {
					this.bufferedBytes = this.input.stream.readableLength ?? chunk.byteLength;
					assert.ok(this.bufferedBytes <= this.backend.capabilities.maxBufferedBytes);
				}
				if (this.state === "playing") {
					this.state = "ended";
					this.emit({ type: "state", state: this.state });
					await this.dispose();
				}
			} catch (error) {
				if (!this.disposed && this.state !== "stopped") this.fail(error);
			}
		})();
	}

	async waitUntilReady(signal) {
		if (!signal && !this.signal) return this.ready;
		return new Promise((resolve, reject) => {
			let settled = false;
			const clean = () => {
				signal?.removeEventListener("abort", onAbort);
				this.signal?.removeEventListener("abort", onAbort);
			};
			const finish = (callback, value) => {
				if (settled) return;
				settled = true;
				clean();
				callback(value);
			};
			const onAbort = () => finish(reject, abortError());
			signal?.addEventListener("abort", onAbort, { once: true });
			this.signal?.addEventListener("abort", onAbort, { once: true });
			this.ready.then(
				() => finish(resolve),
				(error) => finish(reject, error),
			);
		});
	}

	pause(signal) {
		if (signal?.aborted) throw abortError();
		if (this.state !== "playing") return false;
		this.state = "paused";
		this.emit({ type: "state", state: this.state });
		return true;
	}

	resume(signal) {
		if (signal?.aborted) throw abortError();
		if (this.state !== "paused") return false;
		this.state = "playing";
		this.emit({ type: "state", state: this.state });
		return true;
	}

	async stop(signal) {
		this.backend.stopCalls++;
		this.backend.stopStarted.resolve();
		if (this.backend.stopGate) await this.backend.stopGate.promise;
		if (signal?.aborted) throw abortError();
		if (this.backend.stopFailure) throw this.backend.stopFailure;
		const changed = this.state === "playing" || this.state === "paused";
		this.state = "stopped";
		if (this.input.ownership === "transfer" && !this.input.stream.destroyed) this.input.stream.destroy();
		this.emit({ type: "state", state: this.state });
		return changed;
	}

	seek(_position, signal) {
		if (signal?.aborted) throw abortError();
		throw new AudioOutputUnsupportedOperationError("seek");
	}

	async replace(input, signal) {
		if (signal?.aborted) throw abortError();
		const replacement = this.backend.createSession(input, { signal });
		await replacement.start(signal);
		await this.dispose();
		return replacement;
	}

	setVolume(value, signal) {
		if (signal?.aborted) throw abortError();
		if (this.backend.volumeFailure) throw this.backend.volumeFailure;
		if (this.backend.capabilities.volume !== "backend") throw new AudioOutputUnsupportedOperationError("volume control");
		this.volume = value;
		this.volumeValues.push(value);
	}

	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	fail(error) {
		this.state = "failed";
		this.emit({ type: "error", error });
	}

	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.disposeCalls++;
		if (this.state !== "ended") this.state = "stopped";
		this.signal?.removeEventListener("abort", this.onAbort);
		if (this.input.ownership === "transfer" && !this.input.stream.destroyed) this.input.stream.destroy();
		this.listeners.clear();
		if (this.backend.activeHandle === this) this.backend.activeHandle = null;
		this.backend.handles.delete(this);
		if (this.backend.disposeFailure) throw this.backend.disposeFailure;
	}

	emit(event) {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeAudioOutputBackend {
	constructor() {
		this.capabilities = {
			pause: true,
			resume: true,
			stop: true,
			seek: "unsupported",
			replacement: "atomic",
			ownership: "both",
			volume: "backend",
			backpressure: "bounded",
			maxBufferedBytes: 8192,
		};
		this.readyGate = deferred();
		this.ready = this.readyGate.promise;
		this.handles = new Set();
		this.nextId = 0;
		this.disposed = false;
		this.activeHandle = null;
		this.startedCount = 0;
		this.startedWaiters = [];
		this.sessionWaiters = [];
		this.sessionCount = 0;
		this.stopCalls = 0;
		this.stopStarted = deferred();
		this.initializeStarted = deferred();
		this.stopGate = null;
		this.stopFailure = null;
		this.startFailure = null;
		this.startFailureAfterActivation = null;
		this.volumeFailure = null;
		this.initializeFailure = null;
		this.disposeFailure = null;
		this.handleReady = null;
	}

	initialize(signal) {
		if (this.initializeFailure) return Promise.reject(this.initializeFailure);
		this.initializeStarted.resolve();
		if (signal?.aborted) return Promise.reject(abortError());
		if (!signal) return this.ready;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(abortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.ready.then(
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	createSession(input, context) {
		if (this.disposed) throw new Error("fake backend is disposed");
		const handle = new FakeAudioOutputHandle(this, input, context);
		handle.resource.metadata = context?.metadata;
		this.handles.add(handle);
		for (const waiter of [...this.sessionWaiters]) {
			if (this.sessionCount + 1 >= waiter.count) {
				this.sessionWaiters.splice(this.sessionWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
		this.sessionCount++;
		return handle;
	}

	async activate(handle) {
		const previous = this.activeHandle;
		this.activeHandle = handle;
		if (previous && previous !== handle) await previous.dispose();
	}

	notifyStarted() {
		this.startedCount++;
		for (const waiter of [...this.startedWaiters]) {
			if (this.startedCount >= waiter.count) {
				this.startedWaiters.splice(this.startedWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	}

	waitForStarted(count) {
		if (this.startedCount >= count) return Promise.resolve();
		return new Promise((resolve) => this.startedWaiters.push({ count, resolve }));
	}

	waitForSessionCount(count) {
		if (this.sessionCount >= count) return Promise.resolve();
		return new Promise((resolve) => this.sessionWaiters.push({ count, resolve }));
	}

	async dispose() {
		for (const handle of [...this.handles]) await handle.dispose();
		this.disposed = true;
	}
}

function pcmFloat32(...samples) {
	const result = Buffer.alloc(samples.length * 4);
	samples.forEach((sample, index) => result.writeFloatLE(sample, index * 4));
	return result;
}

class MockAudioPlayer extends EventEmitter {
	constructor() {
		super();
		this.state = { status: "idle" };
		this.played = [];
	}

	play(resource) {
		const oldState = this.state;
		this.played.push(resource);
		this.state = { status: "buffering", resource };
		this.emit("stateChange", oldState, this.state);
	}

	enterPlaying() {
		const oldState = this.state;
		this.state = { status: "playing", resource: oldState.resource };
		this.emit("stateChange", oldState, this.state);
	}

	pause() {
		const oldState = this.state;
		this.state = { status: "paused", resource: oldState.resource };
		this.emit("stateChange", oldState, this.state);
		return true;
	}

	unpause() {
		const oldState = this.state;
		this.state = { status: "playing", resource: oldState.resource };
		this.emit("stateChange", oldState, this.state);
		return true;
	}

	stop() {
		const oldState = this.state;
		this.state = { status: "idle" };
		this.emit("stateChange", oldState, this.state);
		return true;
	}
}

const pcmFormat = {
	kind: "pcm",
	sampleFormat: "s16",
	endianness: "little",
	sampleRateHz: 48000,
	channels: 2,
	channelLayout: "interleaved",
	chunkAlignmentBytes: 4,
};

function playbackContext(playerId, signal = new AbortController().signal) {
	return {
		playerId,
		requestId: `request-${++playbackContext.nextId}`,
		source: "test",
		signal,
		timestamp: Date.now(),
		priority: 0,
	};
}
playbackContext.nextId = 0;

function createPlaybackHarness({
	backend = new FakeAudioOutputBackend(),
	playerId = "fake-output",
	transition = false,
	ready = true,
} = {}) {
	const {
		BUS_EVENT,
		Bus,
		CONTROLLER_RPC,
		PlaybackMode,
		PLAYER_QUERY,
		PLAYER_RPC,
		PlaybackController,
		PlaybackSessionController,
		PlaybackOrchestrator,
	} = require("../core/dist");
	if (ready) backend.readyGate.resolve();
	const bus = new Bus();
	const sessions = new PlaybackSessionController(bus);
	sessions.attach(playerId);
	const playback = new PlaybackController(bus);
	const playerErrors = [];
	const streamErrors = [];
	const recoveryReports = [];
	const sources = [];
	let mode = PlaybackMode.NATIVE;
	let remoteStopCalls = 0;
	let remoteStopFailure = null;
	let remoteStopResult = true;
	let remoteStopGate = null;
	const remoteStopStarted = deferred();
	let queueClearCalls = 0;
	const orchestrator = new PlaybackOrchestrator(bus, { sessionController: sessions });
	orchestrator.attach(playerId);
	playback.attach(playerId, { audioOutputBackendFactory: () => backend });
	bus.registerRpc(CONTROLLER_RPC.trackResetRecovery, () => {});
	bus.registerRpc(CONTROLLER_RPC.trackLoadWithRecovery, ({ track }) => {
		const stream = new PassThrough();
		sources.push(stream);
		return {
			track,
			stream: { track, stream, streamType: StreamType.Opus, inputType: StreamType.Opus },
			sessionId: sources.length,
			retry: 0,
			usedFallback: false,
		};
	});
	bus.registerRpc(CONTROLLER_RPC.streamReplace, ({ streamInfo, session }) => ({
		sessionId: session.id,
		session,
		track: session.track,
		stream: streamInfo.stream,
		streamId: null,
		inputType: streamInfo.inputType,
	}));
	bus.registerRpc(CONTROLLER_RPC.antiStuckReport, (request) => {
		recoveryReports.push(request);
		return true;
	});
	bus.registerRpc(PLAYER_RPC.queueWillNext, () => {});
	bus.registerRpc(CONTROLLER_RPC.playbackRemoteStop, () => {
		remoteStopCalls++;
		remoteStopStarted.resolve();
		if (remoteStopGate) return remoteStopGate.promise;
		if (remoteStopFailure) throw remoteStopFailure;
		return remoteStopResult;
	});
	bus.registerRpc(PLAYER_RPC.queueClear, () => {
		queueClearCalls++;
	});
	bus.registerQuery(PLAYER_QUERY.filterString, () => "");
	bus.registerQuery(PLAYER_QUERY.playbackMode, () => mode);
	bus.registerQuery(PLAYER_QUERY.transitionSettings, () => ({
		enabled: transition,
		durationMs: 30,
		waitForBeat: false,
		beatAlignMaxWaitMs: 0,
	}));
	if (transition) {
		bus.registerRpc(CONTROLLER_RPC.transitionPlan, () => ({
			enabled: true,
			durationMs: 30,
			waitForBeat: false,
			beatAlignMaxWaitMs: 0,
		}));
	}
	bus.subscribe(playerId, BUS_EVENT.trackError, (event) => playerErrors.push(event));
	bus.subscribe(playerId, BUS_EVENT.streamError, (event) => streamErrors.push(event));
	return {
		backend,
		bus,
		playerId,
		playback,
		orchestrator,
		sessions,
		sources,
		playerErrors,
		streamErrors,
		recoveryReports,
		remoteStopCalls: () => remoteStopCalls,
		remoteStopStarted: remoteStopStarted.promise,
		queueClearCalls: () => queueClearCalls,
		setMode(value) {
			mode = value;
		},
		setRemoteStopResult(value) {
			remoteStopResult = value;
		},
		setRemoteStopGate(gate) {
			remoteStopGate = gate;
		},
		setRemoteStopFailure(error) {
			remoteStopFailure = error;
		},
		start(track, signal) {
			const from = sessions.current(playerId)?.track ?? null;
			return orchestrator.states.get(playerId).start.start(track, playbackContext(playerId, signal), from);
		},
		async dispose() {
			playback.detach(playerId);
			await orchestrator.detach(playerId);
			await orchestrator.dispose();
			sessions.detach(playerId);
			await backend.dispose();
		},
	};
}

function testTrack(id) {
	return { id, title: id, url: `https://example.test/${id}`, duration: 1000, requestedBy: "test", source: "test" };
}

function createOutputResource(harness, track) {
	return harness.playback.createResource(harness.playerId, new PassThrough(), track, StreamType.Opus);
}

test("fake backend readiness gates start and supports the full output lifecycle", async () => {
	const backend = new FakeAudioOutputBackend();
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(8)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	const initialization = backend.initialize();
	let started = false;
	const start = handle.start().then(() => {
		started = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(started, false);
	backend.readyGate.resolve();
	await initialization;
	await start;
	assert.equal(handle.state, "playing");
	assert.equal(handle.pause(), true);
	assert.equal(handle.state, "paused");
	assert.equal(handle.resume(), true);
	assert.equal(handle.state, "playing");
	handle.setVolume(0.4);
	assert.equal(handle.volume, 0.4);
	assert.equal(await handle.stop(), true);
	assert.equal(handle.state, "stopped");
	await handle.dispose();
	assert.equal(handle.input.stream.destroyed, true);
	assert.equal(backend.handles.size, 0);
	await backend.dispose();
});

test("fake backend propagates abort during startup and active playback", async () => {
	const startupBackend = new FakeAudioOutputBackend();
	const startupAbort = new AbortController();
	const startup = startupBackend.createSession(
		{ stream: Readable.from([]), format: pcmFormat, ownership: "transfer" },
		{ signal: startupAbort.signal },
	);
	const pendingStart = startup.start();
	startupAbort.abort();
	await assert.rejects(pendingStart, { name: "AbortError" });
	assert.equal(startup.input.stream.destroyed, true);
	assert.equal(getEventListeners(startupAbort.signal, "abort").length, 0);
	await startupBackend.dispose();

	const activeBackend = new FakeAudioOutputBackend();
	activeBackend.readyGate.resolve();
	const activeAbort = new AbortController();
	const active = activeBackend.createSession(
		{ stream: Readable.from([Buffer.alloc(8)]), format: pcmFormat, ownership: "transfer" },
		{ signal: activeAbort.signal },
	);
	await active.start();
	activeAbort.abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(active.state, "stopped");
	assert.equal(active.input.stream.destroyed, true);
	assert.equal(getEventListeners(activeAbort.signal, "abort").length, 0);
	await activeBackend.dispose();
});

test("fake backend reports initialization failure and disposes transferred streams", async () => {
	const backend = new FakeAudioOutputBackend();
	const inputStream = Readable.from([Buffer.alloc(8)]);
	const handle = backend.createSession({ stream: inputStream, format: pcmFormat, ownership: "transfer" });
	const initialization = backend.initialize();
	const failure = new Error("output initialization failed");
	backend.readyGate.reject(failure);
	await assert.rejects(initialization, failure);
	await assert.rejects(handle.ready, failure);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inputStream.destroyed, true);
	assert.equal(backend.handles.size, 0);
	await backend.dispose();
});

test("fake backend replacement disposes the previous session and reports output errors", async () => {
	const backend = new FakeAudioOutputBackend();
	backend.readyGate.resolve();
	const first = backend.createSession({
		stream: Readable.from([]),
		format: { kind: "encoded", codec: "opus" },
		ownership: "transfer",
	});
	await first.start();
	const replacement = await first.replace({
		stream: Readable.from([Buffer.alloc(16)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	assert.equal(first.disposed, true);
	assert.equal(replacement.state, "playing");

	const reported = [];
	replacement.onEvent((event) => reported.push(event));
	const outputError = new Error("sink failed");
	replacement.fail(outputError);
	assert.equal(replacement.state, "failed");
	assert.equal(reported.at(-1).type, "error");
	assert.equal(reported.at(-1).error, outputError);
	await backend.dispose();
	assert.equal(backend.handles.size, 0);
});

test("fake backend advertises bounded buffering and enforces stream backpressure", async () => {
	const backend = new FakeAudioOutputBackend();
	backend.readyGate.resolve();
	const source = new Readable({
		highWaterMark: backend.capabilities.maxBufferedBytes,
		read() {
			for (let i = 0; i < 64; i++) this.push(Buffer.alloc(1024));
			this.push(null);
		},
	});
	const handle = backend.createSession({ stream: source, format: pcmFormat, ownership: "transfer" });
	assert.equal(backend.capabilities.backpressure, "bounded");
	assert.equal(handle.bufferedBytes, 0);
	await handle.start();
	await handle.consumePromise;
	assert.ok(handle.bufferedBytes <= backend.capabilities.maxBufferedBytes);
	assert.equal(backend.capabilities.seek, "unsupported");
	await backend.dispose();
	assert.equal(backend.handles.size, 0);
});

test("PlaybackController selects Discord Voice by default for legacy AudioPlayer callers", () => {
	const { Bus, PlaybackController } = require("../core/dist");
	const player = new MockAudioPlayer();
	const controller = new PlaybackController(new Bus());
	controller.attach("default-discord", { audioPlayer: player });
	const track = testTrack("default-track");
	const resource = controller.createResource("default-discord", Readable.from([Buffer.from("opus")]), track, StreamType.Opus);
	controller.play("default-discord", resource);
	assert.equal(player.played[0], resource);
	assert.equal(controller.getAudioPlayer("default-discord"), player);
	controller.detach("default-discord");
});

test("injected fake backend runs playback orchestration and replacement without a voice connection", async () => {
	const harness = createPlaybackHarness();
	const firstTrack = testTrack("orchestrated-one");
	const secondTrack = testTrack("orchestrated-two");
	await harness.start(firstTrack);
	const firstHandle = harness.backend.activeHandle;
	assert.equal(firstHandle.state, "playing");
	assert.equal(harness.sessions.current(harness.playerId).track, firstTrack);

	await harness.start(secondTrack);
	assert.equal(firstHandle.disposed, true);
	assert.equal(harness.sources[0].destroyed, true);
	assert.equal(harness.backend.handles.size, 1);
	assert.equal(harness.backend.activeHandle.resource.metadata, secondTrack);
	assert.equal(harness.sessions.current(harness.playerId).track, secondTrack);
	await harness.dispose();
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(harness.sources[1].destroyed, true);
});

test("injected playback releases transferred streams when startup or active playback is cancelled", async () => {
	const startupBackend = new FakeAudioOutputBackend();
	const startupHarness = createPlaybackHarness({ backend: startupBackend, playerId: "startup-cancel", ready: false });
	const startupAbort = new AbortController();
	const startup = startupHarness.start(testTrack("startup-cancel-track"), startupAbort.signal);
	await startupBackend.waitForSessionCount(1);
	startupAbort.abort();
	await startup;
	assert.equal(startupBackend.handles.size, 0);
	assert.equal(startupHarness.sources[0].destroyed, true);
	await startupHarness.dispose();

	const activeBackend = new FakeAudioOutputBackend();
	activeBackend.readyGate.resolve();
	const activeHarness = createPlaybackHarness({ backend: activeBackend, playerId: "active-cancel" });
	const activeAbort = new AbortController();
	await activeHarness.start(testTrack("active-cancel-track"), activeAbort.signal);
	activeAbort.abort();
	assert.equal(activeBackend.handles.size, 0);
	assert.equal(activeHarness.sources[0].destroyed, true);
	await activeHarness.dispose();
});

test("injected output failures reach track error and anti-stuck recovery handlers", async () => {
	const harness = createPlaybackHarness({ playerId: "output-failure" });
	await harness.start(testTrack("output-failure-track"));
	const handle = harness.backend.activeHandle;
	const failure = new Error("fake sink failure");
	handle.fail(failure);
	assert.equal(harness.playerErrors[0].error, failure);
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(harness.sources[0].destroyed, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.recoveryReports[0].reason, "audio output error: fake sink failure");
	await harness.dispose();
});

test("injected backend crossfades through its volume operation and rejects unsupported crossfade", async () => {
	const harness = createPlaybackHarness({ playerId: "fake-crossfade", transition: true });
	const first = testTrack("crossfade-one");
	const second = testTrack("crossfade-two");
	await harness.start(first);
	const firstHandle = harness.backend.activeHandle;
	await harness.start(second, undefined);
	await harness.backend.waitForStarted(2);
	const secondHandle = harness.backend.activeHandle;
	assert.equal(firstHandle.disposed, true);
	assert.ok(secondHandle.volumeValues?.includes(0));
	harness.playback.cancelFade(harness.playerId);
	assert.equal(harness.playback.getFadeGain(harness.playerId), null);
	await harness.dispose();

	const unsupportedBackend = new FakeAudioOutputBackend();
	unsupportedBackend.capabilities.volume = "unsupported";
	unsupportedBackend.readyGate.resolve();
	const unsupported = createPlaybackHarness({
		backend: unsupportedBackend,
		playerId: "unsupported-crossfade",
		transition: true,
	});
	await unsupported.start(testTrack("unsupported-one"));
	await assert.rejects(unsupported.start(testTrack("unsupported-two")), AudioOutputUnsupportedOperationError);
	assert.equal(unsupportedBackend.handles.size, 0);
	await unsupported.dispose();
});

test("injected backend disposal is idempotent and releases handle listeners", async () => {
	const harness = createPlaybackHarness({ playerId: "idempotent-dispose" });
	await harness.start(testTrack("dispose-track"));
	const handle = harness.backend.activeHandle;
	assert.equal(handle.listeners.size, 1);
	await harness.dispose();
	await harness.backend.dispose();
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(handle.listeners.size, 0);
	assert.equal(handle.disposeCalls, 1);
});

test("stop failure still disposes transferred input and reports cleanup failure separately", async () => {
	const harness = createPlaybackHarness({ playerId: "stop-failure" });
	await harness.start(testTrack("stop-failure-track"));
	const handle = harness.backend.activeHandle;
	const stopError = new Error("stop rejected");
	const cleanupError = new Error("dispose reported cleanup fault");
	harness.backend.stopFailure = stopError;
	harness.backend.disposeFailure = cleanupError;

	await assert.rejects(harness.playback.stop(harness.playerId), (error) => error === stopError);
	assert.equal(handle.disposed, true);
	assert.equal(handle.input.stream.destroyed, true);
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(harness.playback.getActiveResource(harness.playerId), null);
	assert.ok(harness.streamErrors.some((event) => event.error === cleanupError));
	await harness.dispose();
});

test("abort during a pending stop triggers cleanup without waiting for the backend stop promise", async () => {
	const harness = createPlaybackHarness({ playerId: "stop-abort" });
	await harness.start(testTrack("stop-abort-track"));
	const handle = harness.backend.activeHandle;
	const abort = new AbortController();
	harness.backend.stopGate = deferred();
	harness.backend.stopStarted = deferred();

	const pendingStop = harness.playback.stop(harness.playerId, abort.signal);
	await harness.backend.stopStarted.promise;
	abort.abort();
	await assert.rejects(pendingStop, { name: "AbortError" });
	assert.equal(handle.disposed, true);
	assert.equal(handle.input.stream.destroyed, true);
	assert.equal(harness.backend.handles.size, 0);
	harness.backend.stopGate.resolve();
	await harness.dispose();
	assert.equal(handle.disposeCalls, 1);
});

test("stop cancels and disposes a handle still waiting to start", async () => {
	const backend = new FakeAudioOutputBackend();
	const harness = createPlaybackHarness({ backend, playerId: "stop-pending-start", ready: false });
	const resource = createOutputResource(harness, testTrack("stop-pending-start-track"));
	const handle = backend.handles.values().next().value;
	const startup = harness.playback.play(harness.playerId, resource);
	await backend.initializeStarted.promise;
	await harness.playback.stop(harness.playerId);
	await assert.rejects(startup, { name: "AbortError" });
	assert.equal(handle.disposed, true);
	assert.equal(handle.input.stream.destroyed, true);
	assert.equal(backend.handles.size, 0);
	backend.readyGate.resolve();
	await harness.dispose();
});

test("a stop completing after replacement cannot clear or dispose the replacement", async () => {
	const harness = createPlaybackHarness({ playerId: "stale-stop" });
	await harness.start(testTrack("stale-stop-old"));
	const oldHandle = harness.backend.activeHandle;
	harness.backend.stopGate = deferred();
	harness.backend.stopStarted = deferred();
	const stopPromise = harness.playback.stop(harness.playerId);
	await harness.backend.stopStarted.promise;

	const nextTrack = testTrack("stale-stop-new");
	const nextResource = createOutputResource(harness, nextTrack);
	await harness.playback.play(harness.playerId, nextResource, undefined, null, undefined);
	const replacement = harness.backend.activeHandle;
	assert.notEqual(replacement, oldHandle);
	harness.backend.stopGate.resolve();
	await stopPromise;
	assert.equal(harness.playback.getActiveResource(harness.playerId), nextResource);
	assert.equal(harness.backend.activeHandle, replacement);
	assert.equal(replacement.disposed, false);
	assert.equal(oldHandle.disposed, true);
	await harness.dispose();
});

test("remote stop awaits success and never stops the local output backend", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-success" });
	await harness.start(testTrack("remote-stop-track"));
	const activeHandle = harness.backend.activeHandle;
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);

	assert.equal(await harness.playback.stop(harness.playerId), true);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.backend.stopCalls, 0);
	assert.equal(harness.backend.activeHandle, activeHandle);
	assert.equal(activeHandle.disposed, false);
	await harness.dispose();
});

test("remote stop rejection propagates and does not stop the local backend", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-rejected" });
	await harness.start(testTrack("remote-stop-rejected-track"));
	const activeHandle = harness.backend.activeHandle;
	const remoteFailure = new Error("remote stop failed");
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	harness.setRemoteStopFailure(remoteFailure);

	await assert.rejects(harness.playback.stop(harness.playerId), (error) => error === remoteFailure);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.backend.stopCalls, 0);
	assert.equal(harness.backend.activeHandle, activeHandle);
	assert.equal(activeHandle.disposed, false);
	await harness.dispose();
});

test("aborting one direct remote STOP caller does not cancel its coalesced peer", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-caller-abort" });
	await harness.start(testTrack("remote-stop-caller-abort-track"));
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	const gate = deferred();
	harness.setRemoteStopGate(gate);
	const firstAbort = new AbortController();
	const first = harness.playback.stop(harness.playerId, firstAbort.signal);
	const second = harness.playback.stop(harness.playerId, new AbortController().signal);
	await harness.remoteStopStarted;

	firstAbort.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(harness.remoteStopCalls(), 1);
	gate.resolve(true);
	assert.equal(await second, true);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.backend.stopCalls, 0);
	await harness.dispose();
});

test("remote STOP false result preserves session, queue, and stop events", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-false" });
	await harness.start(testTrack("remote-stop-false-track"));
	const session = harness.sessions.current(harness.playerId);
	const stopEvents = [];
	harness.bus.subscribe(harness.playerId, "playerStop", (event) => stopEvents.push(event));
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	harness.setRemoteStopResult(false);
	const context = { ...playbackContext(harness.playerId), sessionId: session.sessionId };

	await harness.bus.action(harness.playerId, { type: "STOP" }, context);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.queueClearCalls(), 0);
	assert.equal(session.isActive(), true);
	assert.equal(stopEvents.length, 0);
	assert.equal(harness.backend.stopCalls, 0);
	await harness.dispose();
});

test("overlapping remote STOP requests share one RPC and commit once", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-repeated" });
	await harness.start(testTrack("remote-stop-repeated-track"));
	const session = harness.sessions.current(harness.playerId);
	let stopEvents = 0;
	harness.bus.subscribe(harness.playerId, "playerStop", () => stopEvents++);
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	const gate = deferred();
	harness.setRemoteStopGate(gate);
	const firstAbort = new AbortController();
	const firstContext = {
		...playbackContext(harness.playerId, firstAbort.signal),
		sessionId: session.sessionId,
	};
	const secondContext = {
		...playbackContext(harness.playerId, new AbortController().signal),
		sessionId: session.sessionId,
	};

	const first = harness.bus.action(harness.playerId, { type: "STOP" }, firstContext);
	const second = harness.bus.action(harness.playerId, { type: "STOP" }, secondContext);
	await harness.remoteStopStarted;
	assert.equal(harness.remoteStopCalls(), 1);
	firstAbort.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(session.isActive(), true);
	assert.equal(harness.queueClearCalls(), 0);
	gate.resolve(true);
	await second;
	assert.equal(harness.queueClearCalls(), 1);
	assert.equal(stopEvents, 1);
	assert.equal(session.status, "stopped");
	assert.equal(harness.backend.stopCalls, 0);
	await harness.dispose();
});

test("remote STOP action awaits remote completion without entering local stop logic", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-action" });
	const track = testTrack("remote-stop-action-track");
	await harness.start(track);
	const session = harness.sessions.current(harness.playerId);
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	const context = { ...playbackContext(harness.playerId), sessionId: session.sessionId };

	await harness.bus.action(harness.playerId, { type: "STOP" }, context);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.backend.stopCalls, 0);
	assert.equal(session.status, "stopped");
	assert.equal(harness.backend.activeHandle.disposed, false);
	await harness.dispose();
});

test("rejected remote STOP action leaves local playback untouched and propagates failure", async () => {
	const harness = createPlaybackHarness({ playerId: "remote-stop-action-rejected" });
	const track = testTrack("remote-stop-action-rejected-track");
	await harness.start(track);
	const session = harness.sessions.current(harness.playerId);
	const activeHandle = harness.backend.activeHandle;
	const failure = new Error("remote action stop rejected");
	harness.setMode(require("../core/dist").PlaybackMode.REMOTE);
	harness.setRemoteStopFailure(failure);
	const context = { ...playbackContext(harness.playerId), sessionId: session.sessionId };

	await assert.rejects(harness.bus.action(harness.playerId, { type: "STOP" }, context), (error) => error === failure);
	assert.equal(harness.remoteStopCalls(), 1);
	assert.equal(harness.backend.stopCalls, 0);
	assert.equal(session.isActive(), true);
	assert.equal(harness.backend.activeHandle, activeHandle);
	await harness.dispose();
});

test("volume, initialization, readiness, and start failures dispose only the unactivated handle", async () => {
	for (const [caseName, configure, expectedFailure] of [
		[
			"volume",
			(backend) => {
				backend.volumeFailure = new Error("volume failure");
			},
			"volume failure",
		],
		[
			"initialization",
			(backend) => {
				backend.initializeFailure = new Error("initialize failure");
			},
			"initialize failure",
		],
		[
			"readiness",
			(backend) => {
				backend.handleReady = Promise.reject(new Error("readiness failure"));
			},
			"readiness failure",
		],
		[
			"start",
			(backend) => {
				backend.startFailure = new Error("start failure");
			},
			"start failure",
		],
	]) {
		const backend = new FakeAudioOutputBackend();
		backend.readyGate.resolve();
		const harness = createPlaybackHarness({ backend, playerId: `startup-${caseName}` });
		configure(backend);
		const track = testTrack(`startup-${caseName}-track`);
		const resource = createOutputResource(harness, track);
		const handle = backend.handles.values().next().value;
		await assert.rejects(harness.playback.play(harness.playerId, resource), new RegExp(expectedFailure));
		assert.equal(handle.disposed, true, `${caseName} failure leaked handle`);
		assert.equal(handle.input.stream.destroyed, true, `${caseName} failure leaked transferred stream`);
		assert.equal(backend.handles.size, 0, `${caseName} failure left a registered handle`);
		assert.equal(harness.playback.getActiveResource(harness.playerId), null);
		await harness.dispose();
	}
});

test("stop-before-start replacement failure cleans both handles without restoring a disposed session", async () => {
	const backend = new FakeAudioOutputBackend();
	backend.capabilities.replacement = "stop-before-start";
	const harness = createPlaybackHarness({ backend, playerId: "replacement-start-failure" });
	await harness.start(testTrack("replacement-old"));
	const oldHandle = backend.activeHandle;
	backend.startFailure = new Error("replacement start failed");
	const replacementTrack = testTrack("replacement-failed");
	const resource = createOutputResource(harness, replacementTrack);
	const replacementHandle = [...backend.handles].find((handle) => handle !== oldHandle);

	await assert.rejects(harness.playback.play(harness.playerId, resource), /replacement start failed/);
	assert.equal(oldHandle.disposed, true);
	assert.equal(replacementHandle.disposed, true);
	assert.equal(oldHandle.input.stream.destroyed, true);
	assert.equal(replacementHandle.input.stream.destroyed, true);
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(harness.playback.getActiveResource(harness.playerId), null);
	await harness.dispose();
});

test("crossfade volume failure preserves the active handle and releases the candidate", async () => {
	const harness = createPlaybackHarness({ playerId: "crossfade-volume-failure", transition: true });
	const oldTrack = testTrack("crossfade-volume-old");
	await harness.start(oldTrack);
	const oldHandle = harness.backend.activeHandle;
	harness.backend.volumeFailure = new Error("crossfade volume failed");
	const nextTrack = testTrack("crossfade-volume-new");
	const nextResource = createOutputResource(harness, nextTrack);
	const candidate = [...harness.backend.handles].find((handle) => handle !== oldHandle);

	await assert.rejects(
		harness.playback.play(harness.playerId, nextResource, undefined, oldTrack, nextTrack),
		/crossfade volume failed/,
	);
	assert.equal(candidate.disposed, true);
	assert.equal(harness.backend.activeHandle, oldHandle);
	assert.equal(harness.playback.getActiveResource(harness.playerId), oldHandle.resource);
	assert.equal(harness.backend.handles.size, 1);
	assert.equal(harness.playback.getFadeGain(harness.playerId), null);
	await harness.dispose();
});

test("atomic replacement that fails after backend activation clears invalidated old output", async () => {
	const harness = createPlaybackHarness({ playerId: "atomic-replacement-failure", transition: true });
	const oldTrack = testTrack("atomic-old");
	await harness.start(oldTrack);
	const oldHandle = harness.backend.activeHandle;
	harness.backend.startFailureAfterActivation = new Error("atomic replacement failed after activation");
	const nextTrack = testTrack("atomic-new");
	const nextResource = createOutputResource(harness, nextTrack);
	const replacement = [...harness.backend.handles].find((handle) => handle !== oldHandle);

	await assert.rejects(
		harness.playback.play(harness.playerId, nextResource, undefined, oldTrack, nextTrack),
		/atomic replacement failed after activation/,
	);
	assert.equal(oldHandle.disposed, true);
	assert.equal(replacement.disposed, true);
	assert.equal(harness.backend.activeHandle, null);
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(harness.playback.getActiveResource(harness.playerId), null);
	await harness.dispose();
});

test("concurrent stop and detach dispose an active handle exactly once", async () => {
	const harness = createPlaybackHarness({ playerId: "stop-detach" });
	await harness.start(testTrack("stop-detach-track"));
	const handle = harness.backend.activeHandle;
	harness.backend.stopGate = deferred();
	harness.backend.stopStarted = deferred();
	const stop = harness.playback.stop(harness.playerId);
	await harness.backend.stopStarted.promise;
	const duplicateStop = harness.playback.stop(harness.playerId);
	harness.playback.detach(harness.playerId);
	await Promise.all([assert.rejects(stop, { name: "AbortError" }), assert.rejects(duplicateStop, { name: "AbortError" })]);
	harness.backend.stopGate.resolve();
	assert.equal(handle.disposeCalls, 1);
	assert.equal(handle.input.stream.destroyed, true);
	assert.equal(harness.backend.handles.size, 0);
	await harness.orchestrator.detach(harness.playerId);
	await harness.orchestrator.dispose();
	harness.sessions.detach(harness.playerId);
});

test("preload promotion reports asynchronous output startup failures", async () => {
	const harness = createPlaybackHarness({ playerId: "preload-start-failure" });
	const track = testTrack("preloaded-track");
	harness.sessions.replace(harness.playerId, track);
	const source = Readable.from([Buffer.from("encoded preload")]);
	const { PreloadController } = require("../core/dist");
	const preloader = new PreloadController(harness.bus, {
		loader: {
			hasPreload: () => false,
			cancelPreload: () => {},
			cancelPreloadSafely: async () => {},
			preloadNext: async () => {},
		},
		manager: {
			takePreloaded: () => ({
				track,
				stream: source,
				streamInfo: { track, stream: source, type: "arbitrary", inputType: StreamType.Opus },
				streamId: null,
			}),
			slotState: () => ({}),
			clearPreloadSlot: () => {},
		},
	});
	const reported = deferred();
	harness.bus.subscribe(harness.playerId, require("../core/dist").BUS_EVENT.trackError, (event) => {
		if (event.track === track || event.session?.track === track) reported.resolve(event);
	});
	harness.backend.startFailure = new Error("preload output start failed");

	const resource = preloader.promotePreload(harness.playerId, track);
	assert.ok(resource);
	const event = await reported.promise;
	assert.match(event.error.message, /preload output start failed/);
	assert.equal(harness.backend.handles.size, 0);
	assert.equal(source.destroyed, true);
	await harness.dispose();
});

test("Discord backend converts float32 PCM at the adapter boundary and controls inline volume", async () => {
	const player = new MockAudioPlayer();
	const backend = new DiscordVoiceOutputBackend(player);
	const track = { id: "float-track", title: "Float PCM", duration: 1000 };
	const input = Readable.from([pcmFloat32(-1, -0.5, 0.5, 1)]);
	const fragmentedFloatPcm = pcmFloat32(-1, -0.5, 0.5, 1);
	const converterInput = Readable.from([fragmentedFloatPcm.subarray(0, 5), fragmentedFloatPcm.subarray(5)]);
	const convertedChunks = [];
	for await (const chunk of convertFloat32PcmToS16Le(converterInput)) convertedChunks.push(Buffer.from(chunk));
	const converted = Buffer.concat(convertedChunks);
	assert.equal(converted.byteLength, 8);
	assert.deepEqual(
		Array.from({ length: 4 }, (_, index) => converted.readInt16LE(index * 2)),
		[-32767, -16383, 16384, 32767],
	);
	const resource = backend.createResource(input, track, StreamType.Raw, {
		kind: "pcm",
		sampleFormat: "f32",
		endianness: "little",
		sampleRateHz: 48000,
		channels: 2,
		channelLayout: "interleaved",
	});
	assert.equal(resource.metadata, track);
	assert.ok(resource.volume);
	backend.setVolume(resource, 0.25);
	assert.equal(backend.getVolume(resource), 0.25);

	assert.ok(resource.edges.some((edge) => edge.type === TransformerType.InlineVolume));
	assert.ok(resource.edges.some((edge) => edge.type === TransformerType.OpusEncoder));
	backend.dispose();
});

test("Discord backend preserves lifecycle behavior and removes its player listeners on disposal", async () => {
	const player = new MockAudioPlayer();
	const baselineStateListeners = player.listenerCount("stateChange");
	const baselineErrorListeners = player.listenerCount("error");
	const backend = new DiscordVoiceOutputBackend(player);
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(8)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	const events = [];
	const detach = handle.onEvent((event) => events.push(event));
	handle.start();
	assert.equal(player.played[0], handle.resource);
	assert.equal(handle.state, "buffering");
	player.enterPlaying();
	assert.equal(handle.state, "playing");
	assert.equal(handle.pause(), true);
	assert.equal(handle.state, "paused");
	assert.equal(handle.resume(), true);
	assert.equal(handle.state, "playing");
	assert.equal(handle.stop(), true);
	assert.equal(handle.state, "stopped");
	assert.ok(events.some((event) => event.type === "state"));
	detach();
	handle.dispose();
	backend.dispose();
	assert.equal(player.listenerCount("stateChange"), baselineStateListeners);
	assert.equal(player.listenerCount("error"), baselineErrorListeners);
});

test("Discord backend rejects PCM formats that do not meet the raw PCM contract", () => {
	const backend = new DiscordVoiceOutputBackend(new MockAudioPlayer());
	assert.throws(
		() =>
			backend.createSession({
				stream: Readable.from([]),
				format: { ...pcmFormat, sampleRateHz: 44100 },
				ownership: "transfer",
			}),
		/Discord raw PCM requires interleaved 48 kHz stereo/,
	);
	backend.dispose();
});

test("Discord backend rejects borrowed streams because voice replacement destroys resources", () => {
	const backend = new DiscordVoiceOutputBackend(new MockAudioPlayer());
	assert.throws(
		() =>
			backend.createSession({
				stream: Readable.from([]),
				format: { kind: "encoded", codec: "opus" },
				ownership: "borrow",
			}),
		/requires transferred stream ownership/,
	);
	backend.dispose();
});
