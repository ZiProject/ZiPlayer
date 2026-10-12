const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { Readable } = require("node:stream");
const {
	Player,
	Bus,
	WebAudioConnection,
	createOpusAudioResource,
	encodeWebAudioOpusFrame,
	decodeWebAudioOpusFrame,
	encodeWebAudioFrame,
	decodeWebAudioFrame,
	demuxOggOpusToPackets,
	demuxWebmOpusToPackets,
	getOpusPacketDurationMs,
	validateOpusPacketDuration,
	PlaybackController,
	WEB_AUDIO_MAGIC_0,
	WEB_AUDIO_MAGIC_1,
	WEB_AUDIO_PROTOCOL_VERSION_V1,
	WEB_AUDIO_FLAG_CODEC_OPUS,
	WEB_AUDIO_FLAG_CODEC_PCM,
	WebAudioConnectionBackend,
	WebSocketAudioOutputBackend,
	AudioOutputUnsupportedOperationError,
} = require("../core/dist");
const { VoiceConnectionStatus, createAudioPlayer, StreamType } = require("@discordjs/voice");

function createFakeSocket(initialBufferedAmount = 0, initialReadyState = 1) {
	const listeners = new Map();
	return {
		readyState: initialReadyState,
		bufferedAmount: initialBufferedAmount,
		sent: [],
		open() {
			this.readyState = 1;
			for (const listener of listeners.get("open") ?? []) listener({});
		},
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

test("Wire Format v1 Opus framing enforces Magic 'ZI', Version 1, Flags, Sequence BE, and microsecond timestamps", () => {
	const packet = Buffer.from([0xf8, 0xff, 0xfe, 0x01, 0x02]);
	const seq = 12345;
	const timestampUs = 246_900_000n; // 246.9 seconds in microseconds

	const frame = encodeWebAudioOpusFrame(packet, seq, timestampUs);
	assert.equal(frame.length, 16 + packet.length);

	// Check magic
	assert.equal(frame[0], WEB_AUDIO_MAGIC_0); // 0x5a 'Z'
	assert.equal(frame[1], WEB_AUDIO_MAGIC_1); // 0x49 'I'
	assert.equal(frame[2], WEB_AUDIO_PROTOCOL_VERSION_V1); // 0x01
	assert.equal(frame[3], WEB_AUDIO_FLAG_CODEC_OPUS); // 0x01 (Opus)

	// Check sequence BE
	assert.equal(frame.readUInt32BE(4), seq);

	// Check timestamp BE
	assert.equal(frame.readBigUInt64BE(8), timestampUs);

	// Payload
	assert.deepEqual(frame.subarray(16), packet);

	// Decode
	const decoded = decodeWebAudioOpusFrame(frame);
	assert.equal(decoded.version, 1);
	assert.equal(decoded.codec, "opus");
	assert.equal(decoded.sequence, seq);
	assert.equal(decoded.timestampUs, timestampUs);
	assert.equal(decoded.timestampMs, 246900);
	assert.deepEqual(decoded.payload, packet);
});

test("Wire Format v1 sequence supports uint32 wraparound", () => {
	const packet = Buffer.from([0xf8, 0xff, 0xfe]);
	const maxUint32 = 0xffffffff;
	const wrappedSeq = (maxUint32 + 1) >>> 0;
	assert.equal(wrappedSeq, 0);

	const frameMax = encodeWebAudioOpusFrame(packet, maxUint32, 0n);
	assert.equal(frameMax.readUInt32BE(4), maxUint32);

	const frameWrapped = encodeWebAudioOpusFrame(packet, wrappedSeq, 20_000n);
	assert.equal(frameWrapped.readUInt32BE(4), 0);

	const decodedWrapped = decodeWebAudioOpusFrame(frameWrapped);
	assert.equal(decodedWrapped.sequence, 0);
	assert.equal(decodedWrapped.timestampUs, 20_000n);
});

test("Wire Format v1 PCM framing enforces Magic 'ZI', Version 1, Flags (0), Sequence BE, and microsecond timestamps", () => {
	const pcmPayload = Buffer.alloc(3840, 0x7f); // 20ms of 48kHz stereo s16
	const seq = 50;
	const timestampUs = 1_000_000n; // 1 second

	const frame = encodeWebAudioFrame(pcmPayload, seq, timestampUs, { isMicroseconds: true });
	assert.equal(frame[0], 0x5a);
	assert.equal(frame[1], 0x49);
	assert.equal(frame[2], 0x01);
	assert.equal(frame[3], 0x00); // PCM flag = 0
	assert.equal(Buffer.from(frame).readUInt32BE(4), seq);
	assert.equal(Buffer.from(frame).readBigUInt64BE(8), timestampUs);

	const decoded = decodeWebAudioFrame(frame);
	assert.equal(decoded.version, 1);
	assert.equal(decoded.sequence, seq);
	assert.equal(decoded.timestampUs, timestampUs);
	assert.equal(decoded.timestampMs, 1000);
	assert.equal(decoded.payload.length, pcmPayload.length);
});

test("Ogg Opus demuxer extracts valid Opus packets from Ogg Opus stream without FFmpeg", async () => {
	function createOggPage(headerType, granulePosition, serialNumber, pageSeq, segments) {
		const segmentTable = [];
		const body = [];
		for (const seg of segments) {
			let remaining = seg.length;
			while (remaining >= 255) {
				segmentTable.push(255);
				remaining -= 255;
			}
			segmentTable.push(remaining);
			body.push(seg);
		}
		const header = Buffer.alloc(27 + segmentTable.length);
		header.write("OggS", 0);
		header.writeUInt8(0, 4); // version
		header.writeUInt8(headerType, 5); // 2 = BOS, 0 = normal
		header.writeBigInt64LE(BigInt(granulePosition), 6);
		header.writeUInt32BE(serialNumber, 14);
		header.writeUInt32LE(pageSeq, 18);
		header.writeUInt32LE(0, 22); // checksum
		header.writeUInt8(segmentTable.length, 26);
		Buffer.from(segmentTable).copy(header, 27);
		return Buffer.concat([header, ...body]);
	}

	const serial = 0xabcdef12;
	const opusHead = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]);
	const opusTags = Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)]);
	const opusPacket1 = Buffer.from([0xf8, 0xff, 0xfe, 0x01, 0x02]);
	const opusPacket2 = Buffer.from([0xf8, 0xff, 0xfe, 0x03, 0x04]);

	const page1 = createOggPage(2, 0, serial, 0, [opusHead]);
	const page2 = createOggPage(0, 0, serial, 1, [opusTags]);
	const page3 = createOggPage(0, 960, serial, 2, [opusPacket1, opusPacket2]);

	const oggStream = Readable.from([page1, page2, page3]);
	const demuxedStream = demuxOggOpusToPackets(oggStream);

	const packets = [];
	for await (const pkt of demuxedStream) {
		packets.push(Buffer.from(pkt));
	}

	assert.equal(packets.length, 2);
	assert.deepEqual(packets[0], opusPacket1);
	assert.deepEqual(packets[1], opusPacket2);
	assert.equal(getOpusPacketDurationMs(packets[0]), 20);
	assert.equal(validateOpusPacketDuration(packets[0], 20), true);
});

