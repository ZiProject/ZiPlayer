const test = require("node:test");
const assert = require("node:assert/strict");

const { PlayerManager, BaseExtension } = require("../core/dist");
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

test("PlayerManager create/get/has/delete basics and plugin propagation", async (t) => {
	const mgr = new PlayerManager({ plugins: [new DummyPlugin()] });
	t.after(() => mgr.destroy());

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
	assert.equal(deleted, true);
	assert.equal(mgr.size, 0);

	const deletedAgain = mgr.delete("guild-1");
	assert.equal(deletedAgain, false);
});

test("PlayerManager.search uses manager plugins without creating a Player", async (t) => {
	const mgr = new PlayerManager({ plugins: [new DummyPlugin()] });
	t.after(() => mgr.destroy());

	assert.equal(mgr.size, 0);
	assert.equal(mgr.has("__ziplayer_search__"), false);

	const result = await mgr.search("dummy:test-query", "user-1");
	assert.equal(result.tracks.length, 1);
	assert.equal(result.tracks[0].title, "dummy:test-query");

	assert.equal(mgr.size, 0);
	assert.equal(mgr.has("__ziplayer_search__"), false);
	assert.equal(mgr.get("__ziplayer_search__"), undefined);

	// The manager-level SearchController handles subsequent requests too.
	const result2 = await mgr.search("dummy:another", "user-2");
	assert.equal(result2.tracks.length, 1);
	assert.equal(mgr.size, 0);
});

test("Player.search options restrict search to the selected plugin", async (t) => {
	const searched = [];
	class SearchPlugin extends BasePlugin {
		constructor(name) {
			super();
			this.name = name;
			this.version = "1.0.0";
		}
		async search(query, requestedBy) {
			searched.push(this.name);
			return { tracks: [{ id: this.name, title: query, url: `https://${this.name}/track`, duration: 1, requestedBy }] };
		}
	}

	const mgr = new PlayerManager({ plugins: [new SearchPlugin("chosen"), new SearchPlugin("other")] });
	t.after(() => mgr.destroy());
	const player = await mgr.create("search-options", {});

	const result = await player.search("test query", { requestedBy: "user-1", plugin: "CHOSEN" });
	assert.deepEqual(searched, ["chosen"]);
	assert.equal(result.tracks[0].source, "chosen");
	assert.equal(result.tracks[0].requestedBy, "user-1");

	await assert.rejects(() => player.search("missing plugin query", { plugin: "missing" }), /No results found/);
	assert.deepEqual(searched, ["chosen"], "a missing plugin must not fall back to all registered plugins");
});

test("PlayerManager extension activation by name and ctor", async (t) => {
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
	t.after(() => mgr.destroy());
	const player = await mgr.create("g2", { extensions: ["dext"] });
	assert.ok(player);
	assert.equal(activated, 1);

	// Also support passing instances directly
	activated = 0;
	const inst = new DummyExt();
	const mgr2 = new PlayerManager({ extensions: [inst] });
	t.after(() => mgr2.destroy());
	await mgr2.create("g3", { extensions: ["dext"] });
	assert.equal(activated, 1);
});

test("Player.attachExtension activates with its player and scoped Bus events", async (t) => {
	class BusExtension extends BaseExtension {
		constructor() {
			super();
			this.name = "bus-extension";
			this.version = "1.0.0";
			this.player = null;
			this.events = [];
			this.registeredPlayer = null;
			this.destroyedPlayer = null;
			this.activationCount = 0;
		}

		active(context) {
			this.activationCount++;
			assert.equal(context.player, this.player);
			this.subscribeBus("queueAdd", (event) => {
				this.events.push(event);
				event.track.metadata = { ...event.track.metadata, handledByExtension: true };
			});
			return true;
		}

		onRegister(context) {
			this.registeredPlayer = context.player;
		}

		onDestroy(context) {
			this.destroyedPlayer = context.player;
		}
	}

	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const player = await mgr.create("bus-extension-guild", { extensions: [] });
	const otherPlayer = await mgr.create("bus-extension-other-guild", { extensions: [] });
	const extension = new BusExtension();

	await player.attachExtension(extension);
	await player.attachExtension(extension);
	assert.equal(extension.registeredPlayer, player);
	assert.equal(extension.player, player);
	assert.equal(extension.activationCount, 1, "attaching an existing extension should not reactivate it");

	const track = makeTrack("bus-event-track");
	player.queue.add(track);
	assert.equal(extension.events.length, 1);
	assert.equal(extension.events[0].track, track);
	assert.equal(track.metadata.handledByExtension, true);

	otherPlayer.queue.add(makeTrack("other-player-track"));
	assert.equal(extension.events.length, 1, "the extension should only receive events for its attached player");

	assert.equal(player.detachExtension(extension), true);
	assert.equal(extension.destroyedPlayer, player);
	player.queue.add(makeTrack("after-detach"));
	assert.equal(extension.events.length, 1, "detaching should release the extension's scoped Bus subscription");
});

