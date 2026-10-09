const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { Readable } = require("node:stream");
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
		this.ready = backend.ready;
		this.state = "ready";
		this.bufferedBytes = 0;
		this.listeners = new Set();
		this.disposed = false;
		this.signal = context.signal;
		this.onAbort = () => {
			if (this.state === "playing") this.state = "stopped";
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
		this.state = "playing";
		this.emit({ type: "state", state: this.state });
		this.consumePromise = (async () => {
			try {
				for await (const chunk of this.input.stream) {
					this.bufferedBytes = this.input.stream.readableLength ?? chunk.byteLength;
					assert.ok(this.bufferedBytes <= this.backend.capabilities.maxBufferedBytes);
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
				if (this.state === "playing") this.state = "ended";
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

	stop(signal) {
		if (signal?.aborted) throw abortError();
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
		if (this.backend.capabilities.volume !== "backend") throw new AudioOutputUnsupportedOperationError("volume control");
		this.volume = value;
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
		this.signal?.removeEventListener("abort", this.onAbort);
		if (this.input.ownership === "transfer" && !this.input.stream.destroyed) this.input.stream.destroy();
		this.listeners.clear();
		this.backend.handles.delete(this);
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
	}

	initialize(signal) {
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
		this.handles.add(handle);
		return handle;
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
	assert.equal(handle.stop(), true);
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