test("WebM Opus demuxer extracts valid Opus packets from WebM stream without FFmpeg", async () => {
	function encodeVint(val) {
		if (val < 127) return Buffer.from([0x80 | val]);
		if (val < 16383) return Buffer.from([0x40 | (val >> 8), val & 0xff]);
		return Buffer.from([0x20 | (val >> 16), (val >> 8) & 0xff, val & 0xff]);
	}

	function ebmlTag(idHex, data) {
		const idBuf = Buffer.from(idHex, "hex");
		const len = encodeVint(data.length);
		return Buffer.concat([idBuf, len, data]);
	}

	const ebml = ebmlTag("1a45dfa3", Buffer.alloc(0));
	const trackNum = ebmlTag("d7", Buffer.from([1]));
	const trackType = ebmlTag("83", Buffer.from([2])); // audio
	const codecPrivate = ebmlTag("63a2", Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]));
	const trackEntry = ebmlTag("ae", Buffer.concat([trackNum, trackType, codecPrivate]));
	const tracks = ebmlTag("1654ae6b", trackEntry);

	const opusPacket1 = Buffer.from([0xf8, 0xff, 0xfe, 0x11, 0x22]);
	const opusPacket2 = Buffer.from([0xf8, 0xff, 0xfe, 0x33, 0x44]);

	// SimpleBlock: track 1 (0x81 vint), timecode 0, keyframe 0x80 + opus packet
	const block1 = ebmlTag("a3", Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), opusPacket1]));
	const block2 = ebmlTag("a3", Buffer.concat([Buffer.from([0x81, 0x00, 0x14, 0x80]), opusPacket2]));
	const cluster = ebmlTag("1f43b675", Buffer.concat([block1, block2]));
	const segment = ebmlTag("18538067", Buffer.concat([tracks, cluster]));

	const fullWebm = Buffer.concat([ebml, segment]);
	const webmStream = Readable.from([fullWebm]);
	const demuxedStream = demuxWebmOpusToPackets(webmStream);

	const packets = [];
	for await (const pkt of demuxedStream) {
		packets.push(Buffer.from(pkt));
	}

	assert.equal(packets.length, 2);
	assert.deepEqual(packets[0], opusPacket1);
	assert.deepEqual(packets[1], opusPacket2);
	assert.equal(getOpusPacketDurationMs(packets[0]), 20);
	assert.equal(validateOpusPacketDuration(packets[0], 20), true);
});

