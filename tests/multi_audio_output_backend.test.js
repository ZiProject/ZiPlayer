const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Readable } = require("node:stream");
const { MultiAudioOutputBackend } = require("../core/dist");

const PCM = {
	kind: "pcm",
	sampleFormat: "s16",
	endianness: "little",
	sampleRateHz: 48000,
	channels: 2,
	channelLayout: "interleaved",
	chunkAlignmentBytes: 4,
};

function deferred() {
	let resolve;
	const promise = new Promise((res) => (resolve = res));
	return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 1500) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for audio output test condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class TestOutputHandle {
	constructor(backend, input) {
		this.backend = backend;
		this.input = input;
		this.format = input.format;
		this.ready = Promise.resolve();
		this.state = "ready";
		this.bufferedBytes = 0;
		this.listeners = new Set();
		this.resource = { playbackDuration: 0, metadata: null, playStream: input.stream };
		this.bytes = [];
		this.ended = deferred();
		backend.handles.add(this);
	}
	start() {
		this.state = "playing";
		this.emit({ type: "state", state: this.state });
		if (this.backend.consume) {
			this.consumePromise = (async () => {
				try {
					let chunkCount = 0;
					for await (const chunk of this.input.stream) {
						this.bytes.push(Buffer.from(chunk));
						chunkCount++;
						if (this.backend.endAfterChunks && chunkCount >= this.backend.endAfterChunks) break;
					}
					this.state = "ended";
					this.emit({ type: "state", state: this.state });
				} catch (error) {
					if (this.state !== "stopped") this.emit({ type: "error", error });
				} finally {
					this.ended.resolve();
				}
			})();
		}
	}
	pause() {
		if (this.state !== "playing") return false;
		this.state = "paused";
		this.emit({ type: "state", state: this.state });
		return true;
	}
	resume() {
		if (this.state !== "paused") return false;
		this.state = "playing";
		this.emit({ type: "state", state: this.state });
		return true;
	}
	stop() {
		const changed = this.state === "playing" || this.state === "paused";
		this.state = "stopped";
		if (!this.input.stream.destroyed) this.input.stream.destroy();
		this.emit({ type: "state", state: this.state });
		this.ended.resolve();
		return changed;
	}
	seek() {
		throw new Error("seek unsupported in test backend");
	}
	replace() {
		throw new Error("replace unsupported in test backend");
	}
	setVolume() {}
	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose() {
		if (!this.input.stream.destroyed) this.input.stream.destroy();
		this.backend.handles.delete(this);
		this.listeners.clear();
	}
	emit(event) {
		for (const listener of this.listeners) listener(event);
	}
}

class TestOutputBackend {
	constructor({
		id,
		consume = true,
		available = true,
		backpressure = "source",
		maxBufferedBytes = null,
		endAfterChunks = 0,
		acceptedProcessOutputs = ["pcm16le"],
		replacement = "atomic",
		seek = "unsupported",
	} = {}) {
		this.id = id;
		this.consume = consume;
		this.endAfterChunks = endAfterChunks;
		this.available = available;
		this.capabilities = {
			pause: true,
			resume: true,
			stop: true,
			seek,
			replacement,
			ownership: "transfer",
			volume: "unsupported",
			backpressure,
			maxBufferedBytes,
			acceptedProcessOutputs,
			preferredProcessOutput: "pcm16le",
		};
		this.ready = Promise.resolve();
		this.handles = new Set();
		this.disposed = false;
	}
	initialize() {
		return Promise.resolve();
	}
	createSession(input) {
		return new TestOutputHandle(this, input);
	}
	isAvailableForPacing() {
		return this.available;
	}
	dispose() {
		this.disposed = true;
	}
}

function pcmInput(stream) {
	return { stream, format: PCM, ownership: "transfer" };
}

async function waitForEnd(handle, backends) {
	await Promise.all(backends.flatMap((backend) => [...backend.handles].map((child) => child.ended.promise)));
	await waitFor(() => handle.state === "ended");
}

