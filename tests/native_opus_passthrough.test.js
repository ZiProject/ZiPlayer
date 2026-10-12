const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { Readable } = require("node:stream");
const {
	Player,
	Bus,
	WebAudioConnection,
	createOpusAudioResource,
	decodeWebAudioOpusFrame,
	getOpusPacketDurationMs,
	PlaybackController,
} = require("../core/dist");
const { VoiceConnectionStatus, createAudioPlayer, StreamType } = require("@discordjs/voice");

function createFakeSocket(initialBufferedAmount = 0) {
	const listeners = new Map();
	return {
		readyState: 1,
		bufferedAmount: initialBufferedAmount,
		sent: [],
		close(code = 1000, reason = "") {
			this.readyState = 3;
			this.closed = true;
			for (const listener of listeners.get("close") ?? []) listener({ code, reason });
		},
		addEventListener(type, listener) {
			const entries = listeners.get(type) ?? new Set();
			entries.add(listener);
			listeners.set(type, entries);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		send(data) {
			this.sent.push({ data, at: Date.now() });
		},
	};
}

function createFakeVoiceConnection() {
	return {
		state: {
			status: VoiceConnectionStatus.Ready,
			subscription: undefined,
		},
		preparedPackets: [],
		dispatchedPackets: [],
		speaking: false,
		joinConfig: { channelId: "voice-123", guildId: "guild-123" },
		prepareAudioPacket(packet) {
			this.preparedPackets.push(Buffer.from(packet));
		},
		dispatchAudio() {
			if (this.preparedPackets.length > 0) {
				const packet = this.preparedPackets[this.preparedPackets.length - 1];
				this.dispatchedPackets.push(packet);
			}
		},
		setSpeaking(value) {
			this.speaking = value;
		},
		onSubscriptionRemoved(sub) {
			if (this.state.subscription === sub) {
				this.state.subscription = undefined;
			}
		},
		subscribe(player) {
			const sub = player["subscribe"](this);
			this.state.subscription = sub;
			return sub;
		},
	};
}

function createPlayerWithAudioPlayer(playerId, bus = new Bus()) {
	const audioPlayer = createAudioPlayer();
	const controller = new PlaybackController(bus);
	controller.attach(playerId, {
		audioPlayer,
		stuckTimeoutMs: 1000,
	});
	const player = new Player(playerId, bus);
	return { player, audioPlayer, controller, bus };
}

// 20ms fullband stereo Opus silence frame (TOC 0xf8 = Config 31)
const OPUS_SILENCE_PACKET = Buffer.from([0xf8, 0xff, 0xfe]);

test("RFC 6716 Opus TOC duration parser detects standard frame durations", () => {
	assert.equal(getOpusPacketDurationMs(OPUS_SILENCE_PACKET), 20);
	// Config 0 (SILK NB 10ms)
	assert.equal(getOpusPacketDurationMs(Buffer.from([0x00, 0x01])), 10);
	// Config 1 (SILK NB 20ms)
	assert.equal(getOpusPacketDurationMs(Buffer.from([0x08, 0x01])), 20);
	// Config 2 (SILK NB 40ms)
	assert.equal(getOpusPacketDurationMs(Buffer.from([0x10, 0x01])), 40);
	// Config 3 (SILK NB 60ms)
	assert.equal(getOpusPacketDurationMs(Buffer.from([0x18, 0x01])), 60);
});

test("Native Opus passthrough spawns 0 FFmpeg child processes", async () => {
	let spawnCount = 0;
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function (...args) {
		spawnCount++;
		return originalSpawn.apply(this, args);
	};

	try {
		const packets = [
			Buffer.from([0xf8, 0xff, 0xfe, 0x01]),
			Buffer.from([0xf8, 0xff, 0xfe, 0x02]),
			Buffer.from([0xf8, 0xff, 0xfe, 0x03]),
		];

		const packetStream = Readable.from(packets, { objectMode: true });
		const resource = createOpusAudioResource(packetStream, {
			metadata: { title: "Passthrough Track" },
		});

		assert.equal(resource.edges.length, 0, "Resource edges length must be 0 (no transformers)");
		assert.equal(resource.encoder, undefined, "Resource encoder must be undefined");

		const { player, controller } = createPlayerWithAudioPlayer("passthrough-player");
		const webConn = new WebAudioConnection({ sessionId: "test-sess-1" });
		const socket = createFakeSocket();
		webConn.attachSocket(socket);

		webConn.subscribe(player);
		await player.play(resource);

		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.equal(spawnCount, 0, "No child processes should be spawned for native Opus passthrough");
		assert.ok(socket.sent.length > 0, "WebSocket subscriber should receive audio frames");

		webConn.destroy();
		player.destroy();
		controller.detach("passthrough-player");
	} finally {
		childProcess.spawn = originalSpawn;
	}
});

test("Unified AudioPlayer dispatch fans out identical Opus packets to Discord and WebAudio", async () => {
	const { player, controller } = createPlayerWithAudioPlayer("dual-player");

	const voiceConn = createFakeVoiceConnection();
	const webConn = new WebAudioConnection({ sessionId: "dual-sess" });
	const socket = createFakeSocket();
	webConn.attachSocket(socket);

	// Both subscribe to the same player
	voiceConn.subscribe(player);
	webConn.subscribe(player);

	const packets = [
		Buffer.from([0xf8, 0xff, 0xfe, 0xaa, 0xbb]),
		Buffer.from([0xf8, 0xff, 0xfe, 0xcc, 0xdd]),
		Buffer.from([0xf8, 0xff, 0xfe, 0xee, 0xff]),
	];
	const packetStream = Readable.from(packets, { objectMode: true });
	const resource = createOpusAudioResource(packetStream, {
		metadata: { title: "Dual Output Track" },
	});

	await player.play(resource);

	// Wait for audio loop to dispatch packets
	await new Promise((resolve) => setTimeout(resolve, 120));

	assert.ok(voiceConn.dispatchedPackets.length >= 1, "Discord should have received packets");

	const binaryFrames = socket.sent.filter((msg) => typeof msg.data !== "string");
	assert.ok(binaryFrames.length >= 1, "WebAudio should have received binary frames");

	// Verify byte-for-byte equality of raw Opus payload
	const decoded = decodeWebAudioOpusFrame(binaryFrames[0].data);
	assert.deepEqual(
		decoded.payload,
		voiceConn.dispatchedPackets[0],
		"Payload dispatched to WebAudio must equal the packet dispatched to Discord Voice",
	);
	assert.equal(decoded.sequence, 0);
	assert.equal(decoded.sampleRateHz, 48000);
	assert.equal(decoded.channels, 2);
	assert.equal(getOpusPacketDurationMs(decoded.payload), 20);

	webConn.destroy();
	player.destroy();
	controller.detach("dual-player");
});

test("Slow WebSocket subscriber drops packets without blocking or stalling Discord Voice", async () => {
	const { player, controller } = createPlayerWithAudioPlayer("backpressure-player");

	const voiceConn = createFakeVoiceConnection();
	let droppedNotifications = 0;
	const webConn = new WebAudioConnection({
		sessionId: "slow-sess",
		maxBufferedBytes: 100, // very small buffer limit
		maxQueuedPackets: 2,
		dropPolicy: "drop-newest",
		onDrop: () => {
			droppedNotifications++;
		},
	});

	// Fake socket with a saturated buffer
	const slowSocket = createFakeSocket(500); // 500 > maxBufferedBytes (100)
	webConn.attachSocket(slowSocket);

	voiceConn.subscribe(player);
	webConn.subscribe(player);

	const packets = Array.from({ length: 10 }, (_, i) => Buffer.from([0xf8, 0xff, 0xfe, i]));
	const packetStream = Readable.from(packets, { objectMode: true });
	const resource = createOpusAudioResource(packetStream);

	await player.play(resource);
	await new Promise((resolve) => setTimeout(resolve, 250));

	// Discord Voice must continue receiving without blocking
	assert.ok(voiceConn.dispatchedPackets.length >= 5, "Discord Voice should not be slowed down");

	// WebAudio stats should reflect dropped packets
	const stats = webConn.getStats();
	assert.ok(stats.droppedPackets > 0, "Slow socket should drop packets");
	assert.ok(droppedNotifications > 0, "onDrop callback should be triggered");

	webConn.destroy();
	player.destroy();
	controller.detach("backpressure-player");
});

test("Player.connect(webConnection) attaches WebAudio output dynamically during playback", async () => {
	const { player, controller } = createPlayerWithAudioPlayer("dynamic-web-player");

	const packets = Array.from({ length: 20 }, (_, i) => Buffer.from([0xf8, 0xff, 0xfe, i]));
	const packetStream = Readable.from(packets, { objectMode: true });
	const resource = createOpusAudioResource(packetStream);

	await player.play(resource);
	await new Promise((resolve) => setTimeout(resolve, 60));

	const webConn = new WebAudioConnection({ sessionId: "dynamic-web-sess" });
	const socket = createFakeSocket();
	webConn.attachSocket(socket);

	const registration = await player.connect(webConn, { name: "Dynamic Web Audio" });
	assert.equal(typeof registration.disconnect, "function");

	await new Promise((resolve) => setTimeout(resolve, 100));

	const binaryFrames = socket.sent.filter((msg) => typeof msg.data !== "string");
	assert.ok(binaryFrames.length > 0, "Dynamically connected WebAudio should receive Opus frames");

	const outputs = await player.getAudioOutputs();
	assert.ok(outputs.some((o) => o.name === "Dynamic Web Audio"));

	await registration.disconnect();
	assert.equal(webConn.getStats().status, VoiceConnectionStatus.Destroyed);

	player.destroy();
	controller.detach("dynamic-web-player");
});
