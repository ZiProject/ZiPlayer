import { PlayerManager } from "@ziplayer/core";
import { YouTubePlugin } from "@ziplayer/plugins";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

// Tạo PlayerManager với YouTube plugin
const manager = new PlayerManager({
	plugins: [new YouTubePlugin()],
});

/**
 * Ví dụ lưu một track đơn lẻ
 */
async function saveTrackExample(): Promise<void> {
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
		const audioStream: Readable = await player.save(track);

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
		audioStream.on("data", (chunk: Buffer) => {
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
		writeStream.on("error", (error: Error) => {
			console.error("❌ Lỗi khi ghi file:", error);
		});

		audioStream.on("error", (error: Error) => {
			console.error("❌ Lỗi khi tải stream:", error);
		});
	} catch (error) {
		console.error("❌ Lỗi:", (error as Error).message);
	}
}

/**
 * Ví dụ lưu track hiện tại đang phát
 */
async function saveCurrentTrackExample(): Promise<void> {
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
		const audioStream: Readable = await player.save(currentTrack);

		const filename = `current_track_${Date.now()}.mp3`;
		const filepath = path.join(__dirname, "downloads", filename);

		const writeStream = fs.createWriteStream(filepath);
		audioStream.pipe(writeStream);

		writeStream.on("finish", () => {
			console.log(`✅ Đã lưu track hiện tại: ${filename}`);
		});
	} catch (error) {
		console.error("❌ Lỗi:", (error as Error).message);
	}
}

/**
 * Ví dụ lưu nhiều tracks từ playlist
 */
async function savePlaylistExample(): Promise<void> {
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
				const audioStream: Readable = await player.save(track);

				const safeTitle = track.title.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_");
				const filename = `${i + 1}_${safeTitle}.mp3`;
				const filepath = path.join(__dirname, "downloads", filename);

				const writeStream = fs.createWriteStream(filepath);
				audioStream.pipe(writeStream);

				await new Promise<void>((resolve, reject) => {
					writeStream.on("finish", () => resolve());
					writeStream.on("error", reject);
					audioStream.on("error", reject);
				});

				console.log(`✅ Đã lưu: ${filename}`);
			} catch (error) {
				console.error(`❌ Lỗi khi lưu track ${i + 1}:`, (error as Error).message);
			}
		}

		console.log("\n🎉 Hoàn thành lưu playlist!");
	} catch (error) {
		console.error("❌ Lỗi:", (error as Error).message);
	}
}

/**
 * Ví dụ sử dụng save function với error handling nâng cao
 */
async function saveWithAdvancedErrorHandling(): Promise<void> {
	try {
		const player = await manager.create("guild-id-here");

		// Tìm kiếm bài hát
		const searchResult = await player.search("Never Gonna Give You Up", "user123");

		if (searchResult.tracks.length === 0) {
			throw new Error("Không tìm thấy bài hát nào!");
		}

		const track = searchResult.tracks[0];
		console.log(`🎵 Đang lưu: ${track.title}`);

		// Sử dụng save function với timeout
		const savePromise = player.save(track);
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Timeout khi tải stream")), 30000);
		});

		const audioStream: Readable = await Promise.race([savePromise, timeoutPromise]);

		// Tạo file với tên duy nhất
		const timestamp = Date.now();
		const filename = `${track.title.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_")}_${timestamp}.mp3`;
		const filepath = path.join(__dirname, "downloads", filename);

		// Đảm bảo thư mục tồn tại
		const downloadsDir = path.dirname(filepath);
		if (!fs.existsSync(downloadsDir)) {
			fs.mkdirSync(downloadsDir, { recursive: true });
		}

		// Tạo write stream với error handling
		const writeStream = fs.createWriteStream(filepath);

		// Pipe với error handling
		audioStream.pipe(writeStream);

		// Theo dõi tiến trình
		let downloadedBytes = 0;
		const startTime = Date.now();

		audioStream.on("data", (chunk: Buffer) => {
			downloadedBytes += chunk.length;
			const elapsed = (Date.now() - startTime) / 1000;
			const speed = Math.round(downloadedBytes / elapsed / 1024);
			console.log(`📥 Đã tải: ${Math.round(downloadedBytes / 1024)} KB (${speed} KB/s)`);
		});

		// Promise để đợi hoàn thành
		await new Promise<void>((resolve, reject) => {
			writeStream.on("finish", () => {
				console.log(`✅ Đã lưu thành công: ${filename}`);
				console.log(`📁 Đường dẫn: ${filepath}`);
				console.log(`📊 Kích thước file: ${Math.round(fs.statSync(filepath).size / 1024)} KB`);
				resolve();
			});

			writeStream.on("error", (error: Error) => {
				console.error("❌ Lỗi khi ghi file:", error);
				reject(error);
			});

			audioStream.on("error", (error: Error) => {
				console.error("❌ Lỗi khi tải stream:", error);
				reject(error);
			});
		});
	} catch (error) {
		console.error("❌ Lỗi:", (error as Error).message);
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
		case "advanced":
			saveWithAdvancedErrorHandling();
			break;
		default:
			console.log("📖 Cách sử dụng:");
			console.log("npm run save-example single     - Lưu một track đơn lẻ");
			console.log("npm run save-example current    - Lưu track hiện tại đang phát");
			console.log("npm run save-example playlist    - Lưu nhiều tracks từ playlist");
			console.log("npm run save-example advanced    - Lưu với error handling nâng cao");
			break;
	}
}

export { saveTrackExample, saveCurrentTrackExample, savePlaylistExample, saveWithAdvancedErrorHandling };