test("fans a single PCM source out to two outputs and ends the composite once", async () => {
	const primary = new TestOutputBackend({ id: "primary", backpressure: "source" });
	const secondary = new TestOutputBackend({ id: "secondary", backpressure: "bounded", maxBufferedBytes: 192 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	await mux.addBackend(secondary, { id: "secondary" });
	const sourceChunks = [Buffer.alloc(4096, 0x11), Buffer.alloc(4096, 0x22), Buffer.alloc(4096, 0x33)];
	const handle = mux.createSession(pcmInput(Readable.from(sourceChunks)), { metadata: { title: "fixture" } });
	const primaryChild = [...primary.handles][0];
	const secondaryChild = [...secondary.handles][0];
	let endEvents = 0;
	handle.onEvent((event) => {
		if (event.type === "state" && event.state === "ended") endEvents++;
	});
	await handle.start();
	await waitForEnd(handle, [primary, secondary]);
	assert.deepEqual(Buffer.concat(primaryChild.bytes), Buffer.concat(sourceChunks));
	assert.deepEqual(Buffer.concat(secondaryChild.bytes), Buffer.concat(sourceChunks));
	assert.equal(endEvents, 1);
	await mux.dispose();
	assert.equal(primary.disposed, true);
	assert.equal(secondary.disposed, true);
});

test("a sink connected mid-track starts at the next chunk and can be removed dynamically", async () => {
	const primary = new TestOutputBackend({ id: "primary" });
	const late = new TestOutputBackend({ id: "late", backpressure: "bounded", maxBufferedBytes: 192 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	const source = new PassThrough();
	const handle = mux.createSession(pcmInput(source));
	await handle.start();
	const mainChild = [...primary.handles][0];
	source.write(Buffer.alloc(1024, 1));
	await waitFor(() => Buffer.concat(mainChild.bytes).length === 1024);
	await mux.addBackend(late, { id: "late" });
	const lateChild = [...late.handles][0];
	source.write(Buffer.alloc(2048, 2));
	await waitFor(() => Buffer.concat(mainChild.bytes).length === 3072 && Buffer.concat(lateChild.bytes).length === 2048);
	assert.equal(await mux.removeBackend("late"), true);
	source.write(Buffer.alloc(512, 3));
	source.end();
	await waitFor(() => handle.state === "ended");
	assert.equal(Buffer.concat(mainChild.bytes).length, 3584);
	assert.equal(Buffer.concat(lateChild.bytes).length, 2048);
	await mux.dispose();
});

test("when the pacing master ends early, the live secondary becomes master without losing later chunks", async () => {
	const primary = new TestOutputBackend({ id: "discord", endAfterChunks: 1, backpressure: "source" });
	const secondary = new TestOutputBackend({ id: "websocket", backpressure: "bounded", maxBufferedBytes: 192 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "discord" });
	await mux.addBackend(secondary, { id: "websocket" });
	const source = new PassThrough();
	const handle = mux.createSession(pcmInput(source));
	await handle.start();
	const primaryChild = [...primary.handles][0];
	const secondaryChild = [...secondary.handles][0];
	const first = Buffer.alloc(4096, 0x31);
	const second = Buffer.alloc(4096, 0x32);
	source.write(first);
	await waitFor(() => primaryChild.state === "ended");
	assert.equal(mux.isPacingOutput("websocket"), true);
	source.write(second);
	source.end();
	await waitFor(() => handle.state === "ended");
	assert.deepEqual(Buffer.concat(secondaryChild.bytes), Buffer.concat([first, second]));
	await mux.dispose();
});

test("an unavailable Discord-like sink does not become the pacing master over a live sink", async () => {
	const discord = new TestOutputBackend({ id: "discord", available: false, backpressure: "source" });
	const websocket = new TestOutputBackend({ id: "websocket", available: true, backpressure: "bounded", maxBufferedBytes: 192 * 1024 });
	const mux = new MultiAudioOutputBackend(discord, { id: "discord" });
	await mux.addBackend(websocket, { id: "websocket" });
	assert.equal(mux.isPacingOutput("websocket"), true);
	assert.equal(mux.isPacingOutput("discord"), false);
	await mux.dispose();
});



test("combined capabilities reflect the actual sink intersection", async () => {
	const discord = new TestOutputBackend({ id: "discord", acceptedProcessOutputs: ["encoded", "pcm16le", "pcmFloat32"] });
	const websocket = new TestOutputBackend({
		id: "websocket",
		backpressure: "bounded",
		maxBufferedBytes: 64 * 1024,
		acceptedProcessOutputs: ["pcm16le"],
		replacement: "stop-before-start",
	});
	const mux = new MultiAudioOutputBackend(discord, { id: "discord" });
	await mux.addBackend(websocket, { id: "websocket" });
	assert.deepEqual(mux.capabilities.acceptedProcessOutputs, ["pcm16le"]);
	assert.equal(mux.capabilities.preferredProcessOutput, "pcm16le");
	assert.equal(mux.capabilities.seek, "unsupported");
	assert.equal(mux.capabilities.replacement, "stop-before-start");
	assert.equal(mux.capabilities.maxBufferedBytes, 64 * 1024);
	await mux.dispose();
});

test("pause, resume, and stop are propagated to every registered sink", async () => {
	const primary = new TestOutputBackend({ id: "primary" });
	const secondary = new TestOutputBackend({ id: "secondary", backpressure: "bounded", maxBufferedBytes: 64 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	await mux.addBackend(secondary, { id: "secondary" });
	const source = new PassThrough();
	const handle = mux.createSession(pcmInput(source));
	await handle.start();
	const primaryChild = [...primary.handles][0];
	const secondaryChild = [...secondary.handles][0];
	assert.equal(await handle.pause(), true);
	assert.equal(primaryChild.state, "paused");
	assert.equal(secondaryChild.state, "paused");
	assert.equal(await handle.resume(), true);
	assert.equal(primaryChild.state, "playing");
	assert.equal(secondaryChild.state, "playing");
	assert.equal(await handle.stop(), true);
	assert.equal(primaryChild.state, "stopped");
	assert.equal(secondaryChild.state, "stopped");
	await mux.dispose();
});

test("a failed secondary sink is isolated and removed without failing the shared track", async () => {
	const primary = new TestOutputBackend({ id: "primary" });
	const secondary = new TestOutputBackend({ id: "secondary", backpressure: "bounded", maxBufferedBytes: 64 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	await mux.addBackend(secondary, { id: "secondary" });
	const source = new PassThrough();
	const handle = mux.createSession(pcmInput(source));
	const events = [];
	handle.onEvent((event) => events.push(event));
	await handle.start();
	const primaryChild = [...primary.handles][0];
	const secondaryChild = [...secondary.handles][0];
	secondaryChild.emit({ type: "error", error: new Error("simulated WebSocket close") });
	await waitFor(() => !mux.hasOutputId("secondary"));
	assert.equal(events.some((event) => event.type === "sinkError" && event.sinkId === "secondary"), true);
	assert.equal(events.some((event) => event.type === "error"), false);
	source.write(Buffer.alloc(1024, 0x55));
	await waitFor(() => Buffer.concat(primaryChild.bytes).length === 1024);
	assert.equal(handle.state, "playing");
	source.end();
	await waitFor(() => handle.state === "ended");
	await mux.dispose();
});

test("a secondary sink without a custom cap is bounded by the default 192 KiB queue", async () => {
	const primary = new TestOutputBackend({ id: "primary" });
	const secondary = new TestOutputBackend({ id: "secondary", consume: false, backpressure: "bounded", maxBufferedBytes: null });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	await mux.addBackend(secondary, { id: "secondary" });
	const source = Readable.from(Array.from({ length: 20 }, (_, i) => Buffer.alloc(32 * 1024, i)));
	const handle = mux.createSession(pcmInput(source));
	await handle.start();
	const secondaryChild = [...secondary.handles][0];
	await waitFor(() => mux.getOutput("secondary").droppedChunks > 0);
	assert.ok(secondaryChild.input.stream.readableLength <= 192 * 1024);
	assert.ok(mux.getOutput("secondary").droppedBytes > 0);
	await handle.stop();
	await mux.dispose();
});

test("a non-consuming secondary branch respects its smaller buffer cap and records dropped chunks", async () => {
	const primary = new TestOutputBackend({ id: "primary" });
	const secondary = new TestOutputBackend({ id: "secondary", consume: false, backpressure: "bounded", maxBufferedBytes: 64 * 1024 });
	const mux = new MultiAudioOutputBackend(primary, { id: "primary" });
	await mux.addBackend(secondary, { id: "secondary" });
	const source = Readable.from(Array.from({ length: 20 }, (_, i) => Buffer.alloc(32 * 1024, i)));
	const handle = mux.createSession(pcmInput(source));
	await handle.start();
	const secondaryChild = [...secondary.handles][0];
	await waitFor(() => mux.getOutput("secondary").droppedChunks > 0);
	assert.ok(secondaryChild.input.stream.readableLength <= 64 * 1024);
	assert.ok(mux.getOutput("secondary").droppedBytes > 0);
	await handle.stop();
	await mux.dispose();
});
