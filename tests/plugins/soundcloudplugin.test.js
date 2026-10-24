const test = require("node:test");
const assert = require("node:assert/strict");

// Avoid constructor side effects; call prototype methods directly.
const { SoundCloudPlugin } = require("../../plugins/dist/SoundCloudPlugin.js");

test("SoundCloud validate and canHandle heuristics", () => {
	const sc = Object.create(SoundCloudPlugin.prototype);
	assert.equal(sc.validate("https://soundcloud.com/user/track"), true);
	assert.equal(sc.validate("https://example.com/user/track"), false);

	// URLs with soundcloud host are handled
	assert.equal(sc.canHandle("https://soundcloud.com/user/track"), true);
	// Free text mentioning soundcloud is handled
	assert.equal(sc.canHandle("search soundcloud best tracks"), true);
	// Generic text  soundcloud is handled
	assert.equal(sc.canHandle("random search text"), true);
	// TTS pattern is ignored
	assert.equal(sc.canHandle("tts: hello"), false);
});

test("SoundCloud search ignores queries it cannot handle", async () => {
	const sc = Object.create(SoundCloudPlugin.prototype);
	sc.ready = Promise.resolve();
	sc.client = {
		search: () => {
			throw new Error("client.search should not be called for unhandled queries");
		},
	};

	const result = await sc.search("tts:vi: Chỉ Bằng Cái Gật Đầu", "user123");
	assert.deepEqual(result, { tracks: [] });
});
