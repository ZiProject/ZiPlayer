const test = require("node:test");
const assert = require("node:assert/strict");

// Load the class without running its constructor-heavy init. We'll use the prototype directly.
const { YouTubePlugin } = require("../../plugins/dist/YouTubePlugin.js");

test("YouTube canHandle and validate basic cases", () => {
	const yt = Object.create(YouTubePlugin.prototype);

	// URLs
	assert.equal(yt.validate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
	assert.equal(yt.validate("https://youtu.be/dQw4w9WgXcQ"), true);
	assert.equal(yt.validate("https://example.com/watch?v=123"), false);

	// Avoid handling tts/spotify/soundcloud text
	assert.equal(yt.canHandle("tts:hi"), false);
	assert.equal(yt.canHandle("spotify:track:123"), false);
	assert.equal(yt.canHandle("https://soundcloud.com/foo/bar"), false);

	// Generic text is handled (search) by YouTube
	assert.equal(yt.canHandle("never gonna give you up"), true);
});

test("YouTube stream source order respects preferYoutubei", async () => {
	const track = { id: "video-id", title: "Test track" };
	const youtubeiResult = { stream: "youtubei-stream", type: "arbitrary" };
	const sabrResult = { stream: "sabr-stream", type: "arbitrary" };
	const createHarness = (options = {}) => {
		const plugin = Object.create(YouTubePlugin.prototype);
		plugin.options = options;
		plugin.ready = Promise.resolve();
		plugin.debug = () => {};
		plugin.extractVideoId = () => track.id;
		return plugin;
	};

	const defaultPlugin = createHarness();
	const defaultAttempts = [];
	defaultPlugin.downloadWithSabr = async () => {
		defaultAttempts.push("sabr");
		return sabrResult;
	};
	defaultPlugin.downloadWithYoutubei = async () => {
		defaultAttempts.push("youtubei");
		return youtubeiResult;
	};
	assert.equal(await defaultPlugin.getStream(track), sabrResult);
	assert.deepEqual(defaultAttempts, ["sabr"]);

	const preferredPlugin = createHarness({ preferYoutubei: true });
	const preferredAttempts = [];
	preferredPlugin.downloadWithSabr = async () => {
		preferredAttempts.push("sabr");
		return sabrResult;
	};
	preferredPlugin.downloadWithYoutubei = async () => {
		preferredAttempts.push("youtubei");
		return youtubeiResult;
	};
	assert.equal(await preferredPlugin.getStream(track), youtubeiResult);
	assert.deepEqual(preferredAttempts, ["youtubei"]);
});
