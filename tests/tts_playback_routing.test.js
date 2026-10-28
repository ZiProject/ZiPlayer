const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { PlayerManager, BasePlugin, CONTROLLER_RPC, PLAYER_RPC, PLAYER_QUERY } = require("../core/dist");

class MockTTSPlugin extends BasePlugin {
	name = "tts";
	version = "1.0.0";
	priority = 20;

	canHandle(query) {
		return typeof query === "string" && query.trim().toLowerCase().startsWith("tts:");
	}

	async search(query, requestedBy) {
		return {
			tracks: [
				{
					id: `tts-${Date.now()}`,
					title: `TTS: ${query}`,
					url: `tts://${Buffer.from(query).toString("base64")}`,
					duration: 3,
					requestedBy,
					source: "tts",
					metadata: { tts: { text: query, lang: "vi", slow: false } },
				},
			],
		};
	}

	async getStream() {
		throw new Error("getStream not used in this test");
	}
}

class MockMusicPlugin extends BasePlugin {
	name = "music";
	version = "1.0.0";
	priority = 10;

	canHandle(query) {
		if (typeof query === "string" && query.trim().toLowerCase().startsWith("tts:")) {
			return false;
		}
		return true;
	}

	async search(query, requestedBy) {
		return {
			tracks: [
				{
					id: "music-123",
					title: "Some Song",
					url: "https://music.example.com/song",
					duration: 200,
					requestedBy,
					source: "music",
				},
			],
		};
	}

	async getStream() {
		throw new Error("getStream not used in this test");
	}
}

test("search with tts: query invokes only TTS-capable plugins via canHandle filter", async (t) => {
	let musicSearched = false;
	class SpiedMusicPlugin extends MockMusicPlugin {
		async search(query, requestedBy) {
			musicSearched = true;
			return super.search(query, requestedBy);
		}
	}

	const mgr = new PlayerManager({
		autoCleanup: false,
		plugins: [new MockTTSPlugin(), new SpiedMusicPlugin()],
	});
	t.after(() => mgr.destroy());

	const result = await mgr.search("tts:vi: Chỉ Bằng Cái Gật Đầu", "user-1");

	assert.equal(musicSearched, false, "Music plugin should not be searched for a tts: query");
	assert.equal(result.tracks.length, 1);
	assert.equal(result.tracks[0].source, "tts");
	assert.ok(result.tracks[0].id.startsWith("tts-"));
});

test("search prioritizes TTS tracks to index 0 when query starts with tts:", async (t) => {
	class IgnorantMusicPlugin extends BasePlugin {
		name = "ignorant-music";
		version = "1.0.0";
		priority = 100; // higher than TTS

		canHandle() {
			return true;
		}

		async search(query, requestedBy) {
			return {
				tracks: [
					{
						id: "song-1",
						title: "Music Track",
						url: "https://example.com/song",
						duration: 180,
						requestedBy,
						source: "ignorant-music",
					},
				],
			};
		}

		async getStream() {
			throw new Error("not used");
		}
	}

	const mgr = new PlayerManager({
		autoCleanup: false,
		plugins: [new MockTTSPlugin(), new IgnorantMusicPlugin()],
	});
	t.after(() => mgr.destroy());

	const result = await mgr.search("tts:vi: Chỉ Bằng Cái Gật Đầu", "user-1");

	assert.equal(result.tracks.length, 2);
	// TTS track must be prioritized to index 0 despite lower plugin priority
	assert.equal(result.tracks[0].source, "tts");
	assert.equal(result.tracks[1].source, "ignorant-music");
});

