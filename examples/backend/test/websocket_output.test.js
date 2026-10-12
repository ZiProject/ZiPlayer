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

test("createWebSocketAudioOutputBackend helper creates a valid backend for dynamic player connection", async () => {
	const { createWebSocketAudioOutputBackend } = require("../index");
	const backend = createWebSocketAudioOutputBackend({
		gatewayUrl: "ws://127.0.0.1:8080",
		sessionId: "helper-test",
	});
	assert.ok(backend instanceof WebSocketAudioOutputBackend);
	assert.equal(backend.capabilities.volume, "backend");
	await backend.dispose();
});

test("a Player created without factory connects WebSocket backend dynamically and lists outputs", async () => {
	const { PlayerManager } = require("ziplayer");
	const manager = new PlayerManager({ autoCleanup: false });
	try {
		const player = await manager.create("multi-out-test", {
			audioProcessing: {
				enabled: true,
				inputFormat: "encoded",
				outputFormat: "pcm16le",
				sampleRate: 48000,
				channels: 2,
			},
		});
		const initialOutputs = await player.getAudioOutputs();
		assert.equal(initialOutputs.length, 1);
		assert.equal(initialOutputs[0].id, "discord");

		const socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
		const wsBackend = new WebSocketAudioOutputBackend({
			sessionId: "multi-out-test",
			socketFactory: () => socket,
		});
		const handle = await player.connect(wsBackend, {
			id: "ws-dynamic",
			name: "Dynamic WebSocket",
		});
		assert.equal(handle.id, "ws-dynamic");

		const updatedOutputs = await player.getAudioOutputs();
		assert.equal(updatedOutputs.length, 2);
		assert.ok(updatedOutputs.some((o) => o.id === "discord"));
		assert.ok(updatedOutputs.some((o) => o.id === "ws-dynamic"));

		const removed = await player.disconnectOutput("ws-dynamic");
		assert.equal(removed, true);

		const finalOutputs = await player.getAudioOutputs();
		assert.equal(finalOutputs.length, 1);
		assert.equal(finalOutputs[0].id, "discord");
	} finally {
		await manager.dispose();
	}
});
