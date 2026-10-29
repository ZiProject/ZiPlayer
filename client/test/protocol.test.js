import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeOpusFrame,
	parseAudioConfig,
	OpusDecoderAdapter,
	WebAudioClient,
	getFrequencyBands,
	getBassEnergy,
} from "../browser/index.js";

const config = {
	v: 1,
	type: "audio:config",
	sessionId: "player-1",
	protocolVersion: 1,
	codec: "opus",
	sampleRateHz: 48_000,
	channels: 2,
};

test("audio configuration validation accepts Opus and rejects PCM publishers", () => {
	assert.deepEqual(parseAudioConfig(config, "player-1"), config);
	assert.throws(() => parseAudioConfig({ ...config, sampleRateHz: 44_100 }), /unsupported|mismatched/i);
	assert.throws(() => parseAudioConfig(config, "another-player"), /unsupported|mismatched/i);
	assert.throws(
		() =>
			parseAudioConfig({
				...config,
				codec: "pcm16le",
			}),
		/unsupported audio configuration/i,
	);
});

test("WebAudioClient can connect to a gateway that does not require a token", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	let socketUrl;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: (url) => {
			socketUrl = url;
			const socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});
	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "player-1" });
		assert.equal(socketUrl.searchParams.get("sessionId"), "player-1");
		assert.equal(socketUrl.searchParams.has("token"), false);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("WebAudioClient receives audio configuration sent immediately after WebSocket authentication", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			const socket = new FakeSocket();
			socket.addEventListener(
				"open",
				() => {
					const event = new Event("message");
					Object.defineProperty(event, "data", { value: JSON.stringify(config) });
					socket.dispatchEvent(event);
				},
				{ once: true },
			);
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: config.sessionId });
		assert.deepEqual(client.config, config);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("WebAudioClient decodes Opus into worklet audio and dispatches PCM before transferring samples", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	let socket;
	let queuedSamples;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = {
			postMessage(message, transfer = []) {
				const copiedMessage = structuredClone(message, { transfer });
				if (copiedMessage.type === "pcm") queuedSamples = copiedMessage.samples;
			},
		};
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
		opusDecoderFactory: async () => ({
			async initialize() {},
			decode() {
				const samples = new Float32Array(1920).fill(0.25);
				return { samples, samplesDecoded: 960, peak: 0.25 };
			},
			free() {},
		}),
	});
	let receivedSampleLength = 0;
	client.addEventListener("pcm", ({ detail }) => {
		receivedSampleLength = detail.samples.length;
	});
	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "opus-player" });
		const sendMessage = (data) => {
			const event = new Event("message");
			Object.defineProperty(event, "data", { value: data });
			socket.dispatchEvent(event);
		};
		sendMessage(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "opus-player",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		await new Promise((resolve) => setImmediate(resolve));
		const frame = new ArrayBuffer(20);
		const view = new DataView(frame);
		view.setUint8(0, 0x5a);
		view.setUint8(1, 0x49);
		view.setUint8(2, 1);
		view.setUint8(3, 1);
		view.setUint32(4, 0, false);
		view.setBigUint64(8, 0n, false);
		new Uint8Array(frame).set([0xf8, 0xff, 0xfe, 0], 16);
		sendMessage(frame);

		assert.equal(receivedSampleLength, 1920);
		assert.equal(queuedSamples.length, 1920);
		assert.equal(queuedSamples[0], 0.25);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("Opus audio configuration validation", () => {
	const opusConfig = {
		v: 1,
		type: "audio:config",
		sessionId: "opus-player",
		protocolVersion: 1,
		codec: "opus",
		sampleRateHz: 48_000,
		channels: 2,
	};
	assert.equal(parseAudioConfig(opusConfig, "opus-player").codec, "opus");
	assert.throws(() => parseAudioConfig({ ...opusConfig, sampleRateHz: 44_100 }), /unsupported/i);
	assert.throws(() => parseAudioConfig({ ...opusConfig, channels: 1 }), /unsupported/i);
});

test("audio config defaults omitted protocolVersion to v1 and only enables legacy frames for explicit v0", () => {
	const omittedVersion = { ...config };
	delete omittedVersion.protocolVersion;
	const normalized = parseAudioConfig(omittedVersion);
	assert.equal(normalized.protocolVersion, 1);

	const omittedOpusVersion = {
		v: 1,
		type: "audio:config",
		sessionId: "opus-player",
		codec: "opus",
	};
	assert.equal(parseAudioConfig(omittedOpusVersion).protocolVersion, 1);
	const legacyFrame = Buffer.alloc(20);
	legacyFrame.writeUInt32LE(3, 0);
	legacyFrame.writeUInt32LE(100, 4);
	legacyFrame.writeUInt16LE(20, 12);
	legacyFrame.set([0xf8, 0xff, 0xfe, 0x01], 16);
	const legacyArrayBuffer = legacyFrame.buffer.slice(legacyFrame.byteOffset, legacyFrame.byteOffset + legacyFrame.byteLength);
	assert.throws(() => decodeOpusFrame(legacyArrayBuffer, parseAudioConfig(omittedOpusVersion)), /missing 'ZI'/i);
	assert.equal(decodeOpusFrame(legacyArrayBuffer, { codec: "opus", protocolVersion: 0 }).sequence, 3);
});

test("Opus frame decoding extracts payload and handles WebAudioOpusFrame magic", () => {
	const buf = Buffer.alloc(16 + 6);
	buf.writeUInt16LE(0x4f50, 0); // magic
	buf.writeUInt16LE(0, 2); // codecId
	buf.writeUInt32LE(5, 4); // sequence
	buf.writeUInt32LE(100, 8); // timestampMs
	buf.writeUInt16LE(20, 12); // durationMs
	buf.writeUInt16LE(6, 14); // payloadLength
	buf.set([0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03], 16);

	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const decoded = decodeOpusFrame(arrayBuffer, { codec: "opus", protocolVersion: 0 }, 5);
	assert.equal(decoded.sequence, 5);
	assert.equal(decoded.timestampMs, 100);
	assert.equal(decoded.frameDurationMs, 20);
	assert.equal(decoded.sequenceGap, false);
	assert.equal(decoded.payload.byteLength, 6);
	assert.deepEqual(Array.from(decoded.payload), [0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03]);
});

test("OpusDecoderAdapter decodes Opus frame to interleaved stereo Float32Array", async () => {
	const adapter = new OpusDecoderAdapter({ sampleRate: 48000, channels: 2 });
	await adapter.initialize();
	const packet = new Uint8Array([0xf8, 0xff, 0xfe]);
	try {
		const result = adapter.decode(packet);
		assert.ok(result.samples instanceof Float32Array);
		assert.equal(result.samplesDecoded, 960);
		assert.equal(result.samples.length, 960 * 2);
	} finally {
		adapter.free();
	}
});

test("Wire Format v1 Opus frame decoding parses magic 'ZI', sequence BE, and timestampUs", () => {
	const payload = [0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03];
	const buf = Buffer.alloc(16 + payload.length);
	buf[0] = 0x5a; // 'Z'
	buf[1] = 0x49; // 'I'
	buf[2] = 0x01; // Version 1
	buf[3] = 0x01; // Flags: bit 0 = 1 (Opus)
	buf.writeUInt32BE(42, 4); // Sequence Big-Endian
	buf.writeBigUInt64BE(840_000n, 8); // 840,000 microseconds = 840 ms
	buf.set(payload, 16);

	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const decoded = decodeOpusFrame(arrayBuffer, { codec: "opus" }, 42);
	assert.equal(decoded.sequence, 42);
	assert.equal(decoded.timestampMs, 840);
	assert.equal(decoded.timestampUs, 840_000n);
	assert.equal(decoded.frameDurationMs, 20);
	assert.equal(decoded.sequenceGap, false);
	assert.deepEqual(Array.from(decoded.payload), payload);
});

test("WebAudioClient buffers Opus packets received before WASM decoder initialization completes", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	const postedWorkletMessages = [];
	class FakeAudioWorkletNode {
		port = {
			postMessage(msg) {
				postedWorkletMessages.push(msg);
			},
		};
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;

	let resolveInit;
	const initPromise = new Promise((resolve) => {
		resolveInit = resolve;
	});

	let decodeCalls = 0;
	class MockOpusDecoder {
		async initialize() {
			await initPromise;
		}
		decode(payload) {
			decodeCalls++;
			return {
				samples: new Float32Array(960 * 2),
				peak: 0.5,
			};
		}
		reset() {}
		free() {}
	}

	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		opusDecoderFactory: () => new MockOpusDecoder(),
	});

	try {
		await client.createAudioOutput();

		// Receive audio:config with opus
		client.receiveControlMessage(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "async-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);

		// Immediately receive an Opus frame before WASM initializes
		const payload = [0xf8, 0xff, 0xfe, 0x01];
		const buf = Buffer.alloc(16 + payload.length);
		buf[0] = 0x5a; // 'Z'
		buf[1] = 0x49; // 'I'
		buf[2] = 0x01; // Version 1
		buf[3] = 0x01; // Opus flag
		buf.writeUInt32BE(0, 4);
		buf.writeBigUInt64BE(0n, 8);
		buf.set(payload, 16);
		const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

		let pcmEventFired = false;
		client.addEventListener("pcm", () => {
			pcmEventFired = true;
		});

		// Send frame immediately - must NOT throw or drop
		assert.doesNotThrow(() => {
			client.receiveOpusFrame(arrayBuf);
		});

		// Before WASM is ready, decoder.decode() has NOT been called yet
		assert.equal(decodeCalls, 0);
		assert.equal(pcmEventFired, false);

		// Now complete WASM decoder initialization
		resolveInit();
		await new Promise((resolve) => queueMicrotask(resolve));
		await new Promise((resolve) => setTimeout(resolve, 10));

		// After initialization finishes, buffered packet was drained and decoded
		assert.equal(decodeCalls, 1);
		assert.equal(pcmEventFired, true);
		assert.ok(postedWorkletMessages.some((msg) => msg.type === "pcm"));
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("Decoder strictly enforces Wire Format v1 when negotiated and does not downgrade to legacy", () => {
	const opusV1Config = { codec: "opus", protocolVersion: 1 };
	const legacyOpusBuf = Buffer.alloc(16 + 4);
	legacyOpusBuf.writeUInt16LE(0x4f50, 0);
	legacyOpusBuf.set([0xf8, 0xff, 0xfe, 0x01], 16);
	const legacyOpusArray = legacyOpusBuf.buffer.slice(
		legacyOpusBuf.byteOffset,
		legacyOpusBuf.byteOffset + legacyOpusBuf.byteLength,
	);

	assert.throws(() => decodeOpusFrame(legacyOpusArray, opusV1Config), /missing 'ZI'/i);
});

test("Decoder strictly enforces flags and protocol version in Wire Format v1", () => {
	const validPayload = Buffer.from([0xf8, 0xff, 0xfe, 0x01]);
	const header = Buffer.alloc(16);
	header[0] = 0x5a;
	header[1] = 0x49;
	header[2] = 1; // version 1
	header[3] = 0x01; // Opus flag
	header.writeUInt32BE(0, 4);
	header.writeBigUInt64BE(0n, 8);

	// Reserved bits in Opus frame (0x03, 0x81, 0xfe) must be rejected
	for (const badFlags of [0x00, 0x03, 0x81, 0xfe]) {
		const badBuf = Buffer.concat([header, validPayload]);
		badBuf[3] = badFlags;
		const arrayBuf = badBuf.buffer.slice(badBuf.byteOffset, badBuf.byteOffset + badBuf.byteLength);
		assert.throws(() => decodeOpusFrame(arrayBuf, { codec: "opus" }), /Expected Opus frame flag/i);
	}

	// Unsupported version in Opus frame (version != 1) must be rejected
	const badVersionBuf = Buffer.concat([header, validPayload]);
	badVersionBuf[2] = 2;
	const badVersionArray = badVersionBuf.buffer.slice(
		badVersionBuf.byteOffset,
		badVersionBuf.byteOffset + badVersionBuf.byteLength,
	);
	assert.throws(() => decodeOpusFrame(badVersionArray, { codec: "opus" }), /Unsupported audio frame protocol version/i);

	const pcmHeader = Buffer.alloc(20);
	pcmHeader.set([0x5a, 0x49, 1, 0x00], 0);
	assert.throws(() => decodeOpusFrame(pcmHeader.buffer, { codec: "opus" }), /Expected Opus frame flag/i);
});

test("parseAudioConfig rejects unsupported or unknown codecs instead of interpreting as PCM", () => {
	for (const badCodec of ["aac", "vorbis", "flac", "mp3", "unknown"]) {
		assert.throws(() => parseAudioConfig({ ...config, codec: badCodec }), /unsupported audio configuration/i);
	}
});

test("WebAudioClient creates AnalyserNode and connects worklet -> analyser -> destination by default", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	let connectedNode = null;
	let analyserConnectedTo = null;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect(target) {
			connectedNode = target;
		}
		disconnect() {}
	}
	class FakeAnalyserNode {
		fftSize = 2048;
		smoothingTimeConstant = 0.8;
		minDecibels = -100;
		maxDecibels = -30;
		connect(target) {
			analyserConnectedTo = target;
		}
		disconnect() {
			this.disconnected = true;
		}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const fakeDestination = { id: "audio-destination" };
	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: fakeDestination,
			audioWorklet: { async addModule() {} },
			createAnalyser: () => new FakeAnalyserNode(),
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			const socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "analyser-test" });
		assert.ok(client.analyser instanceof FakeAnalyserNode);
		assert.equal(client.getAnalyser(), client.analyser);
		assert.ok(client.audioContext);
		assert.equal(client.getAudioContext(), client.audioContext);
		assert.equal(connectedNode, client.analyser);
		assert.equal(analyserConnectedTo, fakeDestination);
		assert.equal(client.analyser.fftSize, 2048);
	} finally {
		const analyser = client.analyser;
		await client.disconnect();
		assert.equal(client.analyser, null);
		assert.equal(client.getAnalyser(), null);
		assert.equal(client.audioContext, null);
		assert.equal(analyser.disconnected, true);
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("WebAudioClient customizes AnalyserNode via analyserOptions", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect() {}
		disconnect() {}
	}
	class FakeAnalyserNode {
		fftSize = 2048;
		smoothingTimeConstant = 0.8;
		minDecibels = -100;
		maxDecibels = -30;
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const client = new WebAudioClient({
		analyserOptions: {
			fftSize: 256,
			smoothingTimeConstant: 0.85,
			minDecibels: -90,
			maxDecibels: -10,
		},
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			createAnalyser: () => new FakeAnalyserNode(),
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			const socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "analyser-opts" });
		assert.equal(client.analyser.fftSize, 256);
		assert.equal(client.analyser.smoothingTimeConstant, 0.85);
		assert.equal(client.analyser.minDecibels, -90);
		assert.equal(client.analyser.maxDecibels, -10);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("WebAudioClient skips AnalyserNode when analyserOptions is false", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	let connectedNode = null;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect(target) {
			connectedNode = target;
		}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const fakeDestination = { id: "dest-only" };
	const client = new WebAudioClient({
		analyserOptions: false,
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: fakeDestination,
			audioWorklet: { async addModule() {} },
			createAnalyser: () => {
				throw new Error("createAnalyser should not be called when analyserOptions is false");
			},
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			const socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});

	try {
		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "no-analyser" });
		assert.equal(client.analyser, null);
		assert.equal(connectedNode, fakeDestination);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});

test("WebAudioClient validates analyserOptions parameter types", () => {
	assert.throws(() => new WebAudioClient({ analyserOptions: "invalid" }), /analyserOptions must be an object or false/i);
	assert.throws(() => new WebAudioClient({ analyserOptions: 123 }), /analyserOptions must be an object or false/i);
});

test("getFrequencyBands validates source and option types", () => {
	assert.throws(() => getFrequencyBands(null), /source must be an AnalyserNode or a Uint8Array/i);
	assert.throws(() => getFrequencyBands(new Uint8Array(10), { bands: 0 }), /bands must be a positive integer/i);
	assert.throws(() => getFrequencyBands(new Uint8Array(10), { minHz: -5 }), /minHz must be a positive number/i);
	assert.throws(
		() => getFrequencyBands(new Uint8Array(10), { minHz: 1000, maxHz: 500 }),
		/maxHz must be a finite number greater than minHz/i,
	);
});

test("getFrequencyBands calculates smoothed normalized bands from Uint8Array", () => {
	const binCount = 1024;
	const dummyFreq = new Uint8Array(binCount);
	// Fill with synthetic signal: sub-bass peak and mid peak
	dummyFreq[2] = 200; // ~46 Hz
	dummyFreq[3] = 220; // ~70 Hz
	dummyFreq[50] = 180; // ~1170 Hz

	const bands = getFrequencyBands(dummyFreq, {
		bands: 16,
		sampleRate: 48000,
	});

	assert.equal(bands.length, 16);
	for (let i = 0; i < bands.length; i++) {
		assert.ok(bands[i] >= 0 && bands[i] <= 1, `Band ${i} must be in [0, 1] range`);
	}
	// Bass bands should have substantial energy
	assert.ok(bands[0] > 0 || bands[1] > 0);
});

test("getBassEnergy computes normalized sub-bass and kick drum energy", () => {
	const dummyFreq = new Uint8Array(1024);
	// Sub-bass bins: 45Hz to 120Hz at 48kHz (resolution 23.4Hz) corresponds to bins 2..5
	dummyFreq[2] = 255;
	dummyFreq[3] = 255;
	dummyFreq[4] = 255;
	dummyFreq[5] = 255;

	const energy = getBassEnergy(dummyFreq, { sampleRate: 48000, minHz: 45, maxHz: 120 });
	assert.ok(energy > 0.9, `Bass energy should be near 1.0, got ${energy}`);

	const emptyEnergy = getBassEnergy(new Uint8Array(1024));
	assert.equal(emptyEnergy, 0);
});

test("WebAudioClient getFrequencyBands and getBassEnergy delegates to active AnalyserNode", async () => {
	const originalAudioWorkletNode = globalThis.AudioWorkletNode;
	class FakeSocket extends EventTarget {
		readyState = 1;
		binaryType = "";
		close() {
			this.readyState = 3;
		}
	}
	class FakeAudioWorkletNode {
		port = { postMessage() {} };
		connect() {}
		disconnect() {}
	}
	class FakeAnalyserNode {
		fftSize = 2048;
		frequencyBinCount = 1024;
		smoothingTimeConstant = 0.65;
		minDecibels = -85;
		maxDecibels = -10;
		getByteFrequencyData(array) {
			array.fill(128);
		}
		connect() {}
		disconnect() {}
	}
	globalThis.AudioWorkletNode = FakeAudioWorkletNode;
	const client = new WebAudioClient({
		audioContextFactory: () => ({
			sampleRate: 48_000,
			state: "running",
			destination: {},
			audioWorklet: { async addModule() {} },
			createAnalyser: () => new FakeAnalyserNode(),
			async resume() {},
			async close() {
				this.state = "closed";
			},
		}),
		webSocketFactory: () => {
			const socket = new FakeSocket();
			queueMicrotask(() => socket.dispatchEvent(new Event("open")));
			return socket;
		},
	});

	try {
		assert.equal(client.getFrequencyBands(), null);
		assert.equal(client.getBassEnergy(), 0);

		await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "helper-test" });

		const bands = client.getFrequencyBands({ bands: 32 });
		assert.ok(bands instanceof Float32Array);
		assert.equal(bands.length, 32);

		const bass = client.getBassEnergy();
		assert.ok(bass > 0 && bass <= 1);
	} finally {
		await client.disconnect();
		if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
		else globalThis.AudioWorkletNode = originalAudioWorkletNode;
	}
});
