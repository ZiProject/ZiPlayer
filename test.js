const { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const fetch = require("isomorphic-unfetch");
const { getData, getPreview, getTracks, getDetails } = require("spotify-url-info")(fetch);

const fs = require("node:fs");
async function MAINTEST(params) {
	const youTubePlugin = new YouTubePlugin({
		// debug: console.log,
	});
	// const spoti = new SpotifyPlugin();
	// getTracks("https://open.spotify.com/album/1AaxmI2e1HRhbwe9XJGPnT").then((data) => console.log(data));
	// getPreview("spotify:track:0tPBIwb0p5mozyF6GZVTUG").then((data) => console.log(data));
	// // Search for videos
	const result = await youTubePlugin.search("https://www.youtube.com/watch?v=J1X6LEa1hYA", "user123");

	await youTubePlugin.getStream(result.tracks[0]);
	// Get audio stream
	// const stream = await soundCloudPlugin.getStream(result.tracks[0]);
	// console.log(stream);
	// const file = fs.createWriteStream("output.mp3");
	// stream.stream.pipe(file);
}

MAINTEST();
