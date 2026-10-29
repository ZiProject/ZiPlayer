"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { StreamType, AudioPlayerStatus } = require("@discordjs/voice");
const { Bus, PlaybackController, PlayerManager } = require("../core/dist");

function createMockAudioPlayer() {
	return Object.assign(new EventEmitter(), {
		state: { status: AudioPlayerStatus.Idle },
		play(resource) {
			this.state.status = AudioPlayerStatus.Playing;
			this.emit("stateChange", { status: AudioPlayerStatus.Idle }, { status: AudioPlayerStatus.Playing, resource });
		},
		stop() {
			const prev = this.state.status;
			this.state.status = AudioPlayerStatus.Idle;
			this.emit("stateChange", { status: prev }, { status: AudioPlayerStatus.Idle });
			return true;
		},
		pause() {
			if (this.state.status === AudioPlayerStatus.Playing) {
				this.state.status = AudioPlayerStatus.Paused;
				this.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Paused });
				return true;
			}
			return false;
		},
		unpause() {
			if (this.state.status === AudioPlayerStatus.Paused) {
				this.state.status = AudioPlayerStatus.Playing;
				this.emit("stateChange", { status: AudioPlayerStatus.Paused }, { status: AudioPlayerStatus.Playing });
				return true;
			}
			return false;
		},
	});
}

test("Architectural: removed processing engine symbols are not exported", () => {
	const core = require("../core/dist");
	assert.equal(core.createAudioProcessingEngine, undefined, "createAudioProcessingEngine must not be exported");
	assert.equal(core.FFmpegAudioProcessingEngine, undefined, "FFmpegAudioProcessingEngine must not be exported");
	assert.equal(core.defaultAudioProcessingEngine, undefined, "defaultAudioProcessingEngine must not be exported");
	assert.equal(core.resolveAudioProcessingOptions, undefined, "resolveAudioProcessingOptions must not be exported");
	assert.equal(core.getFfmpegProcessStats, undefined, "getFfmpegProcessStats must not be exported");
	assert.equal(core.configureFfmpegConcurrency, undefined, "configureFfmpegConcurrency must not be exported");
});

test("PlaybackController creates direct inline-volume resource without FFmpeg for normal playback", async () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = createMockAudioPlayer();
	const playerId = "direct-normal-1";

	controller.attach(playerId, { audioPlayer, stuckTimeoutMs: 1000 });

	const source = Readable.from([Buffer.from([0xf8, 0xff, 0xfe, 0x00])]);
	const track = { id: "t1", title: "Direct Opus", duration: 120 };

	const resource = controller.createResource(playerId, source, track, StreamType.Opus);

	assert.ok(resource, "Resource must be created");
	assert.ok(resource.volume, "Resource must have inline volume enabled");
	assert.equal(resource.metadata, track, "Resource metadata must match track");

	// Play stream is the original stream wrapper, not a secondary FFmpeg process
	await controller.play(playerId, resource);
	assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing);

	await controller.stop(playerId);
	assert.equal(audioPlayer.state.status, AudioPlayerStatus.Idle);

	controller.detach(playerId);
});

test("PlaybackController rejects raw audio input and destroys source stream", () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = createMockAudioPlayer();
	const playerId = "raw-input-test";

	controller.attach(playerId, { audioPlayer, stuckTimeoutMs: 1000 });

	const source = Readable.from([Buffer.alloc(64)]);
	const track = { id: "raw-t", title: "Raw audio", duration: 10 };

	assert.throws(() => controller.createResource(playerId, source, track, StreamType.Raw), /raw audio input is unsupported/i);
	assert.equal(source.destroyed, true, "Source stream must be destroyed on raw audio rejection");

	controller.detach(playerId);
});

test("Playback controls: volume, pause, resume, stop work correctly on direct resource", async () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = createMockAudioPlayer();
	const playerId = "controls-test";

	controller.attach(playerId, { audioPlayer, stuckTimeoutMs: 1000 });

	const source = Readable.from([Buffer.from([0xf8, 0xff, 0xfe, 0x01])]);
	const track = { id: "ctrl-t", title: "Control track", duration: 60 };

	const resource = controller.createResource(playerId, source, track, StreamType.Opus);
	await controller.play(playerId, resource);

	assert.equal(controller.status(playerId), AudioPlayerStatus.Playing);

	// Pause
	const paused = await controller.pause(playerId);
	assert.equal(paused, true);
	assert.equal(controller.status(playerId), AudioPlayerStatus.Paused);

	// Resume
	const resumed = await controller.resume(playerId);
	assert.equal(resumed, true);
	assert.equal(controller.status(playerId), AudioPlayerStatus.Playing);

	// Volume adjustment
	assert.ok(resource.volume);
	resource.volume.setVolume(0.5);
	assert.equal(resource.volume.volume, 0.5);

	// Stop
	const stopped = await controller.stop(playerId);
	assert.equal(stopped, true);
	assert.equal(controller.status(playerId), AudioPlayerStatus.Idle);

	controller.detach(playerId);
});

test("PlayerManager creates player and accepts normal playback without audioProcessing engine", async () => {
	const manager = new PlayerManager();
	try {
		const player = await manager.create("guild-no-engine", {
			volume: 75,
		});
		assert.ok(player);
		assert.equal(player.volume, 75);

		// Creating an inline-volume resource directly on the player
		const source = Readable.from([Buffer.from([0xf8, 0xff, 0xfe, 0x02])]);
		const track = { id: "mgr-t1", title: "Player resource", duration: 30 };
		const resource = player.createResource(source, track);

		assert.ok(resource);
		assert.ok(resource.volume);
		assert.equal(resource.metadata, track);

		resource.playStream.destroy();
	} finally {
		manager.destroy();
	}
});

test("AbortSignal cancels resource creation and destroys stream", () => {
	const bus = new Bus();
	const controller = new PlaybackController(bus);
	const audioPlayer = createMockAudioPlayer();
	const playerId = "abort-resource-test";

	controller.attach(playerId, { audioPlayer, stuckTimeoutMs: 1000 });

	const abortController = new AbortController();
	abortController.abort(); // already aborted

	const source = Readable.from([Buffer.from([0xf8, 0xff, 0xfe])]);
	const track = { id: "aborted-t", title: "Aborted Track", duration: 50 };

	const resource = controller.createResource(playerId, source, track, StreamType.Opus, abortController.signal);
	assert.equal(source.destroyed, true, "Source must be destroyed when signal is aborted");

	resource.playStream.destroy();
	controller.detach(playerId);
});
