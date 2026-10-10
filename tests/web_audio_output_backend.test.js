const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
	WebSocketAudioOutputBackend,
	encodeWebAudioFrame,
	decodeWebAudioFrame,
	WEB_AUDIO_PROTOCOL_VERSION,
} = require("../core/dist");

const pcmFormat = {
	kind: "pcm",
	sampleFormat: "s16",
	endianness: "little",
	sampleRateHz: 48_000,
	channels: 2,
	channelLayout: "interleaved",
};

function makeSocket() {
	const listeners = new Map();
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		close() {
			this.readyState = 3;
			this.closed = true;
			for (const listener of listeners.get("close") ?? []) listener({});
		},
		addEventListener(type, listener) {
			const entries = listeners.get(type) ?? new Set();
			entries.add(listener);
			listeners.set(type, entries);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		send(data) {
			this.sent.push({ data, sentAt: Date.now() });
		},
	};
}

const messageData = (message) => message.data;
const binaryMessages = (socket) => socket.sent.map(messageData).filter((value) => typeof value !== "string");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("web protocol frame encoding preserves sequence metadata", () => {
	const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
	const encoded = encodeWebAudioFrame(payload, 12, 1234);
	const decoded = decodeWebAudioFrame(new Uint8Array(encoded));
	assert.equal(decoded.sequence, 12);
	assert.equal(decoded.timestampMs, 1234);
	assert.equal(decoded.payload.length, payload.length);
	assert.deepEqual([...decoded.payload], [...payload]);
	assert.equal(decoded.payload.byteLength, payload.length);
});

test("web backend accepts valid PCM sessions and emits config plus payload frames", async () => {
	const socket = makeSocket();
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(8)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	await handle.start();
	await handle.completion;
	const config = socket.sent.map(messageData).find((value) => typeof value === "string");
	assert.ok(config !== undefined);
	const parsed = JSON.parse(config);
	assert.equal(parsed.v, WEB_AUDIO_PROTOCOL_VERSION);
	assert.equal(parsed.type, "audio:config");
	assert.equal(parsed.sessionId, handle.resource.sessionId);
	const binary = socket.sent.map(messageData).find((value) => typeof value !== "string");
	assert.ok(binary);
	const frame = decodeWebAudioFrame(new Uint8Array(binary));
	assert.equal(frame.payload.length, 8);
	assert.equal(frame.sequence, 0);
	await handle.dispose();
	assert.equal(socket.closed, true);
	await backend.dispose();
});

test("web backend paces PCM frames at the configured sample rate", async () => {
	const socket = makeSocket();
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(2 * 3840)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	await handle.start();
	await handle.completion;
	const binaryMessages = socket.sent.filter((message) => typeof message.data !== "string");
	assert.equal(binaryMessages.length, 2);
	assert.ok(binaryMessages[1].sentAt - binaryMessages[0].sentAt >= 15);
	await backend.dispose();
});

test("web backend rejects unsupported PCM formats and invalid ownership modes", () => {
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => makeSocket() });
	assert.throws(
		() =>
			backend.createSession({
				stream: Readable.from([]),
				format: { kind: "encoded", codec: "opus" },
				ownership: "transfer",
			}),
		/PCM/i,
	);
	assert.throws(
		() =>
			backend.createSession({
				stream: Readable.from([]),
				format: pcmFormat,
				ownership: "invalid",
			}),
		/ownership/i,
	);
});

test("web backend can retain a stable routing session ID across track handles", async () => {
	const backend = new WebSocketAudioOutputBackend({ sessionId: "player-1", socketFactory: () => makeSocket() });
	const createTrack = () =>
		backend.createSession({
			stream: Readable.from([]),
			format: pcmFormat,
			ownership: "transfer",
		});
	const first = createTrack();
	const next = createTrack();
	assert.equal(first.resource.sessionId, "player-1");
	assert.equal(next.resource.sessionId, first.resource.sessionId);
	await first.dispose();
	await next.dispose();
	await backend.dispose();
	assert.throws(() => new WebSocketAudioOutputBackend({ sessionId: "" }), /sessionId/i);
});

test("web backend streams beyond its transport buffer limit without a cumulative counter failure", async () => {
	const socket = makeSocket();
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const startedAt = performance.now();
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(300 * 1024)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	await handle.start();
	await handle.completion;
	assert.equal(handle.state, "ended");
	assert.ok(binaryMessages(socket).length > 1);
	assert.ok(performance.now() - startedAt < 2200, "PCM pacing should not accumulate per-frame timer delays");
	assert.equal(handle.bufferedBytes, 0);
	await backend.dispose();
});

test("web backend pauses reading and sending PCM until resumed", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "borrow" });
	stream.push(Buffer.alloc(3840));
	const started = handle.start();
	await started;
	await wait(20);
	assert.equal(binaryMessages(socket).length, 1);
	assert.equal(handle.pause(), true);
	stream.push(Buffer.alloc(3840));
	await wait(20);
	assert.equal(binaryMessages(socket).length, 1);
	assert.equal(handle.resume(), true);
	stream.push(null);
	await handle.completion;
	assert.equal(binaryMessages(socket).length, 2);
	await backend.dispose();
});

test("web backend stop cancels a borrowed stream without destroying it or sending later PCM", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "borrow" });
	await handle.start();
	await wait(20);
	assert.equal(handle.stop(), true);
	stream.push(Buffer.alloc(3840));
	await handle.completion;
	await wait(10);
	assert.equal(stream.destroyed, false);
	assert.equal(binaryMessages(socket).length, 0);
	await backend.dispose();
});

