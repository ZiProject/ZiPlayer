// End-to-end: PlaybackController + FFmpeg DSP + a real output backend (WebSocket, with an in-memory socket).
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { Bus, Player, PlaybackController, WebSocketAudioOutputBackend, decodeWebAudioFrame } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");
const { makeWav, wavSource, analyzePcm16 } = require("./helpers/wav");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSocket() {
	const listeners = new Map();
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		close() {
			this.readyState = 3;
			for (const listener of listeners.get("close") ?? []) listener({});
		},
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		send(data) {
			this.sent.push({ data, at: Date.now() });
		},
	};
}

/** One controller whose WebSocket backend hands out a fresh socket per session (as the gateway publisher does). */
function setup(playerId, audioProcessing = { enabled: true }) {
	const bus = new Bus();
	const events = [];
	const originalEvent = bus.event.bind(bus);
	bus.event = (id, event) => {
		events.push(event);
		return originalEvent(id, event);
	};
	const sockets = [];
	const controller = new PlaybackController(bus);
	controller.attach(playerId, {
		audioProcessing,
		stuckTimeoutMs: 1000,
		audioOutputBackendFactory: () =>
			new WebSocketAudioOutputBackend({
				socketFactory: () => {
					const socket = fakeSocket();
					sockets.push(socket);
					return socket;
				},
			}),
	});
	const audioFrames = () =>
		sockets
			.flatMap((socket) => socket.sent)
			.filter((message) => typeof message.data !== "string")
			.map((message) => ({ ...decodeWebAudioFrame(message.data), at: message.at }));
	return { controller, events, sockets, audioFrames };
}

const track = (id) => ({ id, title: id, duration: 5000 });
const streamErrors = (events) => events.filter((event) => event.type === "streamError");

