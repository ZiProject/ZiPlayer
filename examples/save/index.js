const { PlayerManager } = require("ziplayer");
const { YouTubePlugin } = require("@ziplayer/plugin");
const fs = require("fs");

async function simpleSaveExample() {
	// Create manager and player
	const manager = new PlayerManager({
		plugins: [new YouTubePlugin()],
	});

	const player = await manager.create("guild-id");

	try {
		// Search for a track
		const result = await player.search("Never Gonna Give You Up", "user123");
		const track = result.tracks[0];

		console.log(`🎵 Saving: ${track.title}`);

		// Use save function - return Readable stream
		const stream = await player.save(track);

		// Write stream to file using fs
		const writeStream = fs.createWriteStream("saved-song.mp3");
		stream.pipe(writeStream);

		writeStream.on("finish", () => {
			console.log("✅ success!");
		});

		writeStream.on("error", (error) => {
			console.error("❌ error:", error);
		});
	} catch (error) {
		console.error("❌ error:", error);
	}
}

// Run example
simpleSaveExample();
