"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { richPresenceExt } = require("../extensions/dist/index.js");

test("richPresenceExt initializes with default and custom options", () => {
	const rpc = new richPresenceExt({
		clientId: "123456789012345678",
		activityType: "Playing",
		showTimeline: false,
		showThumbnail: true,
		buttonLabel: "Play",
	});

	assert.equal(typeof rpc.connect, "function");
	assert.equal(rpc.name, "richPresenceExt");
	assert.equal(rpc.connected, false);
	rpc.onDestroy();
});

test("richPresenceExt frames packets with 8-byte header", async () => {
	// Create a mock IPC server
	let receivedOpcode = null;
	let receivedPayload = null;

	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			if (chunk.length >= 8) {
				receivedOpcode = chunk.readInt32LE(0);
				const len = chunk.readInt32LE(4);
				const jsonText = chunk.subarray(8, 8 + len).toString("utf8");
				receivedPayload = JSON.parse(jsonText);

				// Send back READY frame
				const readyPayload = JSON.stringify({
					cmd: "DISPATCH",
					evt: "READY",
					data: {
						v: 1,
						user: { id: "987654321", username: "TestUser" },
					},
				});
				const header = Buffer.alloc(8);
				header.writeInt32LE(1, 0); // FRAME
				header.writeInt32LE(Buffer.byteLength(readyPayload), 4);
				socket.write(Buffer.concat([header, Buffer.from(readyPayload)]));
			}
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;

	// Point mock socket to our test server
	const rpc = new richPresenceExt({ clientId: "test-client-id" });
	// Inject our custom socket to verify IPC handshake handling
	const clientSocket = net.connect(port, "127.0.0.1");
	rpc.setupSocket(clientSocket);
	rpc.socket = clientSocket;
	rpc.sendHandshake();

	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.equal(receivedOpcode, 0, "Opcode should be 0 (HANDSHAKE)");
	assert.equal(receivedPayload.client_id, "test-client-id");
	assert.equal(rpc.connected, true);
	assert.equal(rpc.user.username, "TestUser");

	rpc.onDestroy();
	clientSocket.destroy();
	await new Promise((resolve) => server.close(resolve));
});

test("richPresenceExt formats activity with timeline and thumbnail", () => {
	const rpc = new richPresenceExt({
		clientId: "test-id",
		activityType: "Listening",
		showTimeline: true,
		showThumbnail: true,
	});

	let sentActivity = null;
	rpc.setActivity = (act) => {
		sentActivity = act;
	};

	const track = {
		title: "A Night at the Opera",
		author: "Queen",
		duration: 240,
		thumbnail: "https://example.com/art.jpg",
		url: "https://example.com/song",
	};

	rpc.formatAndSendActivity({
		track,
		positionMs: 30000,
		durationMs: 240000,
		isPaused: false,
		isLive: false,
	});

	assert.ok(sentActivity, "Activity should be generated");
	assert.equal(sentActivity.details, "A Night at the Opera");
	assert.equal(sentActivity.state, "by Queen");
	assert.equal(sentActivity.type, 2, "Type 2 is Listening");
	assert.ok(sentActivity.timestamps, "Timestamps should be included");
	assert.ok(sentActivity.timestamps.start > 0);
	assert.ok(sentActivity.timestamps.end > sentActivity.timestamps.start);
	assert.equal(sentActivity.assets.large_image, "https://example.com/art.jpg");
	assert.equal(sentActivity.assets.small_image, "play");
	assert.equal(sentActivity.assets.small_text, "Playing");
	assert.equal(sentActivity.buttons, undefined, "Buttons should not be present");

	// When paused:
	rpc.formatAndSendActivity({
		track,
		positionMs: 30000,
		durationMs: 240000,
		isPaused: true,
		isLive: false,
	});

	assert.equal(sentActivity.state, "by Queen (Paused)");
	assert.equal(sentActivity.timestamps, undefined, "Paused should not have advancing timestamps");
	assert.equal(sentActivity.assets.small_image, "pause");
	assert.equal(sentActivity.assets.small_text, "Paused");

	// When idle:
	rpc.setIdleActivity();
	assert.equal(sentActivity.details, "Chờ phát nhạc");
	assert.equal(sentActivity.state, "Zimusix");
	assert.ok(sentActivity.timestamps?.start > 0);

	rpc.onDestroy();
});
