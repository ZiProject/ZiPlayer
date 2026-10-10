"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { WebSocket } = require("ws");
const { encodeWebAudioFrame } = require("ziplayer");
const { createWebAudioGateway } = require("../gateway");

const token = "gateway-test-token";

function waitForOpen(socket) {
	return new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
}

function waitForMessage(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for relayed audio")), 2000);
		socket.once("message", (data, isBinary) => {
			clearTimeout(timeout);
			resolve({ data, isBinary });
		});
	});
}

test("a next-track listener receives the publisher config and first PCM frame", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0, token });
	let listener;
	let publisher;
	let replacementPublisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		const origin = `http://127.0.0.1:${address.port}`;
		const page = await fetch(origin);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /src="\/client\.js"/);

		const appScript = await fetch(`${origin}/client.js`);
		assert.equal(appScript.status, 200);
		assert.match(await appScript.text(), /from "\/web-audio-client\.js"/);

		const audioClient = await fetch(`${origin}/web-audio-client.js`);
		assert.equal(audioClient.status, 200);
		assert.match(await audioClient.text(), /class WebAudioClient/);

		listener = new WebSocket(`${gatewayUrl}/listen-next?token=${token}`);
		await waitForOpen(listener);

		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=gateway-test-session&token=${token}`);
		await waitForOpen(publisher);

		const configMessage = waitForMessage(listener);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "gateway-test-session",
				protocolVersion: 1,
				sampleRateHz: 48_000,
				channels: 2,
				sampleFormat: "s16",
				endianness: "little",
				channelLayout: "interleaved",
			}),
		);
		const config = await configMessage;
		assert.equal(config.isBinary, false);
		assert.equal(JSON.parse(config.data.toString()).type, "audio:config");

		const frameMessage = waitForMessage(listener);
		publisher.send(encodeWebAudioFrame(Buffer.alloc(3840), 0, 0), { binary: true });
		const frame = await frameMessage;
		assert.equal(frame.isBinary, true);
		assert.deepEqual(Buffer.from(frame.data), Buffer.from(encodeWebAudioFrame(Buffer.alloc(3840), 0, 0)));

		const publisherClosed = new Promise((resolve) => publisher.once("close", resolve));
		publisher.close();
		await publisherClosed;
		replacementPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=gateway-test-session&token=${token}`);
		await waitForOpen(replacementPublisher);

		const replacementConfigMessage = waitForMessage(listener);
		replacementPublisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "gateway-test-session",
				protocolVersion: 1,
				sampleRateHz: 48_000,
				channels: 2,
				sampleFormat: "s16",
				endianness: "little",
				channelLayout: "interleaved",
			}),
		);
		const replacementConfig = await replacementConfigMessage;
		assert.equal(replacementConfig.isBinary, false);
		assert.equal(JSON.parse(replacementConfig.data.toString()).sessionId, "gateway-test-session");

		const replacementFrameMessage = waitForMessage(listener);
		replacementPublisher.send(encodeWebAudioFrame(Buffer.alloc(3840, 1), 0, 0), { binary: true });
		const replacementFrame = await replacementFrameMessage;
		assert.equal(replacementFrame.isBinary, true);
		assert.deepEqual(Buffer.from(replacementFrame.data), Buffer.from(encodeWebAudioFrame(Buffer.alloc(3840, 1), 0, 0)));
	} finally {
		listener?.close();
		publisher?.close();
		replacementPublisher?.close();
		await gateway.close();
	}
});

test("session-scoped next-listener routing keeps concurrent publishers isolated", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0, token });
	let alphaListener;
	let betaListener;
	let alphaPublisher;
	let betaPublisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		alphaListener = new WebSocket(`${gatewayUrl}/listen-next?sessionId=alpha-session&token=${token}`);
		betaListener = new WebSocket(`${gatewayUrl}/listen-next?sessionId=beta-session&token=${token}`);
		await Promise.all([waitForOpen(alphaListener), waitForOpen(betaListener)]);

		alphaPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=alpha-session&token=${token}`);
		await waitForOpen(alphaPublisher);
		const alphaConfigMessage = waitForMessage(alphaListener);
		alphaPublisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "alpha-session",
				protocolVersion: 1,
				sampleRateHz: 48_000,
				channels: 2,
				sampleFormat: "s16",
				endianness: "little",
				channelLayout: "interleaved",
			}),
		);
		const alphaConfig = await alphaConfigMessage;
		assert.equal(JSON.parse(alphaConfig.data.toString()).sessionId, "alpha-session");

		betaPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=beta-session&token=${token}`);
		await waitForOpen(betaPublisher);
		const betaConfigMessage = waitForMessage(betaListener);
		betaPublisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "beta-session",
				protocolVersion: 1,
				sampleRateHz: 48_000,
				channels: 2,
				sampleFormat: "s16",
				endianness: "little",
				channelLayout: "interleaved",
			}),
		);
		const betaConfig = await betaConfigMessage;
		assert.equal(JSON.parse(betaConfig.data.toString()).sessionId, "beta-session");
		assert.equal(alphaListener.readyState, 1);
		assert.equal(betaListener.readyState, 1);
	} finally {
		alphaListener?.close();
		betaListener?.close();
		alphaPublisher?.close();
		betaPublisher?.close();
		await gateway.close();
	}
});

test("play waits for its requested session instead of returning another active publisher", async () => {
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		token,
		defaultSessionId: "requested-session",
		onPlayQuery: async () => ({ track: { title: "Requested track", url: null } }),
	});
	let unrelatedPublisher;
	let requestedPublisher;
	try {
		const address = await gateway.listen();
		const origin = `http://127.0.0.1:${address.port}`;
		const configResponse = await fetch(`${origin}/config`);
		assert.equal(configResponse.status, 200);
		assert.equal((await configResponse.json()).defaultSessionId, "requested-session");

		unrelatedPublisher = new WebSocket(
			`ws://127.0.0.1:${address.port}/publish?sessionId=unrelated-session&token=${token}`,
		);
		await waitForOpen(unrelatedPublisher);

		const playResponsePromise = fetch(`${origin}/play`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ query: "requested track", sessionId: "requested-session" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		requestedPublisher = new WebSocket(
			`ws://127.0.0.1:${address.port}/publish?sessionId=requested-session&token=${token}`,
		);
		await waitForOpen(requestedPublisher);

		const playResponse = await playResponsePromise;
		assert.equal(playResponse.status, 200);
		assert.equal((await playResponse.json()).sessionId, "requested-session");
	} finally {
		unrelatedPublisher?.close();
		requestedPublisher?.close();
		await gateway.close();
	}
});

test("the example token is rejected when binding outside loopback", () => {
	assert.throws(
		() => createWebAudioGateway({ host: "0.0.0.0", token: "change-this-local-token" }),
		/refusing to bind.*unique secret/i,
	);
});