test("WebAudioConnection sends audio:config when CONNECTING socket transitions to OPEN", async () => {
	const webConn = new WebAudioConnection({ sessionId: "connecting-sess" });
	const socket = createFakeSocket(0, 0); // readyState = 0 (CONNECTING)

	webConn.attachSocket(socket);

	// Config should NOT be sent while CONNECTING
	assert.equal(socket.sent.length, 0, "No messages should be sent before socket opens");
	assert.equal(webConn.isReady, false);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Connecting);

	// Now socket opens
	socket.open();

	assert.equal(socket.sent.length, 1, "audio:config must be sent once socket opens");
	const configMsg = JSON.parse(socket.sent[0].data);
	assert.equal(configMsg.type, "audio:config");
	assert.equal(configMsg.sessionId, "connecting-sess");
	assert.equal(webConn.isReady, true);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Ready);

	// Triggering open event again should NOT re-send config
	socket.open();
	assert.equal(socket.sent.length, 1, "audio:config must be sent exactly once");

	webConn.destroy();
});

test("WebAudioConnection handles race conditions when socket closes or destroys before OPEN", () => {
	const webConn = new WebAudioConnection({ sessionId: "race-sess" });
	const socket1 = createFakeSocket(0, 0);
	webConn.attachSocket(socket1);
	socket1.close();
	// Should detach cleanly and never send
	socket1.open();
	assert.equal(socket1.sent.length, 0);

	const webConn2 = new WebAudioConnection({ sessionId: "destroy-sess" });
	const socket2 = createFakeSocket(0, 0);
	webConn2.attachSocket(socket2);
	webConn2.destroy();
	socket2.open();
	assert.equal(socket2.sent.length, 0);
});

