"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { WebSocket } = require("ws");
const { encodeWebAudioFrame } = require("ziplayer");
const { createWebAudioGateway } = require("../gateway");
const { createPlayerIdleCleanup } = require("../index");

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
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
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

		listener = new WebSocket(`${gatewayUrl}/listen-next`);
		await waitForOpen(listener);

		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=gateway-test-session`);
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
		replacementPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=gateway-test-session`);
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
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let alphaListener;
	let betaListener;
	let alphaPublisher;
	let betaPublisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		alphaListener = new WebSocket(`${gatewayUrl}/listen-next?sessionId=alpha-session`);
		betaListener = new WebSocket(`${gatewayUrl}/listen-next?sessionId=beta-session`);
		await Promise.all([waitForOpen(alphaListener), waitForOpen(betaListener)]);

		alphaPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=alpha-session`);
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

		betaPublisher = new WebSocket(`${gatewayUrl}/publish?sessionId=beta-session`);
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

test("gateway reports per-session browser listener counts as listeners connect and disconnect", async () => {
	const changes = [];
	let resolveEmpty;
	let sawListener = false;
	const empty = new Promise((resolve) => {
		resolveEmpty = resolve;
	});
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onListenerCount: (sessionId, count) => {
			changes.push({ sessionId, count });
			if (count > 0) sawListener = true;
			else if (sawListener) resolveEmpty();
		},
	});
	let listener;
	let publisher;
	try {
		const address = await gateway.listen();
		const origin = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${origin}/publish?sessionId=listener-count-player`);
		await waitForOpen(publisher);
		listener = new WebSocket(`${origin}/listen?sessionId=listener-count-player`);
		await waitForOpen(listener);
		const closed = new Promise((resolve) => listener.once("close", resolve));
		listener.close();
		await closed;
		await empty;
		assert.deepEqual(changes, [
			{ sessionId: "listener-count-player", count: 0 },
			{ sessionId: "listener-count-player", count: 1 },
			{ sessionId: "listener-count-player", count: 0 },
		]);
	} finally {
		listener?.close();
		publisher?.close();
		await gateway.close();
	}
});

test("listener-idle cleanup deletes after the timeout and reconnect cancels deletion", async () => {
	const players = new Map();
	const destroyed = [];
	const player = {};
	players.set("idle-player", player);
	const manager = {
		getPlayer: (id) => players.get(id) ?? null,
		async destroy(id) {
			destroyed.push(id);
			players.delete(id);
		},
	};
	const cleanup = createPlayerIdleCleanup(manager, 30);
	try {
		cleanup.onListenerCount("idle-player", 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		cleanup.onListenerCount("idle-player", 1);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.deepEqual(destroyed, []);

		cleanup.onListenerCount("idle-player", 0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(destroyed, ["idle-player"]);
		assert.equal(players.has("idle-player"), false);
	} finally {
		cleanup.dispose();
	}
});

test("play waits for its requested session instead of returning another active publisher", async () => {
	const playCalls = [];
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		defaultSessionId: "requested-session",
		onPlayQuery: async (query, sessionId) => {
			playCalls.push({ query, sessionId });
			return { track: { title: "Requested track", url: null } };
		},
	});
	let unrelatedPublisher;
	let requestedPublisher;
	try {
		const address = await gateway.listen();
		const origin = `http://127.0.0.1:${address.port}`;
		const configResponse = await fetch(`${origin}/config`);
		assert.equal(configResponse.status, 200);
		assert.equal((await configResponse.json()).defaultSessionId, "requested-session");

		unrelatedPublisher = new WebSocket(`ws://127.0.0.1:${address.port}/publish?sessionId=unrelated-session`);
		await waitForOpen(unrelatedPublisher);

		const playResponsePromise = fetch(`${origin}/play`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ query: "requested track", sessionId: "requested-session" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		requestedPublisher = new WebSocket(`ws://127.0.0.1:${address.port}/publish?sessionId=requested-session`);
		await waitForOpen(requestedPublisher);

		const playResponse = await playResponsePromise;
		assert.equal(playResponse.status, 200);
		assert.equal((await playResponse.json()).sessionId, "requested-session");
		assert.deepEqual(playCalls, [{ query: "requested track", sessionId: "requested-session" }]);
	} finally {
		unrelatedPublisher?.close();
		requestedPublisher?.close();
		await gateway.close();
	}
});

test("the example gateway only binds to loopback", () => {
	assert.throws(() => createWebAudioGateway({ host: "0.0.0.0" }), /only supports loopback/i);
});

test("playback controls are routed to the requested player session without a demo token", async () => {
	const controlCalls = [];
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		defaultSessionId: "single-player",
		onControl: (action, body, sessionId) => {
			controlCalls.push({ action, body, sessionId });
			return true;
		},
	});
	try {
		const address = await gateway.listen();
		const url = `http://127.0.0.1:${address.port}/control`;
		const sendControl = (body) =>
			fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});

		const pause = await sendControl({ sessionId: "single-player", action: "pause" });
		assert.equal(pause.status, 200);
		assert.deepEqual(await pause.json(), { sessionId: "single-player", action: "pause", result: true });
		assert.equal(controlCalls[0].sessionId, "single-player");

		const seek = await sendControl({ sessionId: "second-player", action: "seek", positionMs: 1250 });
		assert.equal(seek.status, 200);
		assert.deepEqual(controlCalls[1], {
			action: "seek",
			body: { sessionId: "second-player", action: "seek", positionMs: 1250 },
			sessionId: "second-player",
		});

		assert.equal((await sendControl({ sessionId: "single-player", action: "volume", volume: 201 })).status, 400);
		assert.equal(controlCalls.length, 2);
	} finally {
		await gateway.close();
	}
});

