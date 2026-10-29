const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { StreamManager } = require("../core/dist");

const track = { id: "active-stream", title: "Active stream", source: "test" };

test("StreamManager does not expire an active stream just because it has been playing longer than streamTimeout", () => {
	const manager = new StreamManager({ streamTimeout: 10, cleanupInterval: 0 });
	const stream = new PassThrough();
	const streamId = manager.registerStream(stream, track);
	const managed = manager.streams.get(streamId);
	managed.lastAccessed = Date.now() - 1000;

	manager.cleanupExpiredStreams();

	assert.equal(manager.streams.has(streamId), true);
	assert.equal(stream.destroyed, false);
	manager.dispose();
});

test("StreamManager still expires stale paused streams", () => {
	const manager = new StreamManager({ streamTimeout: 10, cleanupInterval: 0 });
	const stream = new PassThrough();
	const streamId = manager.registerStream(stream, track);
	const managed = manager.streams.get(streamId);
	managed.status = "paused";
	managed.lastAccessed = Date.now() - 1000;

	manager.cleanupExpiredStreams();

	assert.equal(manager.streams.has(streamId), false);
	assert.equal(stream.destroyed, true);
	manager.dispose();
});
