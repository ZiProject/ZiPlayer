const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { PlayerManager } = require("../core/dist");
const { BasePlugin } = require("../core/dist/plugins/BasePlugin");

class RequesterPlugin extends BasePlugin {
	constructor() {
		super();
		this.name = "requester";
		this.version = "1.0.0";
		this.searchedBy = [];
	}

	async search(query, requestedBy) {
		this.searchedBy.push(requestedBy);
		return {
			tracks: [
				{
					id: "requested-track",
					title: query,
					url: "https://example.com/requested-track",
					duration: 1,
					requestedBy,
					source: this.name,
				},
			],
		};
	}

	async getStream() {
		return { stream: Readable.from([Buffer.from("audio")]), type: "arbitrary" };
	}
}

test("Player and Track preserve requestedBy user objects while search plugins receive the ID", async (t) => {
	const plugin = new RequesterPlugin();
	const manager = new PlayerManager({ plugins: [plugin], autoCleanup: false });
	t.after(() => manager.destroy());

	const player = await manager.create("requested-by-object");
	const firstUser = { id: "661968947327008768", username: "__ziji" };
	const firstResult = await player.search("object request", firstUser);

	assert.equal(plugin.searchedBy[0], firstUser.id);
	assert.strictEqual(firstResult.tracks[0].requestedBy, firstUser);

	const secondUser = { id: "second-user", username: "second" };
	const cachedResult = await player.search("object request", { requestedBy: secondUser });

	assert.equal(plugin.searchedBy.length, 1);
	assert.strictEqual(cachedResult.tracks[0].requestedBy, secondUser);
	assert.strictEqual(firstResult.tracks[0].requestedBy, firstUser);

	const playbackUser = { id: "playback-user", username: "playback" };
	const playResult = await player.play(firstResult.tracks[0], playbackUser);

	assert.ok(playResult);
	assert.strictEqual(playResult.track.requestedBy, playbackUser);
});