test("playback controls report unsuccessful operations instead of returning success", async () => {
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onControl: () => false,
	});
	try {
		const address = await gateway.listen();
		const response = await fetch(`http://127.0.0.1:${address.port}/control`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ sessionId: "test-player", action: "pause" }),
		});
		assert.equal(response.status, 409);
		assert.match((await response.json()).error, /pause was not applied/);
	} finally {
		await gateway.close();
	}
});

test("the player-state endpoint returns the requested player's queue and controls", async () => {
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onGetPlayerState: (sessionId) => ({
			currentTrack: { title: `${sessionId} current` },
			tracks: [{ title: `${sessionId} queued` }],
			related: [],
			loopMode: "queue",
			autoPlay: true,
			volume: 85,
			filters: [],
			activeFilters: [],
		}),
	});
	try {
		const address = await gateway.listen();
		const response = await fetch(`http://127.0.0.1:${address.port}/player-state?sessionId=second-player`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			sessionId: "second-player",
			currentTrack: { title: "second-player current" },
			tracks: [{ title: "second-player queued" }],
			related: [],
			loopMode: "queue",
			autoPlay: true,
			volume: 85,
			filters: [],
			activeFilters: [],
		});
		assert.equal((await fetch(`http://127.0.0.1:${address.port}/player-state?sessionId=bad%2Fid`)).status, 400);
	} finally {
		await gateway.close();
	}
});

test("queue, loop, autoplay, and filter controls are validated and routed", async () => {
	const controlCalls = [];
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onControl: (action, body, sessionId) => {
			controlCalls.push({ action, body, sessionId });
			return true;
		},
	});
	try {
		const address = await gateway.listen();
		const send = (body) =>
			fetch(`http://127.0.0.1:${address.port}/control`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: "player-a", ...body }),
			});
		for (const body of [
			{ action: "skip" },
			{ action: "loop", mode: "queue" },
			{ action: "autoplay", enabled: true },
			{ action: "filter", filterName: "bassboost", enabled: true },
			{ action: "filter-clear" },
		]) {
			assert.equal((await send(body)).status, 200);
		}
		assert.deepEqual(
			controlCalls.map(({ action, sessionId }) => ({ action, sessionId })),
			[
				{ action: "skip", sessionId: "player-a" },
				{ action: "loop", sessionId: "player-a" },
				{ action: "autoplay", sessionId: "player-a" },
				{ action: "filter", sessionId: "player-a" },
				{ action: "filter-clear", sessionId: "player-a" },
			],
		);
		assert.equal((await send({ action: "loop", mode: "invalid" })).status, 400);
		assert.equal((await send({ action: "autoplay", enabled: "yes" })).status, 400);
		assert.equal((await send({ action: "filter", filterName: "", enabled: true })).status, 400);
	} finally {
		await gateway.close();
	}
});