test("web backend waits for WebSocket bufferedAmount to fall before sending", async () => {
	const socket = makeSocket();
	socket.bufferedAmount = 4096;
	const backend = new WebSocketAudioOutputBackend({
		socketFactory: () => socket,
		maxBufferedBytes: 4096,
	});
	const handle = backend.createSession({
		stream: Readable.from([Buffer.alloc(3840)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	await handle.start();
	let completed = false;
	const completion = handle.completion.then(() => {
		completed = true;
	});
	await wait(30);
	assert.equal(binaryMessages(socket).length, 0);
	assert.equal(completed, false);
	socket.bufferedAmount = 0;
	await completion;
	assert.equal(binaryMessages(socket).length, 1);
	await backend.dispose();
});

test("web backend start resolves once a live session is ready", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "borrow" });
	await Promise.race([
		handle.start(),
		wait(100).then(() => {
			throw new Error("start waited for the live stream to finish");
		}),
	]);
	assert.equal(handle.state, "playing");
	assert.equal(typeof handle.completion.then, "function");
	handle.stop();
	await handle.completion;
	await backend.dispose();
});

test("web backend replacement stops and disposes the old session before starting the new one", async () => {
	const sockets = [];
	const backend = new WebSocketAudioOutputBackend({
		socketFactory: () => {
			const socket = makeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	const old = backend.createSession({
		stream: new Readable({ read() {} }),
		format: pcmFormat,
		ownership: "borrow",
	});
	await old.start();
	const replacement = await old.replace({
		stream: Readable.from([Buffer.alloc(3840)]),
		format: pcmFormat,
		ownership: "transfer",
	});
	assert.equal(backend.capabilities.replacement, "stop-before-start");
	assert.equal(old.disposedState, true);
	assert.equal(sockets[0].closed, true);
	assert.notEqual(replacement.resource.id, old.resource.id);
	await replacement.completion;
	await backend.dispose();
});

test("web backend unregisters disposed sessions exactly once", async () => {
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => makeSocket() });
	const first = backend.createSession({
		stream: Readable.from([]),
		format: pcmFormat,
		ownership: "transfer",
	});
	const second = backend.createSession({
		stream: Readable.from([]),
		format: pcmFormat,
		ownership: "transfer",
	});
	assert.equal(backend.sessions.size, 2);
	await first.dispose();
	assert.equal(backend.sessions.size, 1);
	await first.dispose();
	assert.equal(backend.sessions.size, 1);
	await second.dispose();
	assert.equal(backend.sessions.size, 0);
	await backend.dispose();
});

test("web backend declares volume unsupported", async () => {
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => makeSocket() });
	const handle = backend.createSession({
		stream: Readable.from([]),
		format: pcmFormat,
		ownership: "transfer",
	});
	assert.equal(backend.capabilities.volume, "unsupported");
	assert.throws(() => handle.setVolume(0.5), /volume control/i);
	await backend.dispose();
});

test("web backend does not report pause success when control send fails", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "borrow" });
	await handle.start();
	socket.send = (data) => {
		if (typeof data === "string" && JSON.parse(data).type === "playback:pause") {
			throw new Error("pause send failed");
		}
		socket.sent.push(data);
	};
	assert.equal(handle.pause(), false);
	assert.equal(handle.state, "failed");
	await handle.completion;
	assert.equal(stream.destroyed, false);
	await backend.dispose();
});

test("web backend does not report stop success when the transport is closed", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "borrow" });
	await handle.start();
	socket.readyState = 3;
	assert.equal(handle.stop(), false);
	assert.equal(handle.state, "failed");
	assert.equal(stream.destroyed, false);
	await handle.completion;
	await backend.dispose();
});

test("web backend rejects float PCM formats", () => {
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => makeSocket() });
	assert.throws(
		() =>
			backend.createSession({
				stream: Readable.from([]),
				format: { ...pcmFormat, sampleFormat: "f32" },
				ownership: "transfer",
			}),
		/16-bit/i,
	);
});

test("web backend abort destroys transferred input and closes the socket", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const controller = new AbortController();
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "transfer" }, { signal: controller.signal });
	await handle.start();
	await wait(20);
	controller.abort();
	await handle.completion;
	assert.equal(stream.destroyed, true);
	assert.equal(socket.closed, true);
	await backend.dispose();
});

test("web backend closes a socket that resolves after startup was aborted", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const controller = new AbortController();
	let resolveSocket;
	const backend = new WebSocketAudioOutputBackend({
		socketFactory: () => new Promise((resolve) => (resolveSocket = resolve)),
	});
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "transfer" }, { signal: controller.signal });
	const started = handle.start();
	await wait(10);
	controller.abort();
	resolveSocket(socket);
	await assert.rejects(started, { name: "AbortError" });
	assert.equal(socket.closed, true);
	assert.equal(stream.destroyed, true);
	await backend.dispose();
});

test("web backend cleans up transferred input when initial configuration send fails", async () => {
	const socket = makeSocket();
	socket.send = () => {
		throw new Error("socket send failed");
	};
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "transfer" });
	await assert.rejects(handle.start(), /socket send failed/);
	assert.equal(stream.destroyed, true);
	assert.equal(socket.closed, true);
	assert.equal(handle.state, "failed");
	await backend.dispose();
});

test("web backend stops consuming transferred input after WebSocket disconnect", async () => {
	const socket = makeSocket();
	const stream = new Readable({ read() {} });
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => socket });
	const handle = backend.createSession({ stream, format: pcmFormat, ownership: "transfer" });
	await handle.start();
	await wait(20);
	socket.close();
	await handle.completion;
	assert.equal(stream.destroyed, true);
	assert.equal(handle.state, "failed");
	assert.equal(binaryMessages(socket).length, 0);
	await backend.dispose();
});
