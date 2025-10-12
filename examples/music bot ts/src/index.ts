import { PlayerManager } from "ziplayer";
import { Client, GatewayIntentBits } from "discord.js";
import { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } from "@ziplayer/plugin";
import dotenv from "dotenv";
dotenv.config();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers,
	],
});

// Setup plugins
const soundcloudPlugin = new SoundCloudPlugin();
const youtubePlugin = new YouTubePlugin();
const spotifyPlugin = new SpotifyPlugin();
// Create player manager
const manager = new PlayerManager({
	plugins: [soundcloudPlugin, youtubePlugin, spotifyPlugin],
});
client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guild) return;
	console.log(message.content);
	if (!message.content.startsWith("!")) return;

	const args = message.content.slice(1).trim().split(/ +/);
	console.log(args);
	const command = args.shift()?.toLowerCase();

	if (command === "play") {
		const query = args.join(" ");
		if (!query) return message.reply("Please provide a song to play!");

		const member = message.member;
		const voiceChannel = member?.voice.channel;

		if (!voiceChannel || voiceChannel.type !== 2) {
			// 2 is VoiceChannel
			return message.reply("You need to be in a standard voice channel!");
		}

		try {
			// Create player with plugins
			const player = await manager.create(message.guild.id, {
				leaveOnEnd: false,
				leaveOnEmpty: false,
				// leaveTimeout: 30000,
				userdata: {
					voiceChannel: voiceChannel,
					textChannel: message.channel,
				},
			});

			// Connect to voice channel
			if (!player.connection) {
				await player.connect(voiceChannel as import("discord.js").VoiceChannel);
			}

			// Play the song
			const success = await player.play(query, message.author.id);

			if (success) {
				message.reply(`🎵 Added to queue: **${query}**`);
			} else {
				message.reply("❌ Failed to add song to queue");
			}
		} catch (error) {
			console.error("Play command error:", error);
			message.reply("❌ An error occurred while trying to play the song");
		}
	}

	if (command === "skip") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");

		player.skip();
		message.reply("⏭️ Skipped current track");
	}

	if (command === "pause") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");

		if (player.pause()) {
			message.reply("⏸️ Paused playback");
		} else {
			message.reply("❌ Could not pause playback");
		}
	}

	if (command === "resume") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");

		if (player.resume()) {
			message.reply("▶️ Resumed playback");
		} else {
			message.reply("❌ Could not resume playback");
		}
	}

	if (command === "queue") {
		const player = manager.get(message.guild.id);
		if (!player || player.queueSize === 0) {
			return message.reply("Queue is empty!");
		}

		const current = player.currentTrack;
		const upcoming = player.upcomingTracks.slice(0, 10);

		let queueText = "";
		if (current) {
			queueText += `**Now Playing:** ${current.title}\n\n`;
		}

		if (upcoming.length > 0) {
			queueText += "**Up Next:**\n";
			upcoming.forEach((track, index) => {
				queueText += `${index + 1}. ${track.title}\n`;
			});
		}

		message.reply(queueText || "Queue is empty!");
	}

	if (command === "volume") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");

		const volume = parseInt(args[0]);
		if (isNaN(volume) || volume < 0 || volume > 200) {
			return message.reply("Please provide a volume between 0 and 200!");
		}

		player.setVolume(volume);
		message.reply(`🔊 Volume set to ${volume}%`);
	}

	if (command === "stop") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");

		player.stop();
		message.reply("⏹️ Stopped playback and cleared queue");
	}

	if (command === "shuffle") {
		const player = manager.get(message.guild.id);
		if (!player || player.queueSize === 0) {
			return message.reply("Queue is empty!");
		}

		player.shuffle();
		message.reply("🔀 Shuffled the queue");
	}

	if (command === "auto") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");
		const autoPlay = player.queue.autoPlay();
		player.queue.autoPlay(!autoPlay);
		message.reply(`🔁 Autoplay is now ${!autoPlay ? "enabled" : "disabled"}`);
	}

	if (command === "status") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");
		message.reply(
			`🔊 Volume: ${player.volume}%, Autoplay: ${player.queue.autoPlay() ? "enabled" : "disabled"}\n ${player.getProgressBar()}`,
		);
	}

	if (command === "livestatus") {
		const player = manager.get(message.guild.id);
		if (!player) return message.reply("No music is playing!");
		message.reply(
			`🔊 Volume: ${player.volume}%, Autoplay: ${player.queue.autoPlay() ? "enabled" : "disabled"}\n ${player.getProgressBar({
				barChar: "﹏",
				progressChar: "𓊝",
			})}`,
		);

		setInterval(() => {
			if (player.isPlaying) {
				message.channel.send(`${player.getProgressBar()}`);
			}
		}, 15000);
	}
});

// Event listeners for player events
manager.on("trackStart", (player, track) => {
	player.userdata.textChannel.send(`🎶 Now playing: **${track.title}**`);
	console.log(`Started playing: ${track.title} in guild ${player.guildId}`);
});

manager.on("trackEnd", (player, track) => {
	player.userdata.textChannel.send(`✅ Finished playing: **${track.title}**`);
	console.log(`Finished playing: ${track.title} in guild ${player.guildId}`);
});

manager.on("queueEnd", (player) => {
	player.userdata.textChannel.send("🏁 Queue has ended.");
	console.log(`Queue ended in guild ${player.guildId}`);
});

manager.on("playerError", (player, error, track) => {
	console.error(`Player error in guild ${player.guildId}:`, error.message);
	if (track) {
		console.error(`Track: ${track.title}`);
	}
});

manager.on("willPlay", (player, track, upcoming) => {
	console.log(
		`Will play next in guild ${player.guildId}: ${track.title}, Upcoming: ${upcoming
			.map((t: { title: string }) => t.title)
			.join(", ")}`,
	);
	player.userdata.textChannel.send(
		`⏭️ Up next: **${track.title}**\n
   ${upcoming.map((t: { title: string }) => t.title).join("\n")}`,
	);
});

manager.on("debug", console.log);
client.login(process.env.DISCORD_TOKEN);

client.on("ready", () => {
	console.log(`Logged in as ${client.user?.tag}`);
});
