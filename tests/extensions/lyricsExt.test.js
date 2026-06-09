const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../../core/dist");
const { lyricsExt } = require("../../extension/dist");

function makeTrack(id = "t1", title = "Track 1", author) {
	return {
		id,
		title,
		url: `https://example.com/${id}`,
		duration: 210,
		requestedBy: "tester",
		source: "test",
		metadata: author ? { author } : {},
	};
}

test("lyricsExt attaches lyrics on trackStart and emits event", async (t) => {
	const ext = new lyricsExt(null, { autoFetchOnTrackStart: true });
	// Stub fetch to avoid network
	ext.fetch = async (track) => ({
		provider: "lrclib",
		source: "LRCLIB",
		url: "https://lrclib.net/",
		text: `Lyrics for ${track.title}`,
		synced: null,
		trackName: track.title,
		artistName: (track.metadata && track.metadata.author) || undefined,
		albumName: undefined,
		matchedBy: "test",
		lang: null,
	});

	const mgr = new PlayerManager({ extensions: [ext] });
	t.after(() => mgr.destroy());

	const player = await mgr.create("guild-lyrics-1", { extensions: ["lyricsExt"] });

	let payload = null;
	let changed = null;
	mgr.on("lyricsCreate", (plr, track, res) => {
		payload = { plr, track, res };
	});
	mgr.on("lyricsChange", (plr, track, res) => {
		changed = { plr, track, res };
	});

	const track = makeTrack("a1", "Artist - Song Title (Official Video) [Lyrics]", "Artist");
	player.emit("trackStart", track);

	await new Promise((r) => setTimeout(r, 20));

	assert.ok(payload, "lyricsCreate should be emitted");
	assert.equal(payload.plr, player);
	assert.equal(payload.track.id, "a1");
	assert.ok(payload.track.metadata && payload.track.metadata.lyrics, "lyrics should be attached to metadata");
	assert.equal(payload.track.metadata.lyrics.provider, "lrclib");
	assert.equal(typeof payload.track.metadata.lyrics.text, "string");
	assert.ok(changed, "lyricsChange should be emitted");
	assert.equal(changed.plr, player);
});

test("lyricsExt falls back to lyrics.ovh when lrclib not found", async () => {
	const ext = new lyricsExt();
	// Force fallback path
	ext.queryLRCLIB = async () => null;
	ext.queryLyricsOVH = async () => "plain lyrics text";

	const res = await ext.fetch(makeTrack("b1", "Some Title", "Some Artist"));
	assert.ok(res);
	assert.equal(res.provider, "lyricsovh");
	assert.equal(res.text, "plain lyrics text");
	assert.equal(res.synced, null);
});

test("lyricsExt sanitizes title passed to provider", async () => {
	const ext = new lyricsExt();
	let seen = null;
	ext.queryLRCLIB = async (input) => {
		seen = input; // capture title/artist we pass to lrclib
		return { plainLyrics: "x", syncedLyrics: null };
	};

	const raw = "Artist - My Song (Official Video) [Lyrics] ft. Someone | 4K";
	await ext.fetch(makeTrack("c1", raw));

	assert.ok(seen);
	assert.equal(seen.title, "My Song");
	assert.equal(seen.artist, "Artist");
});
