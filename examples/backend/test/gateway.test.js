"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { WebSocket } = require("ws");
const { encodeWebAudioOpusFrame } = require("ziplayer");
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

function createSseEventReader(stream) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		reader,
		async next() {
			while (true) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary !== -1) {
					const message = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const event = message.match(/^event: (.+)$/m)?.[1] ?? "message";
					const data = message.match(/^data: (.+)$/m)?.[1];
					if (data !== undefined) return { event, data: JSON.parse(data) };
					continue;
				}
				const { done, value } = await reader.read();
				if (done) throw new Error("SSE stream ended before the next event");
				buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			}
		},
	};
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
		const pageHtml = await page.text();
		assert.match(pageHtml, /src="\/client\.js"/);
		assert.match(pageHtml, /"opus-decoder": "\/vendor\/opus-decoder\/index\.js"/);
		assert.match(pageHtml, /"simple-yenc": "\/vendor\/simple-yenc\/dist\/esm\.js"/);

		const appScript = await fetch(`${origin}/client.js`);
		assert.equal(appScript.status, 200);
		assert.match(await appScript.text(), /from "\/web-audio-client\.js"/);

		const audioClient = await fetch(`${origin}/web-audio-client.js`);
		assert.equal(audioClient.status, 200);
		assert.match(await audioClient.text(), /class WebAudioClient/);

		for (const modulePath of [
			"/vendor/opus-decoder/index.js",
			"/vendor/opus-decoder/src/OpusDecoder.js",
			"/vendor/@wasm-audio-decoders/common/index.js",
			"/vendor/@wasm-audio-decoders/common/src/WASMAudioDecoderCommon.js",
			"/vendor/@eshaz/web-worker/browser.js",
			"/vendor/simple-yenc/dist/esm.js",
		]) {
			const module = await fetch(`${origin}${modulePath}`);
			assert.equal(module.status, 200, `Expected browser dependency ${modulePath} to be served`);
			assert.match(module.headers.get("content-type"), /javascript/);
		}
		assert.equal((await fetch(`${origin}/vendor/opus-decoder/../../gateway.js`)).status, 404);

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
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		const config = await configMessage;
		assert.equal(config.isBinary, false);
		assert.equal(JSON.parse(config.data.toString()).type, "audio:config");

		const frameMessage = waitForMessage(listener);
		publisher.send(encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe]), 0, 0), { binary: true });
		const frame = await frameMessage;
		assert.equal(frame.isBinary, true);
		assert.deepEqual(Buffer.from(frame.data), encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe]), 0, 0));

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
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		const replacementConfig = await replacementConfigMessage;
		assert.equal(replacementConfig.isBinary, false);
		assert.equal(JSON.parse(replacementConfig.data.toString()).sessionId, "gateway-test-session");

		const replacementFrameMessage = waitForMessage(listener);
		replacementPublisher.send(encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe, 1]), 0, 0), { binary: true });
		const replacementFrame = await replacementFrameMessage;
		assert.equal(replacementFrame.isBinary, true);
		assert.deepEqual(Buffer.from(replacementFrame.data), encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe, 1]), 0, 0));
	} finally {
		listener?.close();
		publisher?.close();
		replacementPublisher?.close();
		await gateway.close();
	}
});