test("detaching a shared extension from one player preserves its other Bus subscriptions", async (t) => {
	class SharedExtension extends BaseExtension {
		constructor() {
			super();
			this.name = "shared-extension";
			this.version = "1.0.0";
			this.player = null;
			this.receivedPlayerIds = [];
			this.removedPlayerIds = [];
		}

		active(context) {
			this.subscribeBus("queueAdd", () => this.receivedPlayerIds.push(context.player.playerId), context.player);
			this.subscribeBus("queueRemove", () => this.removedPlayerIds.push(context.player.playerId), context.player);
			return true;
		}
	}

	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const first = await mgr.create("shared-extension-first", { extensions: [] });
	const second = await mgr.create("shared-extension-second", { extensions: [] });
	const extension = new SharedExtension();

	await first.attachExtension(extension);
	await second.attachExtension(extension);
	first.queue.add(makeTrack("first-track"));
	second.queue.add(makeTrack("second-track"));
	assert.deepEqual(extension.receivedPlayerIds, [first.playerId, second.playerId]);

	first.detachExtension(extension);
	first.queue.add(makeTrack("first-after-detach"));
	second.queue.add(makeTrack("second-after-first-detach"));
	assert.deepEqual(extension.receivedPlayerIds, [first.playerId, second.playerId, second.playerId]);
	first.queue.remove(0);
	second.queue.remove(0);
	assert.deepEqual(extension.removedPlayerIds, [second.playerId]);
});

test("PlayerManager activates multiple extensions concurrently", async (t) => {
	let activeCount = 0;
	let maxActiveCount = 0;
	class ConcurrentExtension extends BaseExtension {
		constructor(name) {
			super();
			this.name = name;
			this.version = "1.0.0";
			this.player = null;
		}

		async active() {
			activeCount++;
			maxActiveCount = Math.max(maxActiveCount, activeCount);
			await new Promise((resolve) => setTimeout(resolve, 20));
			activeCount--;
			return true;
		}
	}

	const mgr = new PlayerManager({
		autoCleanup: false,
		extensions: [
			new ConcurrentExtension("concurrent-1"),
			new ConcurrentExtension("concurrent-2"),
			new ConcurrentExtension("concurrent-3"),
		],
	});
	t.after(() => mgr.destroy());

	const player = await mgr.create("concurrent-extension-guild", {
		extensions: ["concurrent-1", "concurrent-2", "concurrent-3"],
	});
	assert.deepEqual(player.extensionNames.sort(), ["concurrent-1", "concurrent-2", "concurrent-3"]);
	assert.equal(maxActiveCount, 3, "all extension activation hooks should overlap");
});

test("PlayerManager clears extension player references on destroy", async (t) => {
	class CleanupExtension {
		static name = "cleanup";
		name = "cleanup";
		version = "0.0.0";
		player = null;
		active() {
			return true;
		}
	}

	const extension = new CleanupExtension();
	const mgr = new PlayerManager({ extensions: [extension], autoCleanup: false });
	t.after(() => mgr.destroy());
	await mgr.create("cleanup-guild", { extensions: ["cleanup"] });

	assert.ok(extension.player);
	mgr.destroy();
	assert.equal(extension.player, null);
});
