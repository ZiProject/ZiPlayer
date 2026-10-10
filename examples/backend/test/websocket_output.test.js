"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");
const { WebSocketAudioOutputBackend, decodeWebAudioFrame, webAudioFormatFromPcm } = require("ziplayer");

test("the WebSocket audio output applies dynamic volume to PCM frames", async () => {
	const messages = [];
	const socket = {
		readyState: 1,
		bufferedAmount: 0,
		send(message) {
			messages.push(message);
		},
		close() {
			this.readyState = 3;
		},
	};
	const backend = new WebSocketAudioOutputBackend({
		sessionId: "volume-test",
		socketFactory: () => socket,
	});
	const handle = backend.createSession({
		stream: Readable.from([Buffer.from([0x20, 0x4e, 0xe0, 0xb1, 0x00, 0x7d, 0x00, 0x83])]),
		format: webAudioFormatFromPcm({}),
		ownership: "borrow",
	});

	try {
		assert.equal(backend.capabilities.volume, "backend");
		handle.setVolume(1.5);
		await handle.start();
		await handle.completion;

		const frame = messages.find((message) => typeof message !== "string");
		assert.ok(frame);
		const { payload } = decodeWebAudioFrame(frame);
		const pcm = Buffer.from(payload);
		assert.deepEqual(
			[0, 2, 4, 6].map((offset) => pcm.readInt16LE(offset)),
			[30000, -30000, 32767, -32768],
		);
	} finally {
		await backend.dispose();
	}
});
