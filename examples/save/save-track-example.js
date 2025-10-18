const { PlayerManager } = require("@ziplayer/core");
const { YouTubePlugin } = require("@ziplayer/plugins");
const fs = require("fs");
const path = require("path");

// Tạo PlayerManager với YouTube plugin
const manager = new PlayerManager({
	plugins: [new YouTubePlugin()],
});

async function saveTrackExample() {
	try {
		// Tạo player cho guild
		const player = await manager.create("guild-id-here");

		// Tìm kiếm bài hát
		console.log("🔍 Đang tìm kiếm bài hát...");
		const searchResult = await player.search("Never Gonna Give You Up", "user123");

		if (searchResult.tracks.length === 0) {
			console.log("❌ Không tìm thấy bài hát nào!");
			return;
		}

		const track = searchResult.tracks[0];
		console.log(`🎵 Tìm thấy: ${track.title}`);
		console.log(`⏱️  Thời lượng: ${Math.floor(track.duration / 1000)} giây`);

		// Sử dụng save function để lấy stream
		console.log("💾 Đang tải stream...");
		const audioStream = await player.save(track);

		// Tạo tên file an toàn từ title
		const safeTitle = track.title.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_");
		const filename = `${safeTitle}.mp3`;
		const filepath = path.join(__dirname, "downloads", filename);

		// Tạo thư mục downloads nếu chưa có
		const downloadsDir = path.join(__dirname, "downloads");
		if (!fs.existsSync(downloadsDir)) {
			fs.mkdirSync(downloadsDir, { recursive: true });
		}

		// Tạo write stream để ghi file
		const writeStream = fs.createWriteStream(filepath);

		// Pipe audio stream vào file
		audioStream.pipe(writeStream);

		// Theo dõi tiến trình
		let downloadedBytes = 0;
		audioStream.on("data", (chunk) => {
			downloadedBytes += chunk.length;
			console.log(`📥 Đã tải: ${Math.round(downloadedBytes / 1024)} KB`);
		});

		// Xử lý khi hoàn thành
		writeStream.on("finish", () => {
			console.log(`✅ Đã lưu thành công: ${filename}`);
			console.log(`📁 Đường dẫn: ${filepath}`);
			console.log(`📊 Kích thước file: ${Math.round(fs.statSync(filepath).size / 1024)} KB`);
		});

		// Xử lý lỗi
		writeStream.on("error", (error) => {
			console.error("❌ Lỗi khi ghi file:", error);
		});

		audioStream.on("error", (error) => {
			console.error("❌ Lỗi khi tải stream:", error);
		});
	} catch (error) {
		console.error("❌ Lỗi:", error.message);
	}
}

// Ví dụ lưu track hiện tại đang phát
async function saveCurrentTrackExample() {
	try {
		const player = await manager.create("guild-id-here");

		// Phát một bài hát trước
		await player.play("Never Gonna Give You Up", "user123");

		// Đợi một chút để track bắt đầu phát
		await new Promise((resolve) => setTimeout(resolve, 2000));

		const currentTrack = player.currentTrack;
		if (!currentTrack) {
			console.log("❌ Không có track nào đang phát!");
			return;
		}

		console.log(`🎵 Đang lưu track hiện tại: ${currentTrack.title}`);

		// Lưu track hiện tại
		const audioStream = await player.save(currentTrack);

		const filename = `current_track_${Date.now()}.mp3`;
		const filepath = path.join(__dirname, "downloads", filename);

		const writeStream = fs.createWriteStream(filepath);
		audioStream.pipe(writeStream);

		writeStream.on("finish", () => {
			console.log(`✅ Đã lưu track hiện tại: ${filename}`);
		});
	} catch (error) {
		console.error("❌ Lỗi:", error.message);
	}
}

// Ví dụ lưu nhiều tracks từ playlist
async function savePlaylistExample() {
	try {
		const player = await manager.create("guild-id-here");

		// Tìm kiếm playlist
		console.log("🔍 Đang tìm kiếm playlist...");
		const searchResult = await player.search("playlist: top hits 2024", "user123");

		if (searchResult.tracks.length === 0) {
			console.log("❌ Không tìm thấy playlist nào!");
			return;
		}

		console.log(`📀 Tìm thấy playlist: ${searchResult.playlist?.name || "Unknown"}`);
		console.log(`🎵 Số tracks: ${searchResult.tracks.length}`);

		// Lưu từng track
		for (let i = 0; i < Math.min(searchResult.tracks.length, 3); i++) {
			// Chỉ lưu 3 tracks đầu
			const track = searchResult.tracks[i];
			console.log(`\n💾 Đang lưu track ${i + 1}/${Math.min(searchResult.tracks.length, 3)}: ${track.title}`);

			try {
				const audioStream = await player.save(track);

				const safeTitle = track.title.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_");
				const filename = `${i + 1}_${safeTitle}.mp3`;
				const filepath = path.join(__dirname, "downloads", filename);

				const writeStream = fs.createWriteStream(filepath);
				audioStream.pipe(writeStream);

				await new Promise((resolve, reject) => {
					writeStream.on("finish", resolve);
					writeStream.on("error", reject);
					audioStream.on("error", reject);
				});

				console.log(`✅ Đã lưu: ${filename}`);
			} catch (error) {
				console.error(`❌ Lỗi khi lưu track ${i + 1}:`, error.message);
			}
		}

		console.log("\n🎉 Hoàn thành lưu playlist!");
	} catch (error) {
		console.error("❌ Lỗi:", error.message);
	}
}

// Chạy ví dụ
if (require.main === module) {
	console.log("🚀 Bắt đầu ví dụ save track...\n");

	// Chọn ví dụ để chạy
	const example = process.argv[2] || "single";

	switch (example) {
		case "single":
			saveTrackExample();
			break;
		case "current":
			saveCurrentTrackExample();
			break;
		case "playlist":
			savePlaylistExample();
			break;
		default:
			console.log("📖 Cách sử dụng:");
			console.log("node save-track-example.js single     - Lưu một track đơn lẻ");
			console.log("node save-track-example.js current    - Lưu track hiện tại đang phát");
			console.log("node save-track-example.js playlist    - Lưu nhiều tracks từ playlist");
			break;
	}
}

module.exports = {
	saveTrackExample,
	saveCurrentTrackExample,
	savePlaylistExample,
};
