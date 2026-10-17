const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
	Bus,
	Player,
	PlaybackController,
	createOpusAudioResource,
	demuxOggOpusToPackets,
	demuxWebmOpusToPackets,
} = require("../core/dist");
const { createAudioPlayer } = require("@discordjs/voice");

function createPlayerWithAudioPlayer(playerId) {
	const bus = new Bus();
	const audioPlayer = createAudioPlayer();
	const controller = new PlaybackController(bus);
	controller.attach(playerId, { audioPlayer, stuckTimeoutMs: 1000 });
	return { player: new Player(playerId, bus), audioPlayer, controller };
}

test("validator and demuxer close when their upstream sources are destroyed independently", async () => {
	const source = new Readable({ objectMode: true, read() {} });
	const resource = createOpusAudioResource(source);
	resource.playStream.on("error", () => {});
	const resourceClosed = new Promise((resolve) => resource.playStream.once("close", resolve));
	source.destroy();
	await resourceClosed;
	assert.equal(resource.playStream.destroyed, true);

	for (const demux of [demuxOggOpusToPackets, demuxWebmOpusToPackets]) {
		const upstream = new Readable({ read() {} });
		const downstream = demux(upstream);
		downstream.on("error", () => {});
		const downstreamClosed = new Promise((resolve) => downstream.once("close", resolve));
		upstream.destroy();
		await downstreamClosed;
		assert.equal(downstream.destroyed, true);
	}
});

test("Player.play normalizes partial AudioResource metadata into a complete Track", async (t) => {
	const { player, controller } = createPlayerWithAudioPlayer("resource-track-metadata");
	t.after(() => {
		player.destroy();
		controller.detach("resource-track-metadata");
	});

	const resource = createOpusAudioResource([Buffer.from([0xf8, 0xff, 0xfe])], {
		metadata: { title: "Metadata-only track", author: "ZiPlayer" },
	});
	const result = await player.play(resource, { requestedBy: "requester-123" });

	assert.ok(result);
	assert.equal(result.track.id.startsWith("resource-"), true);
	assert.equal(result.track.title, "Metadata-only track");
	assert.equal(result.track.url, "");
	assert.equal(result.track.duration, 0);
	assert.equal(result.track.requestedBy, "requester-123");
	assert.equal(result.track.source, "resource");
	assert.equal(result.track.author, "ZiPlayer");
	assert.deepEqual(resource.metadata, result.track);
});