test("a session-scoped next listener joins an already active publisher", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let listener;
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=active-session`);
		await waitForOpen(publisher);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "active-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);

		listener = new WebSocket(`${gatewayUrl}/listen-next?sessionId=active-session`);
		const configMessage = waitForMessage(listener);
		await waitForOpen(listener);
		const config = await configMessage;
		assert.equal(config.isBinary, false);
		assert.equal(JSON.parse(config.data.toString()).sessionId, "active-session");

		const frameMessage = waitForMessage(listener);
		publisher.send(encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe]), 0, 0), { binary: true });
		const frame = await frameMessage;
		assert.equal(frame.isBinary, true);
		assert.deepEqual(Buffer.from(frame.data), encodeWebAudioOpusFrame(Buffer.from([0xf8, 0xff, 0xfe]), 0, 0));
	} finally {
		listener?.close();
		publisher?.close();
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
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
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
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
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

		const volume = await sendControl({ sessionId: "single-player", action: "volume", volume: 65 });
		assert.equal(volume.status, 200);
		assert.deepEqual(controlCalls[2], {
			action: "volume",
			body: { sessionId: "single-player", action: "volume", volume: 65 },
			sessionId: "single-player",
		});

		assert.equal((await sendControl({ sessionId: "single-player", action: "volume", volume: 201 })).status, 400);
		assert.equal(controlCalls.length, 3);
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

test("player-events streams initial and published player state as server-sent events", async () => {
	let currentTrack = "initial track";
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onGetPlayerState: (sessionId) => ({
			currentTrack: { title: `${sessionId} ${currentTrack}` },
			tracks: [],
			related: [],
			loopMode: "off",
			autoPlay: false,
			volume: 100,
			filters: [],
			activeFilters: [],
		}),
		onControl: () => {
			currentTrack = "updated track";
			return true;
		},
	});
	let eventStream;
	try {
		const address = await gateway.listen();
		eventStream = await fetch(`http://127.0.0.1:${address.port}/player-events?sessionId=event-player`);
		assert.equal(eventStream.status, 200);
		assert.match(eventStream.headers.get("content-type"), /^text\/event-stream/);
		const events = createSseEventReader(eventStream.body);
		const initial = await events.next();
		assert.equal(initial.event, "player-state");
		assert.equal(initial.data.state.currentTrack.title, "event-player initial track");

		const controlResponse = await fetch(`http://127.0.0.1:${address.port}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "event-player", action: "pause" }),
		});
		assert.equal(controlResponse.status, 200);
		const updated = await events.next();
		assert.equal(updated.event, "player-state");
		assert.equal(updated.data.state.currentTrack.title, "event-player updated track");

		await events.reader.cancel();
		assert.equal((await fetch(`http://127.0.0.1:${address.port}/player-events?sessionId=bad%2Fid`)).status, 400);
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

test("audio output controls and /outputs endpoint query and route correctly", async () => {
	const controlCalls = [];
	const outputs = [{ id: "webaudio-p1", name: "Web Audio (p1)", state: "playing" }];
	const gateway = createWebAudioGateway({
		host: "127.0.0.1",
		port: 0,
		onControl: (action, body, sessionId) => {
			controlCalls.push({ action, body, sessionId });
			if (action === "outputs") return outputs;
			if (action === "connect-output") return { id: body.outputId ?? "new-out", name: "New Output" };
			if (action === "disconnect-output") return true;
			return true;
		},
	});
	try {
		const address = await gateway.listen();
		const origin = `http://127.0.0.1:${address.port}`;

		// Test GET /outputs
		const outputsResponse = await fetch(`${origin}/outputs?sessionId=player-outputs`);
		assert.equal(outputsResponse.status, 200);
		const outputsData = await outputsResponse.json();
		assert.equal(outputsData.sessionId, "player-outputs");
		assert.deepEqual(outputsData.outputs, outputs);

		// Test POST /control with action "connect-output"
		const connectResponse = await fetch(`${origin}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "player-outputs", action: "connect-output", outputId: "custom-sink" }),
		});
		assert.equal(connectResponse.status, 200);
		assert.deepEqual(await connectResponse.json(), {
			sessionId: "player-outputs",
			action: "connect-output",
			result: { id: "custom-sink", name: "New Output" },
		});

		// Test POST /control with action "disconnect-output"
		const disconnectResponse = await fetch(`${origin}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "player-outputs", action: "disconnect-output", outputId: "custom-sink" }),
		});
		assert.equal(disconnectResponse.status, 200);
		assert.deepEqual(await disconnectResponse.json(), {
			sessionId: "player-outputs",
			action: "disconnect-output",
			result: true,
		});

		// Test validation: disconnect-output requires outputId
		const invalidDisconnect = await fetch(`${origin}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "player-outputs", action: "disconnect-output" }),
		});
		assert.equal(invalidDisconnect.status, 400);
	} finally {
		await gateway.close();
	}
});

test("a listener receives Opus audio:config and Opus audio frames", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let listener;
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;

		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=opus-test-session`);
		await waitForOpen(publisher);

		listener = new WebSocket(`${gatewayUrl}/listen?sessionId=opus-test-session`);
		await waitForOpen(listener);

		const configPromise = waitForMessage(listener);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "opus-test-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		const configMsg = await configPromise;
		assert.equal(configMsg.isBinary, false);
		const config = JSON.parse(configMsg.data.toString());
		assert.equal(config.type, "audio:config");
		assert.equal(config.codec, "opus");

		const framePromise = waitForMessage(listener);
		const opusPacket = Buffer.from([0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03]); // valid Opus TOC
		publisher.send(encodeWebAudioOpusFrame(opusPacket, 1, 20_000n), { binary: true });
		const frameMsg = await framePromise;
		assert.equal(frameMsg.isBinary, true);
		assert.ok(frameMsg.data.length >= 16 + opusPacket.length);
	} finally {
		listener?.close();
		publisher?.close();
		await gateway.close();
	}
});

