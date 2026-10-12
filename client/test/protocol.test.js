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

test("audio configuration validation enforces the supported wire format", () => {
	assert.equal(parseAudioConfig(config, "player-1"), config);
	assert.throws(() => parseAudioConfig({ ...config, sampleRateHz: 44_100 }), /unsupported|mismatched/i);
	assert.throws(() => parseAudioConfig(config, "another-player"), /unsupported|mismatched/i);
});

test("PCM frame decoding converts interleaved s16 and reports sequence gaps", () => {
	const decoded = decodePcmFrame(frame(4), config, 3);
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
	assert.throws(() => decodePcmFrame(invalidHeader.buffer, config), /invalid PCM/i);

	const validFrame = new Uint8Array(frame(0));
	assert.throws(() => decodePcmFrame(validFrame.slice(0, validFrame.length - 1).buffer, config), /invalid PCM/i);
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
	const decoded = decodeOpusFrame(arrayBuffer, { codec: "opus" }, 5);
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
