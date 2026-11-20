import { PlayerManager } from "ziplayer";
import { BilibiliPlugin } from "../plugins";

const manager = new PlayerManager({
	plugins: [
		new BilibiliPlugin({
			// sessdata: process.env.BILIBILI_SESSDATA, // tuỳ chọn: video hạn chế / Hi-Res
			quality: "super",
			preferHiRes: false,
			multiPartAsPlaylist: true,
			maxPlaylistItems: 100,
		}),
	],
});

async function demo(guildId: string, userId: string, channel: any) {
	const player = await manager.create(guildId, { userdata: { channel } });
	await player.connect(channel);

	// Từ khoá (tiền tố "bilibili:" giúp ép dùng plugin này)
	await player.play("bilibili: 周杰伦 青花瓷", userId);

	// Link video, BV, av, link rút gọn b23.tv
	await player.play("https://www.bilibili.com/video/BV1r7411p7R4", userId);
	await player.play("BV1r7411p7R4", userId);

	// Playlist: favorites (fid / ml…) hoặc kênh UP
	// const tracks = await manager.getAll?.(); // tuỳ API của bạn
}

export { demo };
