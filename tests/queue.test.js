const test = require("node:test");
const assert = require("node:assert/strict");

const { QueueController, PlayerAction, PlayerBus } = require("../core/dist");

function makeTrack(id = "t1", title = "Track 1") {
	return {
		id,
		title,
		url: `https://example.com/${id}`,
		duration: 120,
		requestedBy: "tester",
		source: "test",
	};
}

function makeQueue() {
	const bus = new PlayerBus();
	const queue = new QueueController({ bus });
	return { bus, queue };
}

test("QueueController add/remove/size basics", () => {
	const { queue } = makeQueue();

	assert.equal(queue.size, 0);

	const t1 = makeTrack("a");

	queue.add(t1);

	assert.equal(queue.size, 1);

	const removed = queue.remove(0);

	assert.deepEqual(removed, t1);
	assert.equal(queue.size, 0);

	queue.dispose();
});

test("QueueController next, history and currentTrack", () => {
	const { queue } = makeQueue();

	const t1 = makeTrack("a");
	const t2 = makeTrack("b");

	queue.addMultiple([t1, t2]);

	assert.equal(queue.currentTrack, null);

	const n1 = queue.next();

	assert.equal(n1.id, "a");
	assert.equal(queue.currentTrack.id, "a");

	const n2 = queue.next();

	assert.equal(n2.id, "b");
	assert.equal(queue.previousTracks.length, 1);
	assert.equal(queue.previousTracks[0].id, "a");
	assert.equal(queue.nextTrack, null);

	queue.dispose();
});

test("QueueController restores a cancelled next operation", () => {
	const { queue } = makeQueue();

	const current = makeTrack("current");
	const next = makeTrack("next");

	queue.setCurrentTrack(current);
	queue.add(next);

	assert.equal(queue.next().id, "next");

	queue.restoreNext(current, next);

	assert.equal(queue.currentTrack.id, "current");
	assert.deepEqual(queue.previousTracks, []);
	assert.equal(queue.nextTrack.id, "next");

	queue.dispose();
});

test("QueueController loop track repeats current", () => {
	const { queue } = makeQueue();

	const t1 = makeTrack("a");

	queue.add(t1);
	queue.loop("track");

	const n1 = queue.next();
	assert.equal(n1.id, "a");

	const n2 = queue.next();
	assert.equal(n2.id, "a");

	queue.dispose();
});

test("QueueController loop queue recycles history", () => {
	const { queue } = makeQueue();

	const t1 = makeTrack("a");
	const t2 = makeTrack("b");

	queue.addMultiple([t1, t2]);
	queue.loop("queue");

	queue.next(); // a
	queue.next(); // b

	const n3 = queue.next();

	assert.equal(n3.id, "a");

	queue.dispose();
});

test("QueueController shuffle changes order", () => {
	const { queue } = makeQueue();

	const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);

	queue.addMultiple(ids.map((id) => makeTrack(id)));

	const before = queue
		.getTracks()
		.map((track) => track.id)
		.join(",");

	queue.shuffle();

	const after = queue
		.getTracks()
		.map((track) => track.id)
		.join(",");

	// Extremely unlikely for a 10-item shuffle to retain
	// exactly the same order.
	assert.notEqual(after, before);

	queue.dispose();
});

test("QueueController willNextTrack setter/getter", () => {
	const { queue } = makeQueue();

	const t = makeTrack("hint");

	assert.equal(queue.willNextTrack(), null);

	queue.willNextTrack(t);

	assert.equal(queue.willNextTrack().id, "hint");

	queue.dispose();
});

test("QueueController restores bounded valid state", () => {
	const { queue } = makeQueue();

	const original = makeTrack("original");

	const sameUrl = {
		...original,
		id: undefined,
	};

	queue.fromJSON({
		tracks: [sameUrl, null, "invalid"],
		current: null,
		history: [original, null],
		loopMode: "invalid",
		autoPlay: "yes",
	});

	assert.equal(queue.size, 1);
	assert.equal(queue.indexOf(original), 0);
	assert.equal(queue.previousTracks.length, 1);
	assert.equal(queue.getLoopMode(), "off");
	assert.equal(queue.autoPlay(), false);

	queue.dispose();
});

test("QueueController setCurrentTrack routes through PlayerBus", () => {
	const { bus, queue } = makeQueue();

	const track = makeTrack("current");

	queue.setCurrentTrack(track);

	assert.equal(queue.currentTrack.id, "current");
	assert.deepEqual(bus.querySync("currentTrack"), track);

	queue.dispose();
});

test("QueueController serialize/restore routes through PlayerBus", () => {
	const { bus, queue } = makeQueue();

	const t1 = makeTrack("a");
	const t2 = makeTrack("b");

	queue.addMultiple([t1, t2]);
	queue.next();

	const serialized = queue.toJSON();

	assert.ok(serialized);
	assert.deepEqual(bus.querySync("queueSerialized"), serialized);

	const { queue: restored } = makeQueue();

	restored.fromJSON(serialized);

	assert.equal(restored.size, 1);
	assert.equal(restored.currentTrack.id, "a");
	assert.deepEqual(restored.getTracks()[0], t2);

	queue.dispose();
	restored.dispose();
});

test("PlayerAction serializes normal actions", async () => {
	const bus = new PlayerBus();
	const actionExecutor = new PlayerAction(bus);
	const order = [];

	bus.onAction(async (action) => {
		order.push(`${action.type}:start`);

		await new Promise((resolve) => setTimeout(resolve, 5));

		order.push(`${action.type}:end`);
	});

	await Promise.all([actionExecutor.enqueue({ type: "PLAY" }), actionExecutor.enqueue({ type: "PLAY" })]);

	assert.deepEqual(order, ["PLAY:start", "PLAY:end", "PLAY:start", "PLAY:end"]);

	actionExecutor.dispose();
});

test("PlayerAction serializes critical actions", async () => {
	const bus = new PlayerBus();
	const actionExecutor = new PlayerAction(bus);
	const order = [];

	bus.onAction(async (action) => {
		order.push(`${action.type}:start`);

		await new Promise((resolve) => setTimeout(resolve, 5));

		order.push(`${action.type}:end`);
	});

	const first = actionExecutor.enqueue({ type: "SKIP" });

	await new Promise((resolve) => setTimeout(resolve, 0));

	const second = actionExecutor.enqueue({ type: "STOP" });

	await Promise.all([first, second]);

	assert.deepEqual(order, ["SKIP:start", "SKIP:end", "STOP:start", "STOP:end"]);

	actionExecutor.dispose();
});
