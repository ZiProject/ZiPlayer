const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { PlayerManager, createOpusAudioResource, PLAYER_QUERY } = require("../core/dist");

const { VoiceConnectionStatus } = require("@discordjs/voice");

function createFakeVoiceConnection() {
	return {
		state: {
			status: VoiceConnectionStatus.Ready,
			subscription: undefined,
		},
		preparedPackets: [],
		dispatchedPackets: [],
		speaking: false,
		prepareAudioPacket(packet) {
			this.preparedPackets.push(Buffer.from(packet));
		},
		dispatchAudio() {
			if (this.preparedPackets.length > 0) {
				this.dispatchedPackets.push(this.preparedPackets[this.preparedPackets.length - 1]);
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

function createSampleResource(title = "Direct Track") {
	const packets = [
		Buffer.from([0xf8, 0xff, 0xfe, 0x01]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x02]),
		Buffer.from([0xf8, 0xff, 0xfe, 0x03]),
	];
	const stream = Readable.from(packets, { objectMode: true });
	return createOpusAudioResource(stream, {
		metadata: { title },
	});
}

test("Player.play(AudioResource) integrates with PlaybackController lifecycle", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("direct-resource-guild");
	const voiceConnection = createFakeVoiceConnection();
	voiceConnection.subscribe(player);

	// 1. Play direct resource
	const resource1 = createSampleResource("Resource Track 1");
	const result1 = await player.play(resource1);

	assert.ok(result1, "player.play(resource) should return a truthy result");
	assert.equal(typeof result1, "object");
	assert.equal(result1.track.title, "Resource Track 1");
	assert.equal(player.currentTrack?.title, "Resource Track 1");

	// Wait briefly for AudioPlayer state to transition
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(player.isPlaying, true);

	// 2. Pause the direct resource
	const pauseResult = await player.pause();
	assert.equal(pauseResult, true, "player.pause() should succeed on direct resource");
	assert.equal(player.isPaused, true, "player.isPaused should be true after pause()");

	// 3. Resume the direct resource
	const resumeResult = await player.resume();
	assert.equal(resumeResult, true, "player.resume() should succeed on direct resource");
	assert.equal(player.isPaused, false, "player.isPaused should be false after resume()");
	assert.equal(player.isPlaying, true, "player.isPlaying should be true after resume()");

	// 4. Replace direct resource with another direct resource
	const resource2 = createSampleResource("Resource Track 2");
	const result2 = await player.play(resource2);

	assert.ok(result2, "replacing with new resource should succeed");
	assert.equal(result2.track.title, "Resource Track 2");
	assert.equal(player.currentTrack?.title, "Resource Track 2");

	// 5. Stop direct resource
	const stopResult = await player.stop();
	assert.equal(stopResult, true, "player.stop() should succeed on direct resource");
	assert.equal(player.isPlaying, false, "player.isPlaying should be false after stop()");
	assert.equal(
		player.bus.querySync(player.playerId, PLAYER_QUERY.currentResource),
		null,
		"activeResource should be null after stop()",
	);
});

test("Player.play(AudioResource) emits trackStarted and coordinates session replacement", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("direct-resource-events-guild");
	const voiceConnection = createFakeVoiceConnection();
	voiceConnection.subscribe(player);

	const startedTracks = [];
	player.on("trackStart", (track) => {
		startedTracks.push(track.title);
	});

	const resA = createSampleResource("Track A");
	await player.play(resA);
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(player.currentTrack?.title, "Track A");
	assert.ok(startedTracks.includes("Track A"), "trackStart must be emitted for direct resource");

	const resB = createSampleResource("Track B");
	await player.play(resB);
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(player.currentTrack?.title, "Track B");
	assert.ok(startedTracks.includes("Track B"), "trackStart must be emitted for replaced resource");
	assert.equal(player.isPlaying, true);

	await player.stop();
	assert.equal(player.isPlaying, false);
});
