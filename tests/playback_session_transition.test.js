const test = require("node:test");
const assert = require("node:assert/strict");

const { Player, PlayerBus, PlaybackSession } = require("../core/dist");

test("Player.getTime follows the active session across track transitions and seek", () => {
	const bus = new PlayerBus();
	let activeSession = new PlaybackSession();
	const track1 = { id: "track-1", title: "Track 1", duration: 180000 };
	const track2 = { id: "track-2", title: "Track 2", duration: 240000 };

	bus.registerQuery("playbackSession", () => activeSession.snapshot());
	bus.registerQuery("position", () => activeSession.position);
	bus.registerQuery("currentTrack", () => activeSession.track);

	activeSession.begin(track1);
	activeSession.markPlaying();
	activeSession.updatePosition(12000);
	const player = Object.create(Player.prototype);
	player.bus = bus;
	assert.equal(player.getTime().current, 12000);

	activeSession = new PlaybackSession();
	activeSession.begin(track2);
	activeSession.markPlaying();
	assert.equal(activeSession.position, 0);
	assert.equal(player.getTime().current, 0);

	activeSession.updatePosition(42000);
	assert.equal(player.getTime().current, 42000);
});
