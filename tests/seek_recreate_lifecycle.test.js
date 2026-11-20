const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { PlayerManager, BasePlugin, PLAYER_QUERY, BUS_EVENT } = require("../core/dist");

class MockRecreatePlugin extends BasePlugin {
	name = "mock-recreate";
	version = "1.0.0";

	constructor() {
		super();
		this.recreateCalls = [];
	}

	canHandle(url) {
		return typeof url === "string" && url.startsWith("mock:");
	}

	async search(query) {
		const id = query.replace("mock:", "");
		return {
			tracks: [
				{
					id,
					title: `Title ${id}`,
					url: `mock:${id}`,
					duration: 300,
					source: "mock-recreate",
				},
			],
			playlist: null,
		};
	}

	async getStream(track) {
		const initialStream = new Readable({
			read() {
				this.push(Buffer.from(`initial-audio-${track.id}`));
				this.push(null);
			},
		});
		initialStream._trackId = track.id;

		return {
			stream: initialStream,
			type: "arbitrary",
			recreate: async (position, signal) => {
				// Simulate async network latency of SABR stream creation (e.g. 50ms)
				await new Promise((resolve) => setTimeout(resolve, 50));
				this.recreateCalls.push({ trackId: track.id, position });

				const recreatedStream = new Readable({
					read() {
						this.push(Buffer.from(`recreated-audio-${track.id}-pos-${position}`));
						this.push(null);
					},
				});
				recreatedStream._trackId = track.id;
				recreatedStream._position = position;
				return recreatedStream;
			},
		};
	}
}

test("Player.seek with async recreate resolves without 'Playback resource controllers are unavailable'", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const plugin = new MockRecreatePlugin();
	mgr.registerPlugin(plugin);

	const player = await mgr.create("seek-test-guild");

	// Start playback of track 1
	const playResult = await player.play("mock:song-1");
	assert.ok(playResult?.track, "Track 1 should start playing");

	// Wait for playback state to settle
	await new Promise((resolve) => setTimeout(resolve, 50));

	// First seek must succeed immediately and not throw "Playback resource controllers are unavailable"
	const seekResult = await player.seek(30000);
	assert.equal(seekResult, true, "First seek should return true");

	assert.equal(plugin.recreateCalls.length, 1);
	assert.equal(plugin.recreateCalls[0].trackId, "song-1");
	assert.equal(plugin.recreateCalls[0].position, 30000);

	// The active resource should now belong to track 1 at 30000ms
	const currentTrack = mgr.bus.querySync(player.id, PLAYER_QUERY.currentTrack);
	assert.equal(currentTrack.id, "song-1");
});

test("Seeking on a new track does not play previous track's audio", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	const plugin = new MockRecreatePlugin();
	mgr.registerPlugin(plugin);

	const player = await mgr.create("seek-multi-track-guild");

	// 1. Play track 1
	await player.play("mock:track-A");
	await new Promise((resolve) => setTimeout(resolve, 50));

	// Seek on track 1
	const seek1 = await player.seek(15000);
	assert.equal(seek1, true, "Seek on track 1 must succeed");
	assert.equal(plugin.recreateCalls.at(-1).trackId, "track-A");

	// 2. Add track 2 and skip to it
	await player.play("mock:track-B");
	await player.skip();
	await new Promise((resolve) => setTimeout(resolve, 50));

	const currentTrackBeforeSeek = mgr.bus.querySync(player.id, PLAYER_QUERY.currentTrack);
	assert.equal(currentTrackBeforeSeek.id, "track-B");

	// 3. Seek on track 2
	const seek2 = await player.seek(45000);
	assert.equal(seek2, true, "Seek on track 2 must succeed");

	// Verify that recreate was called for track-B, NOT track-A!
	assert.equal(plugin.recreateCalls.at(-1).trackId, "track-B");
	assert.equal(plugin.recreateCalls.at(-1).position, 45000);

	// Current track must still be track-B
	const currentTrackAfterSeek = mgr.bus.querySync(player.id, PLAYER_QUERY.currentTrack);
	assert.equal(currentTrackAfterSeek.id, "track-B");
});