test("WebAudioConnection reflects correct state and avoids consuming audio without sinks", async () => {
	const { player, audioPlayer, controller } = createPlayerWithAudioPlayer("no-sink-player");
	const webConn = new WebAudioConnection({ sessionId: "no-sink-sess" });

	// Initially, connection has no sockets -> Disconnected
	assert.equal(webConn.state.status, VoiceConnectionStatus.Disconnected);
	assert.equal(webConn.isReady, false);
	assert.equal(webConn.isAvailableForPacing(), false);

	// Subscribe to player without sinks
	webConn.subscribe(player);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Disconnected);

	// AudioPlayer recognizes it is NOT playable because connection is not Ready
	assert.equal(audioPlayer.playable.length, 0, "AudioPlayer must not be playable without ready sinks");

	const packets = Array.from({ length: 20 }, (_, i) => Buffer.from([0xf8, 0xff, 0xfe, i]));
	const packetStream = Readable.from(packets, { objectMode: true });
	const resource = createOpusAudioResource(packetStream);
	await player.play(resource);

	await new Promise((resolve) => setTimeout(resolve, 60));
	// AudioPlayer did not consume packets
	assert.equal(webConn.getStats().sequence, 0);

	// Now attach an OPEN socket
	const socket = createFakeSocket();
	webConn.attachSocket(socket);

	assert.equal(webConn.state.status, VoiceConnectionStatus.Ready);
	assert.equal(webConn.isReady, true);
	assert.ok(audioPlayer.playable.length > 0, "AudioPlayer becomes playable once sink attaches");

	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(webConn.getStats().sequence > 0, "AudioPlayer consumed packets once sink attached");
	const prevSequence = webConn.getStats().sequence;

	// Detach socket -> state transitions to Disconnected
	webConn.detachSocket(socket);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Disconnected);
	assert.equal(audioPlayer.playable.length, 0, "AudioPlayer stops pacing when last sink detaches");

	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(webConn.getStats().sequence, prevSequence, "No further packets consumed after sink detaches");

	// Reconnect idempotency: re-attach socket restores Ready
	const socket2 = createFakeSocket();
	webConn.attachSocket(socket2);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Ready);
	assert.ok(audioPlayer.playable.length > 0);

	// Disconnect method sets Disconnected
	webConn.disconnect();
	assert.equal(webConn.state.status, VoiceConnectionStatus.Disconnected);
	assert.equal(audioPlayer.playable.length, 0);

	// Calling reconnect() restores Ready since socket2 is active
	webConn.reconnect();
	assert.equal(webConn.state.status, VoiceConnectionStatus.Ready);
	assert.ok(audioPlayer.playable.length > 0);

	// Subscribing again with the same player is idempotent and preserves Ready
	webConn.subscribe(player);
	assert.equal(webConn.state.status, VoiceConnectionStatus.Ready);

	webConn.destroy();
	player.destroy();
	controller.detach("no-sink-player");
});

test("createOpusAudioResource enforces packet boundaries and rejects invalid Opus duration", async () => {
	// 1. Rejects byte streams (non-objectMode Readable)
	const byteStream = new Readable({
		read() {
			this.push(Buffer.from([0xf8, 0xff, 0xfe]));
			this.push(null);
		},
	});
	assert.equal(byteStream.readableObjectMode, false);
	assert.throws(() => createOpusAudioResource(byteStream), /object-mode Readable/i);

	// 2. Rejects non-20ms packet in objectMode stream when validateDuration is enabled (default)
	const non20msPacket = Buffer.from([0x00, 0x01]); // 10ms SILK packet
	const badStream = Readable.from([non20msPacket], { objectMode: true });
	const resource = createOpusAudioResource(badStream);

	const readErrors = [];
	resource.playStream.on("error", (err) => readErrors.push(err));
	resource.playStream.read();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(readErrors.length > 0, "Resource should emit error on invalid duration");
	assert.match(readErrors[0].message, /Incompatible Opus packet duration/i);
});

test("WebAudioConnection drops malformed Opus packets without corrupting timestamps", () => {
	const webConn = new WebAudioConnection({ sessionId: "malformed-test" });
	const socket = createFakeSocket();
	webConn.attachSocket(socket);

	// Empty buffer
	webConn.prepareAudioPacket(Buffer.alloc(0));
	webConn.dispatchAudio();

	// Invalid c=3 Opus packet with frameCount=0
	const malformed = Buffer.from([0x03, 0x00]);
	assert.equal(getOpusPacketDurationMs(malformed), 0);
	webConn.prepareAudioPacket(malformed);
	webConn.dispatchAudio();

	const stats = webConn.getStats();
	assert.equal(stats.sequence, 0, "Malformed packets should not increment sequence");
	assert.equal(stats.dispatchedPackets, 0, "Malformed packets should not be dispatched");

	webConn.destroy();
});

