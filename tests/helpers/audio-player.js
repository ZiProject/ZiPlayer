// @discordjs/voice keeps a global timer alive while any AudioPlayer exists, so a test file that
// forgets to stop its players never exits and `node --test` hangs forever. Create players through
// this helper and they are all stopped when the file's tests finish.
const { after } = require("node:test");
const { createAudioPlayer } = require("@discordjs/voice");

const players = new Set();

// Registered at require() time (file top level) so it attaches to the file's root suite.
after(() => {
	for (const p of players) {
		try {
			p.stop(true);
		} catch {}
	}
	players.clear();
});

function createTrackedAudioPlayer(options) {
	const player = createAudioPlayer(options);
	players.add(player);
	return player;
}

module.exports = { createTrackedAudioPlayer };
