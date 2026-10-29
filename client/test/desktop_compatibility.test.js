import test from "node:test";
import assert from "node:assert/strict";
import { WebAudioClient, parseAudioConfig, WEB_AUDIO_PROTOCOL_VERSION } from "../browser/index.js";

class MockSocket extends EventTarget {
	constructor(url) {
		super();
		this.url = url;
		this.readyState = 0; // CONNECTING
		this.binaryType = "blob";
		this.listenerCounts = { message: 0, close: 0, error: 0, open: 0 };
	}

	addEventListener(type, listener, options) {
		super.addEventListener(type, listener, options);
		if (this.listenerCounts[type] !== undefined) {
			this.listenerCounts[type]++;
		}
	}

	removeEventListener(type, listener, options) {
		super.removeEventListener(type, listener, options);
		if (this.listenerCounts[type] !== undefined) {
			this.listenerCounts[type] = Math.max(0, this.listenerCounts[type] - 1);
		}
	}

	open() {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	close(code = 1000, reason = "") {
		this.readyState = 3;
		const event = new Event("close");
		event.code = code;
		event.reason = reason;
		this.dispatchEvent(event);
	}

	send(data) {}
}

class MockAudioWorkletNode {
	constructor(context, name, options) {
		this.context = context;
		this.name = name;
		this.options = options;
		this.port = {
			messages: [],
			postMessage(msg) {
				this.messages.push(msg);
			},
		};
	}
	connect() {}
	disconnect() {}
}

function createMockAudioContext({ state = "running", resumeError = null } = {}) {
	return {
		sampleRate: 48_000,
		state,
		destination: {},
		audioWorklet: {
			addedModules: [],
			async addModule(url) {
				this.addedModules.push(url);
			},
		},
		async resume() {
			if (resumeError) throw resumeError;
			this.state = "running";
		},
		async suspend() {
			this.state = "suspended";
		},
		async close() {
			this.state = "closed";
		},
		createBuffer(channels, length, sampleRate) {
			return { channels, length, sampleRate };
		},
		createBufferSource() {
			return {
				buffer: null,
				connect() {},
				start() {},
			};
		},
	};
}

test("Desktop WebAudioClient: AudioContext starting suspended by Autoplay policy connects and can be unlocked", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	const autoplayError = new Error("Autoplay restriction: user interaction required");
	autoplayError.name = "NotAllowedError";

	let socketInstance;
	let contextInstance;
	let suspendedDispatched = false;

	const client = new WebAudioClient({
		audioContextFactory: () => {
			contextInstance = createMockAudioContext({ state: "suspended", resumeError: autoplayError });
			return contextInstance;
		},
		webSocketFactory: (url) => {
			socketInstance = new MockSocket(url);
			queueMicrotask(() => socketInstance.open());
			return socketInstance;
		},
		analyserOptions: false,
	});

	client.addEventListener("suspended", () => {
		suspendedDispatched = true;
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-autoplay" });
		assert.equal(client.state, "connected");
		assert.equal(suspendedDispatched, true, "Should dispatch 'suspended' event on autoplay restriction");
		assert.equal(contextInstance.state, "suspended");

		// User clicks to unlock audio in Electron / Tauri
		// Clear mock error so resume can succeed
		contextInstance.resume = async () => {
			contextInstance.state = "running";
		};

		await client.unlockAudio();
		assert.equal(contextInstance.state, "running", "AudioContext should be unlocked after unlockAudio()");

		await client.resume();
		assert.equal(contextInstance.state, "running");
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: unlockAudio() called before connect() initializes and unlocks AudioContext without recreation", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let socketInstance;
	let contextInstance;
	let contextCreatedCount = 0;

	const client = new WebAudioClient({
		audioContextFactory: () => {
			contextCreatedCount++;
			contextInstance = createMockAudioContext({ state: "suspended" });
			return contextInstance;
		},
		webSocketFactory: (url) => {
			socketInstance = new MockSocket(url);
			queueMicrotask(() => socketInstance.open());
			return socketInstance;
		},
		analyserOptions: false,
	});

	try {
		// 1. Call unlockAudio() BEFORE connect()
		await client.unlockAudio();
		assert.equal(contextCreatedCount, 1, "unlockAudio() should create AudioContext if not present");
		assert.equal(contextInstance.state, "running", "unlockAudio() should resume the AudioContext");

		// 2. Call connect() - should reuse the already unlocked AudioContext
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-pre-unlocked" });
		assert.equal(client.state, "connected");
		assert.equal(contextCreatedCount, 1, "connect() must not destroy or recreate the AudioContext");
		assert.equal(client.getAudioContext(), contextInstance);
		assert.equal(contextInstance.state, "running");
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: custom workletUrl bypasses blob URL creation for strict CSP", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let addedModuleUrl = null;
	const customUrl = "https://cdn.example.com/worklet.js";

	let socketInstance;
	const client = new WebAudioClient({
		workletUrl: customUrl,
		audioContextFactory: () => {
			const ctx = createMockAudioContext();
			ctx.audioWorklet.addModule = async (url) => {
				addedModuleUrl = url;
			};
			return ctx;
		},
		webSocketFactory: (url) => {
			socketInstance = new MockSocket(url);
			queueMicrotask(() => socketInstance.open());
			return socketInstance;
		},
		analyserOptions: false,
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-worklet" });
		assert.equal(addedModuleUrl, customUrl, "Should use provided custom workletUrl directly");
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: AudioWorklet initialization failure rejects connect and releases resources", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let contextClosed = false;
	const client = new WebAudioClient({
		audioContextFactory: () => {
			const ctx = createMockAudioContext();
			ctx.audioWorklet.addModule = async () => {
				throw new Error("CSP directive script-src blocked audioWorklet.addModule");
			};
			ctx.close = async () => {
				contextClosed = true;
			};
			return ctx;
		},
		webSocketFactory: (url) => new MockSocket(url),
		analyserOptions: false,
	});

	await assert.rejects(
		() => client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-worklet-fail" }),
		/script-src blocked/,
	);

	assert.equal(contextClosed, true, "AudioContext must be closed when worklet initialization fails");
	assert.equal(client.state, "disconnected");
	globalThis.AudioWorkletNode = originalNode;
});

test("Desktop WebAudioClient: repeated connect and disconnect cycles do not leak event listeners or resources", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	const socketsCreated = [];
	const contextsCreated = [];

	const client = new WebAudioClient({
		audioContextFactory: () => {
			const ctx = createMockAudioContext();
			contextsCreated.push(ctx);
			return ctx;
		},
		webSocketFactory: (url) => {
			const sock = new MockSocket(url);
			socketsCreated.push(sock);
			queueMicrotask(() => sock.open());
			return sock;
		},
		analyserOptions: false,
	});

	try {
		for (let cycle = 0; cycle < 5; cycle++) {
			await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: `sess-cycle-${cycle}` });
			assert.equal(client.state, "connected");
			await client.disconnect();
			assert.equal(client.state, "disconnected");
		}

		assert.equal(socketsCreated.length, 5);
		for (const sock of socketsCreated) {
			assert.equal(sock.listenerCounts.message, 0, "Socket message listener should be cleaned up");
			assert.equal(sock.listenerCounts.close, 0, "Socket close listener should be cleaned up");
			assert.equal(sock.listenerCounts.error, 0, "Socket error listener should be cleaned up");
		}

		for (const ctx of contextsCreated) {
			assert.equal(ctx.state, "closed", "AudioContext should be closed on each disconnect");
		}
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: unexpected WebSocket closure cleanly resets state and dispatches close event", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let socketInstance;
	let closeEventDetail = null;

	const client = new WebAudioClient({
		audioContextFactory: () => createMockAudioContext(),
		webSocketFactory: (url) => {
			socketInstance = new MockSocket(url);
			queueMicrotask(() => socketInstance.open());
			return socketInstance;
		},
		analyserOptions: false,
	});

	client.addEventListener("close", (e) => {
		closeEventDetail = e.detail;
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-unexpected-close" });
		assert.equal(client.state, "connected");

		// Simulate unexpected drop / server restart
		socketInstance.close(1006, "Server connection dropped unexpectedly");

		// Wait for close handler to settle
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(client.state, "disconnected");
		assert.ok(closeEventDetail);
		assert.equal(closeEventDetail.code, 1006);
		assert.equal(closeEventDetail.reason, "Server connection dropped unexpectedly");
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: malformed JSON control message reports error and terminates socket", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let socketInstance;
	let errorReported = null;

	const client = new WebAudioClient({
		audioContextFactory: () => createMockAudioContext(),
		webSocketFactory: (url) => {
			socketInstance = new MockSocket(url);
			queueMicrotask(() => socketInstance.open());
			return socketInstance;
		},
		analyserOptions: false,
	});

	client.addEventListener("error", (e) => {
		errorReported = e.detail.error;
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-bad-json" });

		// Dispatch invalid JSON string
		const msgEvent = new Event("message");
		Object.defineProperty(msgEvent, "data", { value: "{ invalid-json: " });
		socketInstance.dispatchEvent(msgEvent);

		assert.ok(errorReported, "Client should dispatch error on malformed JSON message");
		assert.match(errorReported.message, /invalid JSON/i);
		assert.equal(socketInstance.readyState, 3, "Socket should be closed on protocol violation");
	} finally {
		await client.disconnect();
		globalThis.AudioWorkletNode = originalNode;
	}
});

test("Desktop WebAudioClient: application shutdown signal disconnects and clears resources", async () => {
	const originalNode = globalThis.AudioWorkletNode;
	globalThis.AudioWorkletNode = MockAudioWorkletNode;

	let socketClosed = false;
	let contextClosed = false;

	const client = new WebAudioClient({
		audioContextFactory: () => {
			const ctx = createMockAudioContext();
			ctx.close = async () => {
				contextClosed = true;
			};
			return ctx;
		},
		webSocketFactory: (url) => {
			const sock = new MockSocket(url);
			sock.close = () => {
				socketClosed = true;
			};
			queueMicrotask(() => sock.open());
			return sock;
		},
		analyserOptions: false,
	});

	await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "sess-shutdown" });
	assert.equal(client.state, "connected");

	// App shutdown (e.g. window.beforeunload or Electron will-quit)
	await client.disconnect();

	assert.equal(client.state, "disconnected");
	assert.equal(socketClosed, true);
	assert.equal(contextClosed, true);
	globalThis.AudioWorkletNode = originalNode;
});
