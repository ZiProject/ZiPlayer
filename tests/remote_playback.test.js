const test = require("node:test");
const assert = require("node:assert/strict");
const { PlayerManager, PlaybackMode } = require("../core/dist");

test("playRemote establishes REMOTE mode and delegates controls to remote handle", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-remote-1");

	const calls = [];
	const handle = {
		play: async () => {
			calls.push("play");
		},
		pause: async () => {
			calls.push("pause");
		},
		resume: async () => {
			calls.push("resume");
		},
		stop: async () => {
			calls.push("stop");
		},
		seek: async (pos) => {
			calls.push(`seek:${pos}`);
		},
		setVolume: async (vol) => {
			calls.push(`volume:${vol}`);
		},
		destroy: async () => {
			calls.push("destroy");
		},
	};

	const track = {
		id: "remote-track-1",
		title: "Remote Track",
		url: "https://example.com/remote",
		duration: 180000,
		requestedBy: "user",
		source: "lavalink",
	};

	assert.equal(player.playbackMode, PlaybackMode.NATIVE);

	// Start remote playback
	const ok = await player.playRemote(track, { remote: true, handle });
	assert.equal(ok, true);
	assert.equal(player.playbackMode, PlaybackMode.REMOTE);
	assert.equal(player.isPlaying, true);
	assert.equal(player.isPaused, false);
	assert.equal(player.isIdle, false);
	assert.ok(calls.includes("play"));

	// Pause
	const pauseOk = await player.pause();
	assert.equal(pauseOk, true);
	assert.equal(player.isPaused, true);
	assert.equal(player.isPlaying, false);
	assert.ok(calls.includes("pause"));

	// Resume
	const resumeOk = await player.resume();
	assert.equal(resumeOk, true);
	assert.equal(player.isPaused, false);
	assert.equal(player.isPlaying, true);
	assert.ok(calls.includes("resume"));

	// Seek
	const seekOk = await player.seek(30000);
	assert.equal(seekOk, true);
	assert.ok(calls.includes("seek:30000"));

	// Set Volume
	player.setVolume(60);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(calls.includes("volume:60"));

	// Exit Remote Mode
	player.exitRemoteMode();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(player.playbackMode, PlaybackMode.NATIVE);
	assert.ok(calls.includes("destroy"));
});

test("plugin returning remote: true sets REMOTE mode and exitRemoteMode restores NATIVE", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const calls = [];
	const handle = {
		play: async () => {
			calls.push("play");
		},
		pause: async () => {
			calls.push("pause");
		},
		resume: async () => {
			calls.push("resume");
		},
		stop: async () => {
			calls.push("stop");
		},
		seek: async (pos) => {
			calls.push(`seek:${pos}`);
		},
		setVolume: async (vol) => {
			calls.push(`volume:${vol}`);
		},
		destroy: async () => {
			calls.push("destroy");
		},
	};

	const remotePlugin = {
		name: "MockRemotePlugin",
		priority: 100,
		canHandle: () => true,
		validate: () => true,
		resolve: async (q) => ({
			tracks: [
				{
					id: "track-plugin-remote",
					title: "Plugin Remote Track",
					url: "https://example.com/mock-remote",
					duration: 200000,
					requestedBy: "user",
					source: "MockRemotePlugin",
				},
			],
		}),
		getStream: async () => ({
			type: "arbitrary",
			remote: true,
			handle,
		}),
	};

	const player = await mgr.create("guild-remote-2");
	player.addPlugin(remotePlugin);

	assert.equal(player.playbackMode, PlaybackMode.NATIVE);

	const track = {
		id: "track-plugin-remote",
		title: "Plugin Remote Track",
		url: "https://example.com/mock-remote",
		duration: 200000,
		requestedBy: "user",
		source: "MockRemotePlugin",
	};

	const playOk = await player.play(track);
	assert.ok(playOk);
	assert.equal(playOk.track.id, "track-plugin-remote");

	// Wait for stream to be loaded and remote handle attached
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(player.playbackMode, PlaybackMode.REMOTE);
	assert.equal(player.isPlaying, true);
	assert.ok(calls.includes("play"));

	// Pause
	const pauseOk = await player.pause();
	assert.equal(pauseOk, true);
	assert.equal(player.isPaused, true);
	assert.ok(calls.includes("pause"));

	// Resume
	const resumeOk = await player.resume();
	assert.equal(resumeOk, true);
	assert.equal(player.isPaused, false);
	assert.ok(calls.includes("resume"));

	// Exit Remote Mode
	player.exitRemoteMode();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(player.playbackMode, PlaybackMode.NATIVE);
	assert.ok(calls.includes("destroy"));
});
