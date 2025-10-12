require("dotenv").config();

const { PlayerManager } = require("ziplayer");
const { Client, GatewayIntentBits } = require("discord.js");
const { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin, TTSPlugin } = require("@ziplayer/plugin");
const { voiceExt } = require("@ziplayer/extension");

const prefix = "!";
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});

const Manager = new PlayerManager({
	plugins: [new TTSPlugin({ defaultLang: "vi" }), new YouTubePlugin(), new SoundCloudPlugin(), new SpotifyPlugin()],
	extensions: [new voiceExt(null, { client, lang: "en-US", minimalVoiceMessageDuration: 1 })],
});

// Basic events
Manager.on("trackStart", (plr, track) => {
	plr.userdata?.channel?.send?.(`Started playing: **${track.title}**`);
});
Manager.on("queueAdd", (plr, track) => {
	plr.userdata?.channel?.send?.(`Added to player: **${track.title}**`);
});
Manager.on("playerError", (plr, error) => {
	console.log(`[${plr.guildId}] Player error:`, error);
});
// Manager.on("debug", console.log);
Manager.on("willPlay", (plr, track, upcomming) => {
	console.log(`${track.title} will play next!`);
	plr.userdata?.channel?.send?.(`Upcomming: **${track.title}**, and \n${upcomming.map((t) => `${t.title}\n`)}`);
});

// TTS lifecycle
Manager.on("ttsStart", (plr, { track }) => {
	plr.userdata?.channel?.send?.(`TTS speaking: ${track?.title || "<inline>"}`);
});
Manager.on("ttsEnd", (plr) => {
	plr.userdata?.channel?.send?.(`TTS finished, resuming music`);
});

// Voice recognition from voiceExt
Manager.on("voiceCreate", async (plr, evt) => {
	const userTag = evt.user?.tag || evt.userId;
	plr.userdata?.channel?.send?.(`??? ${userTag}: ${evt.content}`);
	const lowerContent = evt.content.toLowerCase();
	const player = Manager.get(evt.guildId);
	const { channel } = player.userdata;
	const commands = {
		"skip|bỏ qua|next": () => {
			player.skip();
			console.log("Đã bỏ qua bài hát hiện tại");
			channel.send("⏭ | Skipped the current track");
		},
		"volume|âm lượng": () => {
			const volumeMatch = lowerContent.match(/\d+/);
			if (volumeMatch) {
				const newVolume = parseInt(volumeMatch[0]);
				if (newVolume >= 0 && newVolume <= 100) {
					player.setVolume(newVolume);
					console.log(`Đã đặt âm lượng thành ${newVolume}%`);
					channel.send(`🔊 | Volume set to: **${newVolume}%**`);
				} else {
					channel.send("❌ | Volume must be a number between 0 and 100");
					console.log("Âm lượng phải nằm trong khoảng từ 0 đến 100");
				}
			} else {
				channel.send(`🔊 | Current volume is: **${player.volume}**`);
				console.log("Không tìm thấy giá trị âm lượng hợp lệ trong lệnh");
			}
		},
		"pause|tạm dừng": () => {
			player.pause();
			console.log("Đã tạm dừng phát nhạc");
			channel.send("⏸ | Paused the music");
		},
		"resume|tiếp tục": () => {
			player.resume();
			console.log("Đã tiếp tục phát nhạc");
			channel.send("▶ | Resumed the music");
		},
		"disconnect|ngắt kết nối": () => {
			player.destroy();
			console.log("Đã ngắt kết nối");
			channel.send("👋 | Left the voice channel");
		},
		"auto play|tự động phát": async () => {
			player.queue.autoPlay(!player.queue.autoPlay());
			console.log("auto plays on");
			channel.send(`🔁 | Autoplay is now: **${player.queue.autoPlay() ? "Enabled" : "Disabled"}**`);
		},
		"play|tìm|phát|hát": async () => {
			const query = lowerContent.replace(/play|tìm|phát|hát/g, "").trim();
			const suss = await player.play(query);

			channel.send(suss ? `✅ | **${query}**` : `❌ | **${query}**`);
		},
		"xóa hàng đợi": async () => {
			player.queue.clear();
			channel.send("Queue Clear");
		},
	};

	for (const [pattern, action] of Object.entries(commands)) {
		if (lowerContent.match(new RegExp(pattern))) {
			await action();
			return;
		}
	}
});

client.once("ready", () => {
	console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guild) return;
	if (!message.content.startsWith(prefix)) return;
	const args = message.content.slice(1).trim().split(/ +/g);
	const command = args.shift().toLowerCase();
	if (command === "join") {
		if (!message.member.voice.channel) return message.channel.send("You must be in a voice channel");
		const player = await Manager.create(message.guild.id, {
			userdata: { channel: message.channel },
			selfDeaf: true,
			leaveOnEmpty: false,
			leaveOnEnd: false,
			// Enable TTS interrupt mode on this player
			tts: { createPlayer: true, interrupt: true, volume: 1 },
			// Choose extensions for this player (by name or instances)
			extensions: ["voiceExt"],
		});
		try {
			if (!player.connection) await player.connect(message.member.voice.channel);
			message.channel.send("Joined your voice channel");
		} catch (e) {
			console.log(e);
			return message.channel.send("Could not join your voice channel");
		}
	} else if (command === "say") {
		const text = args.join(" ").trim();
		if (!text) return message.channel.send("Usage: !say <text>");
		const plr = Manager.get(message.guild.id);
		if (!plr || !plr.connection) return message.channel.send("Use !join first so I can speak.");
		const query = `tts: ${text}`; // see TTSPlugin formats
		await plr.play(query, message.author.id).catch(() => null);
	} else if (command === "play") {
		if (!args[0]) return message.channel.send("❌ | Please provide a song name or URL");
		if (!message.member.voice.channel) return message.channel.send("❌ | You must be in a voice channel");
		const player = Manager.create(message.guild.id, {
			userdata: {
				channel: message.channel,
			},
			selfDeaf: true,
		});
		try {
			if (!player.connection) await player.connect(message.member.voice.channel);
			const success = await player.play(args.join(" ")).catch((e) => {
				console.log(e);

				return message.channel.send("❌ | No results found");
			});

			if (success) message.channel.send(`✅ | Enqueued **${args.join(" ")}**`);
		} catch (e) {
			console.log(e);

			return message.channel.send("❌ | Could not join your voice channel");
		}
		return;
	}
});

client.login(process.env.DISCORD_TOKEN);

process.on("uncaughtException", function (err) {
	console.log("Caught exception: " + err);
	console.log(err.stack);
});

process.on("unhandledRejection", function (err) {
	console.log("Handled exception: " + err);
	console.log(err.stack);
});

const searchh = Manager.default();
searchh.search("em của quá khứ");