test("encoded source plays through DSP and the web backend with the right content and real-time pacing", async () => {
	const { controller, events, audioFrames } = setup("it-full");
	const resource = controller.createResource(
		"it-full",
		Readable.from([makeWav({ seconds: 2, sampleRate: 44100, channels: 2, amplitude: 0.5 })]),
		track("full"),
		StreamType.Arbitrary,
	);
	await controller.play("it-full", resource);
	await sleep(2600);
	const frames = audioFrames();
	const analysis = analyzePcm16(Buffer.concat(frames.map((frame) => Buffer.from(frame.payload))), {
		sampleRate: 48000,
		channels: 2,
	});
	assert.ok(Math.abs(analysis.frames / 48000 - 2) < 0.05, `seconds=${analysis.frames / 48000}`);
	assert.ok(Math.abs(analysis.peak - 0.5) < 0.02, `peak=${analysis.peak}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 5, `frequency=${analysis.frequency}`);
	assert.deepEqual(
		frames.map((frame) => frame.sequence),
		frames.map((_, index) => index),
	);
	const spanMs = frames.at(-1).at - frames[0].at;
	assert.ok(spanMs > 1700 && spanMs < 2300, `frames were not paced in real time: span=${spanMs}ms`);
	assert.equal(streamErrors(events).length, 0);
	controller.detach("it-full");
});

test("a seeked raw PCM stream is processed as PCM and not as FFmpeg-guessed noise", async () => {
	const { controller, events, audioFrames } = setup("it-raw");
	const frames = 48000;
	const pcm = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) {
		const value = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 48000));
		pcm.writeInt16LE(value, i * 4);
		pcm.writeInt16LE(value, i * 4 + 2);
	}
	// FilterController returns StreamType.Raw (s16le, 48 kHz, stereo) once a seek or filter has been applied.
	const resource = controller.createResource("it-raw", Readable.from([pcm]), track("raw"), StreamType.Raw);
	await controller.play("it-raw", resource);
	await sleep(1500);
	const analysis = analyzePcm16(Buffer.concat(audioFrames().map((frame) => Buffer.from(frame.payload))), {
		sampleRate: 48000,
		channels: 2,
	});
	assert.ok(Math.abs(analysis.frames / 48000 - 1) < 0.05, `seconds=${analysis.frames / 48000}`);
	assert.ok(Math.abs(analysis.peak - 0.5) < 0.02, `peak=${analysis.peak}`);
	assert.ok(Math.abs(analysis.frequency - 440) < 5, `frequency=${analysis.frequency}`);
	assert.equal(streamErrors(events).length, 0);
	controller.detach("it-raw");
});

test("stop() mid-track releases the source and does not raise a track error", async () => {
	const { controller, events, audioFrames } = setup("it-stop");
	const stats = {};
	const source = Readable.from(wavSource({ seconds: 120, channels: 2, stats }));
	await controller.play("it-stop", controller.createResource("it-stop", source, track("stop"), StreamType.Arbitrary));
	await sleep(600);
	assert.ok(audioFrames().length > 0);
	await controller.stop("it-stop");
	await sleep(500);
	const framesAfterStop = audioFrames().length;
	await sleep(300);
	assert.equal(audioFrames().length, framesAfterStop, "audio kept flowing after stop()");
	assert.equal(source.destroyed, true);
	assert.equal(stats.returned, true);
	assert.equal(streamErrors(events).length, 0);
	controller.detach("it-stop");
});

test("replacing a playing track tears down the old pipeline and plays the new one", async () => {
	const { controller, events, audioFrames } = setup("it-replace");
	const first = {};
	const a = Readable.from(wavSource({ seconds: 120, channels: 2, stats: first }));
	await controller.play("it-replace", controller.createResource("it-replace", a, track("a"), StreamType.Arbitrary));
	await sleep(500);
	const b = Readable.from([makeWav({ seconds: 1, sampleRate: 48000, channels: 2, frequency: 880 })]);
	await controller.play("it-replace", controller.createResource("it-replace", b, track("b"), StreamType.Arbitrary));
	await sleep(1800);
	assert.equal(a.destroyed, true);
	assert.equal(first.returned, true);
	const all = audioFrames();
	const tail = analyzePcm16(Buffer.concat(all.slice(-40).map((frame) => Buffer.from(frame.payload))), {
		sampleRate: 48000,
		channels: 2,
	});
	assert.ok(Math.abs(tail.frequency - 880) < 15, `new track frequency=${tail.frequency}`);
	assert.equal(streamErrors(events).length, 0);
	controller.detach("it-replace");
});

test("player.connect(backend) attaches a WebSocket sink mid-track and removes only that sink", async () => {
	const playerId = "it-dynamic-output";
	const bus = new Bus();
	const events = [];
	const originalEvent = bus.event.bind(bus);
	bus.event = (id, event) => {
		events.push(event);
		return originalEvent(id, event);
	};
	const controller = new PlaybackController(bus);
	const sockets = [];
	const createSocket = () => {
		const socket = fakeSocket();
		sockets.push(socket);
		return socket;
	};
	controller.attach(playerId, {
		audioProcessing: { enabled: true },
		stuckTimeoutMs: 1000,
		audioOutputBackendFactory: () => new WebSocketAudioOutputBackend({ socketFactory: createSocket }),
	});
	const player = new Player(playerId, bus);
	const source = Readable.from(wavSource({ seconds: 3, channels: 2 }));
	const resource = controller.createResource(playerId, source, track("dynamic"), StreamType.Arbitrary);
	await controller.play(playerId, resource);
	await sleep(350);

	const registration = await player.connect(
		new WebSocketAudioOutputBackend({ socketFactory: createSocket }),
		{ id: "late-browser", name: "Late browser" },
	);
	assert.deepEqual(
		(await player.getAudioOutputs()).map((output) => output.id),
		["default", "late-browser"],
	);
	await sleep(450);
	const lateSocket = sockets[1];
	const binaryCount = (socket) => socket.sent.filter((message) => typeof message.data !== "string").length;
	const lateFramesBeforeDisconnect = binaryCount(lateSocket);
	assert.ok(lateFramesBeforeDisconnect > 0, "late sink should receive PCM from its attach point");
	const primaryFramesBeforeDisconnect = binaryCount(sockets[0]);
	assert.ok(primaryFramesBeforeDisconnect > lateFramesBeforeDisconnect, "primary sink should have received the earlier part of the track");

	assert.equal(await registration.disconnect(), true);
	const lateFramesAfterDisconnect = binaryCount(lateSocket);
	await sleep(120);
	assert.equal(binaryCount(lateSocket), lateFramesAfterDisconnect, "removed sink must stop receiving frames");
	assert.ok(binaryCount(sockets[0]) > primaryFramesBeforeDisconnect, "primary playback must continue after removing the late sink");
	assert.equal(streamErrors(events).length, 0);
	controller.detach(playerId);
	player.removeAllListeners();
});

test("web output rejects a non-48kHz-stereo DSP format with a clear error and releases the source", async () => {
	const { controller } = setup("it-format", { enabled: true, channels: 1 });
	const source = Readable.from([makeWav({ seconds: 0.2, channels: 1 })]);
	assert.throws(() => controller.createResource("it-format", source, track("mono"), StreamType.Arbitrary), /48000 Hz|2 channels/);
	assert.equal(source.destroyed, true);
	controller.detach("it-format");
});