test("PlaybackPlayController prioritizes TTS track and plays it via ttsPlay RPC", async (t) => {
	const mgr = new PlayerManager({
		autoCleanup: false,
		plugins: [new MockTTSPlugin()],
	});
	t.after(() => mgr.destroy());

	const player = await mgr.create("tts-guild-1");

	let ttsPlayedTrack = null;
	// Intercept ttsPlay RPC on the bus
	const bus = player.bus;
	bus.registerRpc(CONTROLLER_RPC.ttsPlay, async ({ track }) => {
		ttsPlayedTrack = track;
	});

	const res = await player.play("tts:vi: Chỉ Bằng Cái Gật Đầu", "user-1");
	assert.ok(res);
	assert.ok(ttsPlayedTrack, "ttsPlay should be called");
	assert.equal(ttsPlayedTrack.source, "tts");
});

test("PlaybackPlayController does not call ttsPlay with a non-TTS track", async (t) => {
	class MusicOnlyPlugin extends BasePlugin {
		name = "music-only";
		version = "1.0.0";
		canHandle() {
			return true;
		}
		async search(query, requestedBy) {
			return {
				tracks: [
					{
						id: "regular-song",
						title: "Regular Song",
						url: "https://example.com/song",
						duration: 100,
						requestedBy,
						source: "music-only",
					},
				],
			};
		}
		async getStream() {
			throw new Error("not used");
		}
	}

	const mgr = new PlayerManager({
		autoCleanup: false,
		plugins: [new MusicOnlyPlugin()],
	});
	t.after(() => mgr.destroy());

	const player = await mgr.create("tts-guild-2");

	let ttsPlayCalled = false;
	const bus = player.bus;
	bus.registerRpc(CONTROLLER_RPC.ttsPlay, async () => {
		ttsPlayCalled = true;
	});

	// Query starts with tts:, but the only track returned is a regular music track.
	// PlaybackPlayController should NOT call ttsPlay with that non-TTS track.
	const res = await player.play("tts:vi: Chỉ Bằng Cái Gật Đầu", "user-1");
	assert.equal(ttsPlayCalled, false, "ttsPlay should NOT be called for a non-TTS track");
	assert.ok(res);
	assert.equal(res.track.id, "regular-song");
});

test("Concurrent player.play() for TTS A and B both return valid PlayResult in FIFO order", async (t) => {
	const executionOrder = [];

	class StreamingTTSPlugin extends MockTTSPlugin {
		async getStream(track) {
			executionOrder.push({ id: track.id, title: track.title, status: "stream_requested" });
			const s = new Readable({
				read() {
					this.push(Buffer.alloc(100));
					this.push(null);
				},
			});
			return { stream: s, remote: false };
		}
	}

	const mgr = new PlayerManager({
		autoCleanup: false,
		plugins: [new StreamingTTSPlugin()],
	});
	t.after(() => mgr.destroy());

	const player = await mgr.create("tts-guild-concurrency");

	// Provide a mock voice connection on ConnectionController for TTS playback
	const mockVoiceConnection = {
		state: { status: "ready" },
		subscribe: () => ({ unsubscribe: () => {} }),
	};
	mgr.controllers.connection.slots.get("tts-guild-concurrency").connection = mockVoiceConnection;

	// Fire A and B concurrently before A finishes
	const promiseA = player.play("tts:Message A", "user-1");
	const promiseB = player.play("tts:Message B", "user-2");

	const [resA, resB] = await Promise.all([promiseA, promiseB]);

	// Both must return truthy PlayResult objects (not false)
	assert.ok(resA, "First TTS request (A) must return truthy PlayResult, not false");
	assert.equal(typeof resA, "object");
	assert.ok(resA.track.title.includes("Message A"));

	assert.ok(resB, "Second TTS request (B) must return truthy PlayResult, not false");
	assert.equal(typeof resB, "object");
	assert.ok(resB.track.title.includes("Message B"));

	// Check stream resolution order: Message A stream requested first, then Message B
	const streamsRequested = executionOrder.filter((e) => e.status === "stream_requested");
	assert.equal(streamsRequested.length, 2);
	assert.ok(streamsRequested[0].title.includes("Message A"));
	assert.ok(streamsRequested[1].title.includes("Message B"));
});