test("WebAudioConnection drop-oldest policy drops oldest queued packet when queue limit is reached", () => {
	const webConn = new WebAudioConnection({
		sessionId: "drop-oldest-sess",
		maxBufferedBytes: 10, // tiny limit so packets must queue
		maxQueuedPackets: 2,
		dropPolicy: "drop-oldest",
	});
	const socket = createFakeSocket(500); // saturated buffer
	webConn.attachSocket(socket);

	const droppedSeq = [];
	webConn.on("drop", ({ sequence }) => droppedSeq.push(sequence));

	// Packet 0 -> enters queue (queue: [0])
	webConn.prepareAudioPacket(Buffer.from([0xf8, 0xff, 0xfe, 0x00]));
	webConn.dispatchAudio();

	// Packet 1 -> enters queue (queue: [0, 1])
	webConn.prepareAudioPacket(Buffer.from([0xf8, 0xff, 0xfe, 0x01]));
	webConn.dispatchAudio();

	assert.equal(droppedSeq.length, 0, "No drops while queue is within limit");

	// Packet 2 -> queue is full (length 2 >= max 2), drop oldest (packet 0)!
	webConn.prepareAudioPacket(Buffer.from([0xf8, 0xff, 0xfe, 0x02]));
	webConn.dispatchAudio();

	assert.equal(droppedSeq.length, 1);
	assert.equal(droppedSeq[0], 0, "Oldest packet (0) must be dropped");

	// Packet 3 -> drop oldest (packet 1)!
	webConn.prepareAudioPacket(Buffer.from([0xf8, 0xff, 0xfe, 0x03]));
	webConn.dispatchAudio();

	assert.equal(droppedSeq.length, 2);
	assert.equal(droppedSeq[1], 1, "Oldest packet (1) must be dropped");

	webConn.destroy();
});

test("WebAudioConnectionBackend capabilities accurately reflect unsupported replacement and volume", () => {
	const webConn = new WebAudioConnection({ sessionId: "backend-cap-sess" });
	const backend = new WebAudioConnectionBackend(webConn);

	assert.equal(backend.capabilities.replacement, "unsupported");
	assert.equal(backend.capabilities.volume, "unsupported");

	const handle = backend.createSession({
		stream: new Readable({ read() {} }),
		format: { kind: "encoded", codec: "opus" },
		ownership: "borrow",
	});

	assert.throws(() => handle.replace({}), AudioOutputUnsupportedOperationError);
	assert.throws(() => handle.setVolume(0.5), AudioOutputUnsupportedOperationError);

	handle.dispose();
	backend.dispose();
});

test("WebSocketAudioOutputBackend demuxes Ogg Opus container input before sending Opus frames", async () => {
	const socket = createFakeSocket();
	const backend = new WebSocketAudioOutputBackend({
		codec: "opus",
		socketFactory: () => socket,
	});

	// Build an Ogg Opus stream with 2 packets
	function createOggPage(headerType, granulePosition, serialNumber, pageSeq, segments) {
		const segmentTable = [];
		const body = [];
		for (const seg of segments) {
			let remaining = seg.length;
			while (remaining >= 255) {
				segmentTable.push(255);
				remaining -= 255;
			}
			segmentTable.push(remaining);
			body.push(seg);
		}
		const header = Buffer.alloc(27 + segmentTable.length);
		header.write("OggS", 0);
		header.writeUInt8(0, 4);
		header.writeUInt8(headerType, 5);
		header.writeBigInt64LE(BigInt(granulePosition), 6);
		header.writeUInt32BE(serialNumber, 14);
		header.writeUInt32LE(pageSeq, 18);
		header.writeUInt32LE(0, 22);
		header.writeUInt8(segmentTable.length, 26);
		Buffer.from(segmentTable).copy(header, 27);
		return Buffer.concat([header, ...body]);
	}

	const serial = 0x12345678;
	const opusHead = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]);
	const opusTags = Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)]);
	const opusPacket1 = Buffer.from([0xf8, 0xff, 0xfe, 0xaa]);
	const opusPacket2 = Buffer.from([0xf8, 0xff, 0xfe, 0xbb]);

	const page1 = createOggPage(2, 0, serial, 0, [opusHead]);
	const page2 = createOggPage(0, 0, serial, 1, [opusTags]);
	const page3 = createOggPage(0, 960, serial, 2, [opusPacket1, opusPacket2]);

	const oggStream = Readable.from([page1, page2, page3]); // Byte stream, container ogg

	const handle = backend.createSession({
		stream: oggStream,
		format: { kind: "encoded", codec: "opus", container: "ogg" },
		ownership: "borrow",
	});

	await handle.start();
	await handle.completion;

	const binaryFrames = socket.sent.filter((msg) => typeof msg.data !== "string");
	assert.equal(binaryFrames.length, 2, "Backend should demux Ogg and emit 2 discrete Opus frames");

	const decoded1 = decodeWebAudioOpusFrame(binaryFrames[0].data);
	const decoded2 = decodeWebAudioOpusFrame(binaryFrames[1].data);
	assert.deepEqual(decoded1.payload, opusPacket1);
	assert.deepEqual(decoded2.payload, opusPacket2);

	await handle.dispose();
	backend.dispose();
});

