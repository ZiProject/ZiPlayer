"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { StreamType } = require("@discordjs/voice");
const { Bus, Player, PlaybackController, WebSocketAudioOutputBackend, getFfmpegProcessStats } = require("../core/dist");
const { makeWav, wavSource } = require("./helpers/wav");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeSocket() {
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

test("100-track replacement stress test with 2 sinks leaves 0 FFmpeg processes and stable memory", async () => {
	const playerId = "stress-100-tracks";
	const bus = new Bus();
	const streamErrors = [];
	const originalEvent = bus.event.bind(bus);
	bus.event = (id, event) => {
		if (event?.type === "streamError") streamErrors.push(event);
		return originalEvent(id, event);
	};

	const mockAudioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play(resource) {
			this.state.status = "playing";
			this.emit("stateChange", { status: "idle" }, { status: "playing", resource });
		},
		stop() {
			this.state.status = "idle";
			return true;
		},
		pause: () => true,
		unpause: () => true,
	});

	const sockets = [];
	const controller = new PlaybackController(bus);
	controller.attach(playerId, {
		audioPlayer: mockAudioPlayer,
		audioProcessing: { enabled: true },
		stuckTimeoutMs: 1000,
	});

	const player = new Player(playerId, bus);
	// Add second sink (WebSocket PCM)
	await player.connect(
		new WebSocketAudioOutputBackend({
			socketFactory: () => {
				const socket = createFakeSocket();
				sockets.push(socket);
				return socket;
			},
		}),
		{ id: "ws-stress", name: "WebSocket Stress Sink" },
	);

	const initialMemory = process.memoryUsage();
	const ITERATIONS = 100;
	const wavFixture = makeWav({ seconds: 0.1, sampleRate: 48000, channels: 2 });

	for (let i = 0; i < ITERATIONS; i++) {
		const source = Readable.from([wavFixture]);
		const track = { id: `stress-${i}`, title: `Track ${i}`, duration: 100 };
		const resource = controller.createResource(playerId, source, track, StreamType.Arbitrary);
		await controller.play(playerId, resource);
		// Let each track start flowing briefly before rapid replacement
		await sleep(15);
	}

	// Allow final track to settle and cleanup
	await sleep(200);
	await controller.stop(playerId);
	controller.detach(playerId);
	player.destroy();

	// Verify FFmpeg process gate has completely drained
	const stats = getFfmpegProcessStats();
	assert.equal(stats.running, 0, "All FFmpeg processes must have exited after 100 replacements");
	assert.equal(stats.queued, 0, "No FFmpeg processes should be queued after teardown");

	// Verify no uncaught stream errors were raised
	assert.equal(streamErrors.length, 0, "Must not encounter stream errors during replacements");

	// Verify memory did not grow catastrophically (under 80MB heap growth across 100 replacements)
	const finalMemory = process.memoryUsage();
	const heapGrowthMb = (finalMemory.heapUsed - initialMemory.heapUsed) / (1024 * 1024);
	assert.ok(heapGrowthMb < 80, `Heap growth across 100 replacements (${heapGrowthMb.toFixed(1)} MB) must be bounded`);
});

test("CPU and latency benchmark comparing single vs dual sink across a single DSP pipeline", async () => {
	const runBenchmark = async (label, useDiscord, useWs) => {
		const bus = new Bus();
		const mockAudioPlayer = Object.assign(new EventEmitter(), {
			state: { status: "idle" },
			play(resource) {
				this.state.status = "playing";
				if (resource?.playStream) {
					resource.playStream.resume();
				}
			},
			stop: () => true,
			pause: () => true,
			unpause: () => true,
		});

		const sockets = [];
		const controller = new PlaybackController(bus);
		controller.attach("bench-player", {
			audioPlayer: mockAudioPlayer,
			audioProcessing: { enabled: true },
		});
		const player = new Player("bench-player", bus);

		if (useWs) {
			await player.connect(
				new WebSocketAudioOutputBackend({
					socketFactory: () => {
						const socket = createFakeSocket();
						sockets.push(socket);
						return socket;
					},
				}),
				{ id: "ws-bench", name: "WebSocket Bench" },
			);
		}
		if (!useDiscord) {
			await player.disconnectOutput("discord");
		}

		const fixtureWav = makeWav({ seconds: 2.0, sampleRate: 44100, channels: 2 });
		const source = Readable.from([fixtureWav]);
		const track = { id: label, title: label, duration: 2000 };

		const cpuBefore = process.cpuUsage();
		const startNs = process.hrtime.bigint();
		const resource = controller.createResource("bench-player", source, track, StreamType.Arbitrary);
		await controller.play("bench-player", resource);

		// Wait for 500ms of playback
		await sleep(500);
		const latencyMs = Number(process.hrtime.bigint() - startNs) / 1e6;
		const cpu = process.cpuUsage(cpuBefore);
		const cpuMs = (cpu.user + cpu.system) / 1000;

		controller.detach("bench-player");
		player.destroy();

		return { label, latencyMs, cpuMs, socketsSent: sockets[0]?.sent?.length ?? 0 };
	};

	const discordOnly = await runBenchmark("Discord Voice Only", true, false);
	const wsOnly = await runBenchmark("WebSocket PCM Only", false, true);
	const dualSink = await runBenchmark("Dual Sink (Discord + WS)", true, true);

	console.log("\n--- BENCHMARK RESULTS (2.0s fixture, 500ms playback) ---");
	console.log(
		`1. ${discordOnly.label}: CPU = ${discordOnly.cpuMs.toFixed(1)}ms, Latency = ${discordOnly.latencyMs.toFixed(1)}ms`,
	);
	console.log(
		`2. ${wsOnly.label}: CPU = ${wsOnly.cpuMs.toFixed(1)}ms, Latency = ${wsOnly.latencyMs.toFixed(1)}ms, Frames = ${wsOnly.socketsSent}`,
	);
	console.log(
		`3. ${dualSink.label}: CPU = ${dualSink.cpuMs.toFixed(1)}ms, Latency = ${dualSink.latencyMs.toFixed(1)}ms, Frames = ${dualSink.socketsSent}`,
	);
	console.log("--------------------------------------------------------\n");

	assert.ok(dualSink.latencyMs > 0);
	assert.ok(dualSink.socketsSent > 0);
});
