const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { Readable } = require("node:stream");
const { Player, Bus, WebAudioConnection, createOpusAudioResource, PlaybackController } = require("../core/dist");
const { VoiceConnectionStatus, createAudioPlayer } = require("@discordjs/voice");

function createFakeSocket() {
	const listeners = new Map();
	return {
		readyState: 1,
		bufferedAmount: 0,
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
		joinConfig: { channelId: "voice-stress", guildId: "guild-stress" },
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

test("Stress test: 100 consecutive Opus track replacements with dual subscribers", async () => {
	let spawnedProcesses = 0;
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function (...args) {
		spawnedProcesses++;
		return originalSpawn.apply(this, args);
	};

	const { player, controller } = createPlayerWithAudioPlayer("stress-player");

	const voiceConn = createFakeVoiceConnection();
	const webConn = new WebAudioConnection({ sessionId: "stress-session" });
	const socket = createFakeSocket();
	webConn.attachSocket(socket);

	voiceConn.subscribe(player);
	webConn.subscribe(player);

	// Record baseline memory
	if (global.gc) global.gc();
	const initialMem = process.memoryUsage();

	const REPLACEMENTS = 100;

	for (let i = 0; i < REPLACEMENTS; i++) {
		// Each track provides a short stream of 20ms Opus silence packets
		const packets = [Buffer.from([0xf8, 0xff, 0xfe, i & 0xff]), Buffer.from([0xf8, 0xff, 0xfe, (i + 1) & 0xff])];
		const packetStream = Readable.from(packets, { objectMode: true });
		const resource = createOpusAudioResource(packetStream, {
			metadata: { title: `Track ${i}` },
		});

		await player.play(resource);

		// Briefly yield to let the player cycle advance
		if (i % 20 === 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	// Final drain wait
	await new Promise((resolve) => setTimeout(resolve, 80));

	if (global.gc) global.gc();
	const finalMem = process.memoryUsage();

	const heapGrowthMb = (finalMem.heapUsed - initialMem.heapUsed) / (1024 * 1024);

	// Zero FFmpeg processes must have been spawned
	assert.equal(spawnedProcesses, 0, "Zero FFmpeg child processes during 100 replacements");

	// Memory growth should remain well bounded (< 30 MB for 100 track replacements)
	assert.ok(heapGrowthMb < 30, `Heap growth (${heapGrowthMb.toFixed(2)} MB) should be strictly bounded`);

	// Verify player and subscribers are still operational
	assert.ok(voiceConn.dispatchedPackets.length > 0, "Voice connection received dispatched packets");
	assert.ok(socket.sent.length > 0, "Web connection socket received frames");

	// Clean teardown
	webConn.destroy();
	player.destroy();
	controller.detach("stress-player");
	childProcess.spawn = originalSpawn;
});
