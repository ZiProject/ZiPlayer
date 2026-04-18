const test = require("node:test");
const assert = require("node:assert/strict");

const { TTSPlugin } = require("../../plugins/dist");

test("TTS canHandle variants", () => {
	const tts = new TTSPlugin({ defaultLang: "en" });
	assert.equal(tts.canHandle("tts: hello"), true);
	assert.equal(tts.canHandle("say hello world"), false);
	assert.equal(tts.canHandle("hello"), false);
});

test("TTS search builds track and encodes metadata", async () => {
	const tts = new TTSPlugin({ defaultLang: "en" });
	const res = await tts.search("tts:en:1:Good morning", "me");
	assert.equal(res.tracks.length, 1);
	const tr = res.tracks[0];
	assert.ok(tr.id.startsWith("tts-"));
	assert.equal(tr.source, "tts");
	assert.equal(tr.requestedBy, "me");
	assert.ok(tr.url.startsWith("tts://"));
	assert.ok(tr.metadata && tr.metadata.tts);
});
