const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");

test("Player setVolume constraints and event", async (t) => {
	const mgr = new PlayerManager();
	t.after(() => mgr.destroy());

	const player = await mgr.create("g1");

	// out of range
	assert.equal(player.setVolume(-10), false);
	assert.equal(player.setVolume(201), false);

	let evtOld = null,
		evtNew = null;
	player.on("volumeChange", (oldV, newV) => {
		evtOld = oldV;
		evtNew = newV;
	});

	const ok = player.setVolume(50);
	assert.equal(ok, true);
	assert.equal(player.volume, 50);
	assert.equal(evtOld, 100);
	assert.equal(evtNew, 50);
});
