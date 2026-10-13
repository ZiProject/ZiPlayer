import assert from "node:assert/strict";
import test from "node:test";
import { decodePcmFrame, decodeOpusFrame, parseAudioConfig, OpusDecoderAdapter, WebAudioClient } from "../browser/index.js";

const config = {
	v: 1,
	type: "audio:config",
	sessionId: "player-1",
	protocolVersion: 1,
	sampleRateHz: 48_000,
	channels: 2,
	sampleFormat: "s16",
	endianness: "little",
	channelLayout: "interleaved",
};

function frame(sequence, values = [16384, -16384]) {
	const payload = Buffer.alloc(values.length * 2);
	values.forEach((value, index) => payload.writeInt16LE(value, index * 2));
	const header = Buffer.alloc(16);
	header.writeUInt32LE(sequence, 0);
	header.writeUInt32LE(1234, 4);
	header.writeUInt16LE(48_000, 8);
	header.writeUInt16LE(2, 10);
	header.writeUInt16LE(2, 12);
	const packet = Buffer.concat([header, payload]);
	return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
}

const legacyConfig = { ...config, protocolVersion: 0 };

test("audio configuration validation enforces the supported wire format", () => {
	assert.deepEqual(parseAudioConfig(config, "player-1"), config);
	assert.throws(() => parseAudioConfig({ ...config, sampleRateHz: 44_100 }), /unsupported|mismatched/i);
	assert.throws(() => parseAudioConfig(config, "another-player"), /unsupported|mismatched/i);
});

test("PCM frame decoding converts interleaved s16 and reports sequence gaps", () => {
	const decoded = decodePcmFrame(frame(4), legacyConfig, 3);
	assert.equal(decoded.sequence, 4);
	assert.equal(decoded.timestampMs, 1234);
	assert.equal(decoded.sequenceGap, true);
	assert.equal(decoded.samples.length, 2);
	assert.ok(Math.abs(decoded.samples[0] - 16384 / 32767) < 1e-7);
	assert.equal(decoded.samples[1], -0.5);
	assert.ok(Math.abs(decoded.peak - 16384 / 32767) < 1e-7);
	assert.equal(decoded.payload.byteLength, 4);
});

test("PCM frame decoder rejects invalid headers and unaligned payloads", () => {
	const invalidHeader = new Uint8Array(frame(0));
	new DataView(invalidHeader.buffer).setUint16(8, 44_100, true);
	assert.throws(() => decodePcmFrame(invalidHeader.buffer, legacyConfig), /invalid PCM/i);

	const validFrame = new Uint8Array(frame(0));
	assert.throws(() => decodePcmFrame(validFrame.slice(0, validFrame.length - 1).buffer, legacyConfig), /invalid PCM/i);
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
	assert.throws(() => decodePcmFrame(frame(1), normalized), /missing 'ZI'/i);

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
	const legacyArrayBuffer = legacyFrame.buffer.slice(
		legacyFrame.byteOffset,
		legacyFrame.byteOffset + legacyFrame.byteLength,
	);
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

test("Wire Format v1 PCM frame decoding parses magic 'ZI', sequence BE, and timestampUs", () => {
	const values = [16384, -16384];
	const payload = Buffer.alloc(values.length * 2);
	values.forEach((value, index) => payload.writeInt16LE(value, index * 2));
	const buf = Buffer.alloc(16 + payload.length);
	buf[0] = 0x5a; // 'Z'
	buf[1] = 0x49; // 'I'
	buf[2] = 0x01; // Version 1
	buf[3] = 0x00; // Flags: bit 0 = 0 (PCM16LE)
	buf.writeUInt32BE(7, 4); // Sequence Big-Endian
	buf.writeBigUInt64BE(140_000n, 8); // 140,000 microseconds = 140 ms
	payload.copy(buf, 16);

	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const decoded = decodePcmFrame(arrayBuffer, config, 7);
	assert.equal(decoded.sequence, 7);
	assert.equal(decoded.timestampMs, 140);
	assert.equal(decoded.timestampUs, 140_000n);
	assert.equal(decoded.sequenceGap, false);
	assert.equal(decoded.samples.length, 2);
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
	const legacyPcmFrame = frame(1);
	// v1 PCM config
	assert.throws(() => decodePcmFrame(legacyPcmFrame, config), /missing 'ZI'/i);

	// v1 Opus config
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

	// PCM frame flags must be strictly 0x00; reserved bits (0x01, 0x02, 0x80) must be rejected
	const pcmPayload = Buffer.alloc(4); // 1 sample frame
	const pcmHeader = Buffer.alloc(16);
	pcmHeader[0] = 0x5a;
	pcmHeader[1] = 0x49;
	pcmHeader[2] = 1;
	pcmHeader[3] = 0x00; // PCM flag
	for (const badFlags of [0x01, 0x02, 0x80, 0xff]) {
		const badPcmBuf = Buffer.concat([pcmHeader, pcmPayload]);
		badPcmBuf[3] = badFlags;
		const arrayBuf = badPcmBuf.buffer.slice(badPcmBuf.byteOffset, badPcmBuf.byteOffset + badPcmBuf.byteLength);
		assert.throws(() => decodePcmFrame(arrayBuf, { sampleRateHz: 48000, channels: 2 }), /Expected PCM frame flag/i);
	}
});

test("parseAudioConfig rejects unsupported or unknown codecs instead of interpreting as PCM", () => {
	for (const badCodec of ["aac", "vorbis", "flac", "mp3", "unknown"]) {
		assert.throws(() => parseAudioConfig({ ...config, codec: badCodec }), /unsupported audio configuration/i);
	}
});