test("Unified Architecture: Single Opus stream -> AudioResource + AudioPlayer -> voiceConnection.subscribe(player) & webConnection.subscribe(player)", async () => {
	const { player, controller } = createPlayerWithAudioPlayer("unified-opus-player");

	// 1. Discord VoiceConnection subscribes to player
	const voiceConnection = createFakeVoiceConnection();
	const voiceSub = voiceConnection.subscribe(player);
	assert.ok(voiceSub, "voiceConnection.subscribe(player) returns a valid PlayerSubscription");

	// 2. WebAudioConnection subscribes to player
	const webSocket = createFakeSocket();
	const webConnection = new WebAudioConnection({ sessionId: "unified-web-sess" });
	webConnection.attachSocket(webSocket);
	const webSub = webConnection.subscribe(player);
	assert.ok(webSub, "webConnection.subscribe(player) returns a valid PlayerSubscription");

	// 3. Create a single Opus packet stream (one source)
	const rawOpusPackets = [
		Buffer.from([0xf8, 0xff, 0xfe, 0x01]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x02]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x03]),
	];
	const opusStream = Readable.from(rawOpusPackets, { objectMode: true });
	const resource = createOpusAudioResource(opusStream, {
		metadata: { title: "Single Opus Stream" },
	});

	// 4. Play through AudioPlayer
	await player.play(resource);

	// Wait for 20ms scheduler cycles
	await new Promise((resolve) => setTimeout(resolve, 100));

	// 5. Discord Voice received Opus packets directly
	assert.ok(voiceConnection.dispatchedPackets.length > 0, "Discord Voice received dispatched Opus packets");

	// 6. WebSocket Gateway received same Opus packets wrapped in Wire Format v1 frame
	const binaryFrames = webSocket.sent.filter((msg) => typeof msg.data !== "string");
	assert.ok(binaryFrames.length > 0, "WebSocket Gateway received Opus binary frames");

	// 7. Verify byte-for-byte Opus payload parity across Discord Voice and WebAudio
	for (let i = 0; i < Math.min(voiceConnection.dispatchedPackets.length, binaryFrames.length); i++) {
		const decoded = decodeWebAudioOpusFrame(binaryFrames[i].data);
		assert.equal(decoded.codec, "opus");
		assert.deepEqual(decoded.payload, voiceConnection.dispatchedPackets[i], "Both outputs received identical Opus payload");
	}

	// 8. Verify the source packets reached both Discord Voice and WebAudio
	const discordHex = voiceConnection.dispatchedPackets.map((b) => b.toString("hex"));
	const webHex = binaryFrames.map((f) => decodeWebAudioOpusFrame(f.data).payload.toString("hex"));
	for (const raw of rawOpusPackets) {
		assert.ok(discordHex.includes(raw.toString("hex")), `Discord Voice dispatched track packet ${raw.toString("hex")}`);
		assert.ok(webHex.includes(raw.toString("hex")), `WebAudio dispatched track packet ${raw.toString("hex")}`);
	}

	webConnection.destroy();
	player.destroy();
	controller.detach("unified-opus-player");
});
