const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { normalizeStreamInfo, PlayerManager } = require("../core/dist");
const { BasePlugin } = require("../core/dist/plugins/BasePlugin");

test("normalizeStreamInfo assigns default destroy hook that cleans up stream and handle", () => {
	const stream = new Readable({ read() {} });

	let handleDestroyed = false;
	const handle = {
		play: async () => {},
		stop: async () => {},
		pause: async () => {},
		resume: async () => {},
		seek: async () => {},
		destroy: async () => {
			handleDestroyed = true;
		},
	};

	const track = { title: "Test Track", url: "https://example.com" };
	const info = normalizeStreamInfo(track, { stream, handle });

	assert.equal(typeof info.destroy, "function");
	assert.equal(info.streamType, "arbitrary");

	info.destroy();
	assert.equal(stream.destroyed, true);
	assert.equal(handleDestroyed, true);
});

test("normalizeStreamInfo invokes custom plugin destroy hook and default cleanup", () => {
	let customDestroyCalled = false;
	const stream = new Readable({ read() {} });
	const track = { title: "Test Track", url: "https://example.com" };

	const info = normalizeStreamInfo(track, {
		stream,
		destroy: () => {
			customDestroyCalled = true;
		},
	});

	info.destroy();
	assert.equal(customDestroyCalled, true);
	assert.equal(stream.destroyed, true);
});

test("saveVideo forwards signal and executes destroy hook when stream is aborted", async (t) => {
	let destroyCalled = false;
	const stream = new Readable({ read() {} });

	class VideoPlugin extends BasePlugin {
		constructor() {
			super();
			this.name = "video-test";
		}
		canHandle(q) {
			return typeof q === "string" && q.includes("video-test");
		}
		async getVideo(track, signal) {
			return {
				stream,
				type: "arbitrary",
				destroy: () => {
					destroyCalled = true;
				},
			};
		}
	}

	const manager = new PlayerManager({ autoCreatePlayer: true, plugins: [new VideoPlugin()] });
	t.after(() => player.destroy());

	const player = await manager.create("save-video-abort-test");

	const controller = new AbortController();
	const saveStream = await player.saveVideo(
		{ title: "Video Track", url: "https://video-test/123", source: "video-test" },
		{ signal: controller.signal },
	);

	assert.ok(saveStream);
	assert.equal(typeof saveStream.destroyStream, "function");

	controller.abort();
	assert.equal(destroyCalled, true);
	assert.equal(stream.destroyed, true);
});
