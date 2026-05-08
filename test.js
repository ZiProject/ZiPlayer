const { SoundCloudPlugin, YouTubePlugin } = require("@ziplayer/plugin");
const fs = require("node:fs");
async function MAINTEST(params) {
	const youTubePlugin = new YouTubePlugin({
		// debug: console.log,
	});

	// Search for videos
	const result = await youTubePlugin.search("https://www.youtube.com/watch?v=qkPgUgkQE4Y", "user123");
	console.log(result.tracks);
	// Get audio stream
	// const stream = await soundCloudPlugin.getStream(result.tracks[0]);
	// console.log(stream);
	// const file = fs.createWriteStream("output.mp3");
	// stream.stream.pipe(file);
}

MAINTEST();
