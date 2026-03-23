const { SoundCloudPlugin, YouTubePlugin } = require("@ziplayer/plugin");
const fs = require("node:fs");
async function MAINTEST(params) {
	const soundCloudPlugin = new YouTubePlugin({
		debug: console.log,
	});

	// Search for videos
	const result = await soundCloudPlugin.search("Never Gonna Give You Up", "user123");
	console.log(result.tracks[0]);
	// Get audio stream
	const stream = await soundCloudPlugin.getStream(result.tracks[0]);
	console.log(stream);
	const file = fs.createWriteStream("output.mp3");
	stream.stream.pipe(file);
}

MAINTEST();
