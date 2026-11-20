const test = require("node:test");
const assert = require("node:assert/strict");
const createSearchAndPlayCases = require("../examples/net/cases/search-and-play");

test("play command reports a queued track without waiting for trackStart", async () => {
	const replies = [];
	let waitStartCalled = false;
	const track = { id: "youtube-track", title: "Queued Song", source: "youtube" };
	const player = {
		isPlaying: true,
		isPaused: false,
		isBuffering: false,
		play: async () => ({ track }),
	};
	const commands = createSearchAndPlayCases({
		id: "transfer-client",
		net: { markTrack: () => {} },
		zi: { delegationFor: () => ({ executor: "transfer-yt" }) },
		st: { bytesIn: 0 },
		findTracks: async () => ({ tracks: [track], node: "transfer-yt" }),
		getPlayer: async () => player,
		waitStart: async () => {
			waitStartCalled = true;
			return false;
		},
	});

	await commands.play(
		{
			guildId: "guild-1",
			author: { id: "user-1" },
			reply: async (content) => replies.push(content),
		},
		"yt:queued song",
	);

	assert.equal(waitStartCalled, false);
	assert.match(replies[0], /queued \*\*Queued Song\*\*/);
	assert.match(replies[0], /will play on \*\*transfer-yt\*\*/);
});
