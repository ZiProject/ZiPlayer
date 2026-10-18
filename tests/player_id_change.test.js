const test = require("node:test");
const assert = require("node:assert/strict");

const { BUS_EVENT, PlayerManager } = require("../core/dist");

function makeTrack(id) {
	return { id, title: id, url: `https://example.com/${id}`, duration: 1, requestedBy: "tester", source: "test" };
}

test("changing a player ID preserves player state and updates manager lookups", async (t) => {
	const manager = new PlayerManager({ autoCleanup: false });
	t.after(() => manager.destroy());

	const player = await manager.create("guild-before");
	assert.equal(
		player.data.get("@ziplayer/controller.queue.states"),
		player.queue,
		"controller state must be written directly into player.data",
	);
	player.setVolume(37);
	player.queue.add(makeTrack("queued-track"));

	assert.equal(player.changePlayerId("guild-after"), player);
	assert.equal(player.id, "guild-after");
	assert.equal(player.playerId, "guild-after");
	assert.equal(manager.get("guild-before"), undefined);
	assert.equal(manager.has("guild-before"), false);
	assert.equal(manager.get("guild-after"), player);
	assert.equal(manager.has("guild-after"), true);
	await assert.rejects(manager.create("guild-before"), /reserved by an active player/);
	assert.equal(player.data.get("@ziplayer/controller.queue.states"), player.queue);
	player.data.set("application.cache", { value: 1 });
	assert.deepEqual(player.data.get("application.cache"), { value: 1 });
	assert.equal(player.volume, 37);
	assert.equal(player.queue.size, 1);
	assert.equal(player.queue.nextTrack.id, "queued-track");

	let queueChangeEvents = 0;
	player.subscribe(BUS_EVENT.queueChanged, () => queueChangeEvents++);
	player.queue.add(makeTrack("second-queued-track"));
	assert.equal(queueChangeEvents, 1);

	player.setVolume(64);
	assert.equal(player.volume, 64);

	manager.changePlayerId("guild-after", "guild-final");
	assert.equal(manager.get("guild-after"), undefined);
	assert.equal(manager.get("guild-final"), player);
	assert.equal(player.id, "guild-final");
	assert.equal(player.queue.size, 2);

	await manager.destroy("guild-final");
	assert.equal(player.destroyed, true);
	assert.equal(player.data.size, 0, "destroy must release the entire player data bucket");
	assert.throws(() => player.data.set("application.cache", {}), /after the player is destroyed/);
	const recreated = await manager.create("guild-final");
	assert.equal(recreated.data.has("application.cache"), false, "a recreated player starts without old application data");
	assert.equal(recreated.data.get("@ziplayer/controller.queue.states").size, 0, "a recreated player starts with a fresh queue");
	await manager.destroy("guild-final");
	assert.equal(manager.size, 0);
});

test("changing a player ID rejects invalid or occupied IDs without changing the player", async (t) => {
	const manager = new PlayerManager({ autoCleanup: false });
	t.after(() => manager.destroy());

	const player = await manager.create("guild-original");
	await manager.create("guild-occupied");

	assert.throws(() => player.changePlayerId(" "), /non-empty string/);
	assert.throws(() => player.changePlayerId("guild-occupied"), /already exists/);
	assert.throws(() => player.changePlayerId("__ziplayer_search__"), /reserved/);
	assert.equal(player.id, "guild-original");
	assert.equal(manager.get("guild-original"), player);
	assert.equal(manager.has("guild-occupied"), true);
});
