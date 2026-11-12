const test = require("node:test");
const assert = require("node:assert/strict");

const { TTSPlugin } = require("../../plugins/dist");

test("TTS canHandle variants", () => {
	const tts = new TTSPlugin({ defaultLang: "en" });
	assert.equal(tts.priority, 20);
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

test("TTS falls back to Google when Edge TTS fails", async () => {
	const ttsModule = require("@ziplayer/tts");
	const axios = require("axios");
	const originalVoices = ttsModule.getEdgeTTSVoices;
	const originalGetEdgeTTS = ttsModule.getEdgeTTS;
	const originalGetUrls = ttsModule.getTTSUrls;
	const originalAxiosGet = axios.get;

	try {
		ttsModule.getEdgeTTSVoices = async () => [{ Name: "en-US-AriaNeural", Locale: "en-US" }];
		ttsModule.getEdgeTTS = async () => {
			throw new Error("Edge TTS WebSocket error");
		};
		ttsModule.getTTSUrls = () => ["https://example.com/tts.mp3"];
		axios.get = async () => ({ data: Buffer.from("fake-audio") });

		const tts = new TTSPlugin({ defaultLang: "en" });
		const info = await tts.getStream({
			id: "tts-1",
			title: "TTS: hello",
			url: "tts://e30=",
			duration: 1,
			requestedBy: "me",
			source: "tts",
			metadata: { tts: { text: "hello", lang: "en", slow: false } },
		});
		assert.ok(info.stream);
		assert.equal(info.type, "arbitrary");
		assert.ok(info.metadata && typeof info.metadata.size === "number" && info.metadata.size > 0);
	} finally {
		ttsModule.getEdgeTTSVoices = originalVoices;
		ttsModule.getEdgeTTS = originalGetEdgeTTS;
		ttsModule.getTTSUrls = originalGetUrls;
		axios.get = originalAxiosGet;
	}
});
