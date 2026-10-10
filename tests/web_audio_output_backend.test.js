const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
	WebSocketAudioOutputBackend,
	encodeWebAudioFrame,
	decodeWebAudioFrame,
	WEB_AUDIO_PROTOCOL_VERSION,
}
	= require("../core/dist");

const pcmFormat = {
	kind: "pcm",
	sampleFormat: "s16",
	endianness: "little",
	sampleRateHz: 48_000,
	channels: 2,
	channelLayout: "interleaved",
};

function makeSocket() {
	return {
		readyState: 1,
		sent: [],
		close() {
			this.readyState = 3;
			this.closed = true;
		},
		send(data) {
			this.sent.push(data);
		},
	};
}

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
	const config = socket.sent.find((value) => typeof value === "string");
	assert.ok(config !== undefined);
	const parsed = JSON.parse(config);
	assert.equal(parsed.v, WEB_AUDIO_PROTOCOL_VERSION);
	assert.equal(parsed.type, "audio:config");
	assert.equal(parsed.sessionId, handle.resource.sessionId);
	const binary = socket.sent.find((value) => typeof value !== "string");
	assert.ok(binary);
	const frame = decodeWebAudioFrame(new Uint8Array(binary));
	assert.equal(frame.payload.length, 4);
	assert.equal(frame.sequence, 0);
	await handle.dispose();
	assert.equal(socket.closed, true);
	await backend.dispose();
});

test("web backend rejects unsupported PCM formats and invalid ownership modes", () => {
	const backend = new WebSocketAudioOutputBackend({ socketFactory: () => makeSocket() });
	assert.throws(() =>
		backend.createSession({
			stream: Readable.from([]),
			format: { kind: "encoded", codec: "opus" },
			ownership: "transfer",
		}),
	/PCM/i,
	);
	assert.throws(() =>
		backend.createSession({
			stream: Readable.from([]),
			format: pcmFormat,
			ownership: "invalid",
		}),
	/ownership/i,
	);
});
