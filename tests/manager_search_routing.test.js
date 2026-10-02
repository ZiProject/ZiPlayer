const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

const MANAGER_SEARCH_ID = "__ziplayer_search__";

function makePlugin(name) {
	return {
		name,
		version: "1.0.0",
		canHandle: () => true,
		async search(query, requestedBy) {
			return {
				tracks: [{ id: `${name}:${query}`, title: query, url: `https://${name}/${query}`, duration: 1, requestedBy }],
			};
		},
		async getStream() {
			throw new Error("getStream is not used by manager search");
		},
	};
}

test("PlayerManager.search uses the Bus without attaching a hidden Player or playback state", async () => {
	const mgr = new PlayerManager({ autoCleanup: false, plugins: [makePlugin("initial")] });

	try {
		const result = await mgr.search("initial:query", "user-1");

		assert.equal(result.tracks.length, 1);
		assert.equal(result.tracks[0].source, "initial");
		assert.deepEqual(mgr.getAll(), []);
		assert.equal(mgr.getStats().players, 0);
		assert.equal(mgr.controllers.connection.slots.has(MANAGER_SEARCH_ID), false);
		assert.equal(mgr.controllers.playback.slots.has(MANAGER_SEARCH_ID), false);
		assert.equal(mgr.controllers.transition.states.has(MANAGER_SEARCH_ID), false);
		assert.ok(mgr.controllers.search.cache(MANAGER_SEARCH_ID));
		assert.equal(mgr.controllerRegistry.timers.has(MANAGER_SEARCH_ID), false);
	} finally {
		await mgr.destroy();
	}

	assert.equal(mgr.controllers.search.cache(MANAGER_SEARCH_ID), undefined);
});

test("manager search follows plugin registration and unregistration", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());

	mgr.registerPlugin(makePlugin("dynamic"));
	const result = await mgr.search("dynamic:query", "user-2");
	assert.equal(result.tracks[0].source, "dynamic");

	assert.equal(mgr.unregisterPlugin("dynamic"), true);
	await assert.rejects(() => mgr.search("dynamic:another-query", "user-2"), /No results found/);
});
