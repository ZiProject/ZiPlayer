const test = require("node:test");
const assert = require("node:assert/strict");

const { PluginManager } = require("../core/dist/plugins");
const { BasePlugin } = require("../core/dist/plugins/BasePlugin");

class DummyPlugin extends BasePlugin {
	constructor() {
		super();
		this.name = "dummy";
		this.version = "1.0.0";
	}
	canHandle(q) {
		return typeof q === "string" && q.startsWith("dummy:");
	}
	async search(query, requestedBy) {
		return { tracks: [{ id: "1", title: query, url: "https://dummy/1", duration: 1, requestedBy, source: this.name }] };
	}
	async getStream(track) {
		const { Readable } = require("node:stream");
		return { stream: Readable.from([Buffer.from("abc")]), type: "arbitrary" };
	}
}

test("PluginManager register/get/unregister/getAll", () => {
	const pm = new PluginManager();
	const p = new DummyPlugin();
	pm.register(p);
	assert.equal(pm.get("dummy"), p);
	assert.equal(pm.getAll().length, 1);
	assert.equal(pm.unregister("dummy"), true);
	assert.equal(pm.getAll().length, 0);
});

test("PluginManager findPlugin uses canHandle", () => {
	const pm = new PluginManager();
	pm.register(new DummyPlugin());
	const found = pm.findPlugin("dummy:hello");
	assert.ok(found);
	assert.equal(found.name, "dummy");
	assert.equal(pm.findPlugin("nope"), undefined);
});

test("PluginManager search deduplicates the same URL and keeps the higher-priority result", async () => {
	const url = "https://soundcloud.com/artist/track";
	const pm = new PluginManager({ enableCache: false });

	class DirectUrlPlugin extends BasePlugin {
		constructor(name, priority, track) {
			super();
			this.name = name;
			this.priority = priority;
			this.track = track;
		}
		async search(_query, requestedBy) {
			return { tracks: [{ ...this.track, requestedBy }] };
		}
	}

	pm.register(
		new DirectUrlPlugin("soundcloud", 10, {
			id: "provider-track",
			title: "Track with provider metadata",
			url,
			duration: 824758,
		}),
	);
	pm.register(
		new DirectUrlPlugin("Infinity", 5, {
			id: "infinity-track",
			title: "Track by Artist",
			url,
			duration: 0,
		}),
	);

	const result = await pm.search(url, "user");
	assert.equal(result.tracks.length, 1);
	assert.equal(result.tracks[0].id, "provider-track");
	assert.equal(result.tracks[0].source, "soundcloud");
});
