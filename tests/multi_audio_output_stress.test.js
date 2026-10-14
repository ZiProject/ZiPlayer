"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { StreamType } = require("@discordjs/voice");
const { Bus, PlaybackController, getFfmpegProcessStats } = require("../core/dist");
const { makeWav } = require("./helpers/wav");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("100-track replacement leaves 0 FFmpeg processes and stable memory", async () => {
	const playerId = "stress-100-tracks";
	const bus = new Bus();
	const streamErrors = [];
	const originalEvent = bus.event.bind(bus);
	bus.event = (id, event) => {
		if (event?.type === "streamError") streamErrors.push(event);
		return originalEvent(id, event);
	};
	const audioPlayer = Object.assign(new EventEmitter(), {
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
	const controller = new PlaybackController(bus);
	controller.attach(playerId, {
		audioPlayer,
		audioProcessing: { enabled: true },
		stuckTimeoutMs: 1000,
	});
	const initialMemory = process.memoryUsage();
	const iterations = 100;
	const wavFixture = makeWav({ seconds: 0.1, sampleRate: 48_000, channels: 2 });

	for (let i = 0; i < iterations; i++) {
		const source = Readable.from([wavFixture]);
		const track = { id: `stress-${i}`, title: `Track ${i}`, duration: 100 };
		await controller.play(playerId, controller.createResource(playerId, source, track, StreamType.Arbitrary));
		await sleep(15);
	}

	await sleep(200);
	await controller.stop(playerId);
	controller.detach(playerId);

	const stats = getFfmpegProcessStats();
	assert.equal(stats.running, 0);
	assert.equal(stats.queued, 0);
	assert.equal(streamErrors.length, 0);
	const heapGrowthMb = (process.memoryUsage().heapUsed - initialMemory.heapUsed) / (1024 * 1024);
	assert.ok(heapGrowthMb < 80, `Heap growth across 100 replacements (${heapGrowthMb.toFixed(1)} MB) must be bounded`);
});
