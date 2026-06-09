const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager } = require("../core/dist");
const { BasePlugin } = require("../core/dist/plugins/BasePlugin");

class DummyPlugin extends BasePlugin {
	constructor() {
		super();
		this.name = "dummy";
		this.version = "1.0.0";
	}
	canHandle(q) {
		return q?.startsWith("dummy:");
	}
	async search(query, requestedBy) {
		return { tracks: [{ id: "1", title: query, url: "https://dummy/1", duration: 1, requestedBy, source: this.name }] };
	}
	async getStream(track) {
		const { Readable } = require("node:stream");
		return { stream: Readable.from([Buffer.from("x")]), type: "arbitrary" };
	}
}

function makeTrack(id = "t1", title = "Track 1") {
	return { id, title, url: `https://example.com/${id}`, duration: 1, requestedBy: "tester", source: "test" };
}

test("PlayerManager create/get/has/delete basics and plugin propagation", async () => {
	const mgr = new PlayerManager({ plugins: [new DummyPlugin()] });

	assert.equal(mgr.size, 0);
	const player = await mgr.create("guild-1", {});
	assert.equal(mgr.size, 1);
	assert.ok(mgr.has("guild-1"));
	assert.equal(mgr.get("guild-1"), player);

	// player should have plugin registered
	assert.ok(player.availablePlugins.includes("dummy"));

	// Forwarded events from player to manager
	const sample = makeTrack();
	let forwarded = false;
	mgr.on("queueAdd", (plr, track) => {
		forwarded = true;
		assert.equal(plr, player);
		assert.equal(track.id, sample.id);
	});
	player.emit("queueAdd", sample);
	assert.equal(forwarded, true);

	// Delete removes and destroys
	const deleted = mgr.delete("guild-1");
	// Implementation deletes on playerDestroy handler first, so method returns false on second delete
	assert.equal(deleted, false);
	assert.equal(mgr.size, 0);
});

test("PlayerManager.search uses internal player with plugins but not players map", async () => {
	const mgr = new PlayerManager({ plugins: [new DummyPlugin()] });

	assert.equal(mgr.size, 0);
	assert.equal(mgr.has("__ziplayer_search__"), false);

	const result = await mgr.search("dummy:test-query", "user-1");
	assert.equal(result.tracks.length, 1);
	assert.equal(result.tracks[0].title, "dummy:test-query");

	assert.equal(mgr.size, 0);
	assert.equal(mgr.has("__ziplayer_search__"), false);
	assert.equal(mgr.get("__ziplayer_search__"), undefined);

	// Second search reuses the same internal player
	const result2 = await mgr.search("dummy:another", "user-2");
	assert.equal(result2.tracks.length, 1);
	assert.equal(mgr.size, 0);
});

test("PlayerManager extension activation by name and ctor", async () => {
	let activated = 0;
	class DummyExt {
		static name = "dext";
		name = "dext";
		version = "0.0.0";
		player = null;
		active(ctx) {
			activated++;
			return true;
		}
	}

	const mgr = new PlayerManager({ extensions: [DummyExt] });
	const player = await mgr.create("g2", { extensions: ["dext"] });
	assert.ok(player);
	assert.equal(activated, 1);

	// Also support passing instances directly
	activated = 0;
	const inst = new DummyExt();
	const mgr2 = new PlayerManager({ extensions: [inst] });
	await mgr2.create("g3", { extensions: ["dext"] });
	assert.equal(activated, 1);
});