test("gateway relays consecutive Opus frames across sequences 0..10 without false rejection", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let listener;
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;

		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=opus-seq-session`);
		await waitForOpen(publisher);

		listener = new WebSocket(`${gatewayUrl}/listen?sessionId=opus-seq-session`);
		await waitForOpen(listener);

		const configPromise = waitForMessage(listener);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "opus-seq-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		await configPromise;

		const opusPacket = Buffer.from([0xf8, 0xff, 0xfe, 0xaa, 0xbb]);
		const receivedFrames = [];
		listener.on("message", (data, isBinary) => {
			if (isBinary) receivedFrames.push(Buffer.from(data));
		});

		// Send sequences 0, 1, 2, 3, 4, 5, 10, 100
		const sequences = [0, 1, 2, 3, 4, 5, 10, 100];
		for (const seq of sequences) {
			const frame = encodeWebAudioOpusFrame(opusPacket, seq, BigInt(seq * 20_000));
			publisher.send(frame, { binary: true });
		}

		// Wait briefly for all frames to be relayed
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.equal(receivedFrames.length, sequences.length);
		for (let i = 0; i < sequences.length; i++) {
			const frame = receivedFrames[i];
			assert.equal(frame[0], 0x5a, "Magic byte 0 must be 'Z'");
			assert.equal(frame[1], 0x49, "Magic byte 1 must be 'I'");
			assert.equal(frame[2], 0x01, "Protocol version must be 1");
			assert.equal(frame[3], 0x01, "Flags bit 0 must be 1 (Opus)");
			assert.equal(frame.readUInt32BE(4), sequences[i], `Sequence must match ${sequences[i]}`);
		}
	} finally {
		listener?.close();
		publisher?.close();
		await gateway.close();
	}
});

test("gateway rejects audio:config with unsupported codec", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=unsupported-codec-session`);
		await waitForOpen(publisher);

		const closePromise = new Promise((resolve) =>
			publisher.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
		);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "unsupported-codec-session",
				protocolVersion: 1,
				codec: "aac",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		const { code, reason } = await closePromise;
		assert.equal(code, 1008);
		assert.match(reason, /Unsupported audio configuration/i);
	} finally {
		publisher?.close();
		await gateway.close();
	}
});

test("gateway rejects legacy frames in v1 session", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=v1-legacy-reject-session`);
		await waitForOpen(publisher);

		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "v1-legacy-reject-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);

		const closePromise = new Promise((resolve) =>
			publisher.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
		);

		const legacyOpusHeader = Buffer.alloc(16);
		legacyOpusHeader.writeUInt16LE(0x4f50, 0); // "OP"
		legacyOpusHeader.writeUInt16LE(48000, 8);
		legacyOpusHeader.writeUInt16LE(2, 10);
		const legacyFrame = Buffer.concat([legacyOpusHeader, Buffer.from([0xf8, 0xff, 0xfe, 0x01])]);

		publisher.send(legacyFrame, { binary: true });
		const { code, reason } = await closePromise;
		assert.equal(code, 1003);
		assert.match(reason, /Invalid or unexpected audio frame/i);
	} finally {
		publisher?.close();
		await gateway.close();
	}
});

test("gateway accepts legacy frames when session explicitly declares protocolVersion: 0", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let listener;
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=legacy-v0-session`);
		await waitForOpen(publisher);

		listener = new WebSocket(`${gatewayUrl}/listen?sessionId=legacy-v0-session`);
		await waitForOpen(listener);

		const configPromise = waitForMessage(listener);
		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "legacy-v0-session",
				protocolVersion: 0,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);
		await configPromise;

		const legacyOpusHeader = Buffer.alloc(16);
		legacyOpusHeader.writeUInt16LE(0x4f50, 0);
		legacyOpusHeader.writeUInt16LE(48000, 8);
		legacyOpusHeader.writeUInt16LE(2, 10);
		const legacyPayload = Buffer.from([0xf8, 0xff, 0xfe, 0x01]);
		const legacyFrame = Buffer.concat([legacyOpusHeader, legacyPayload]);

		const framePromise = waitForMessage(listener);
		publisher.send(legacyFrame, { binary: true });
		const received = await framePromise;
		assert.equal(received.isBinary, true);
		assert.deepEqual(Buffer.from(received.data), legacyFrame);
	} finally {
		listener?.close();
		publisher?.close();
		await gateway.close();
	}
});

test("gateway rejects v1 frames with reserved flags or mismatched codec flags", async () => {
	const gateway = createWebAudioGateway({ host: "127.0.0.1", port: 0 });
	let publisher;
	try {
		const address = await gateway.listen();
		const gatewayUrl = `ws://127.0.0.1:${address.port}`;
		publisher = new WebSocket(`${gatewayUrl}/publish?sessionId=flags-reject-session`);
		await waitForOpen(publisher);

		publisher.send(
			JSON.stringify({
				v: 1,
				type: "audio:config",
				sessionId: "flags-reject-session",
				protocolVersion: 1,
				codec: "opus",
				sampleRateHz: 48_000,
				channels: 2,
			}),
		);

		const closePromise = new Promise((resolve) =>
			publisher.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
		);

		const badFlagsFrame = Buffer.alloc(16 + 4);
		badFlagsFrame[0] = 0x5a; // 'Z'
		badFlagsFrame[1] = 0x49; // 'I'
		badFlagsFrame[2] = 0x01; // version 1
		badFlagsFrame[3] = 0x03; // flags: invalid (reserved bit set)

		publisher.send(badFlagsFrame, { binary: true });
		const { code, reason } = await closePromise;
		assert.equal(code, 1003);
		assert.match(reason, /Invalid or unexpected audio frame/i);
	} finally {
		publisher?.close();
		await gateway.close();
	}
});
