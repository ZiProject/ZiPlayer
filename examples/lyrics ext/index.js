require("dotenv").config();

const { PlayerManager, getManager } = require("ziplayer");
const { Client, GatewayIntentBits } = require("discord.js");
const { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const { voiceExt, lyricsExt } = require("@ziplayer/extension");

const prefix = "!";
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});
const lrc = new lyricsExt(null, {
	includeSynced: true,
	autoFetchOnTrackStart: true,
	sanitizeTitle: true,
});

const Manager = new PlayerManager({
	plugins: [new SoundCloudPlugin(), new YouTubePlugin(), new SpotifyPlugin()],
	extensions: [lrc, new voiceExt()],
});

client.on("clientReady", () => {
	console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guild) return;
	if (!message.content.startsWith(prefix)) return;
	const args = message.content.slice(1).trim().split(/ +/g);
	const command = args.shift().toLowerCase();
	if (command === "play") {
		if (!args[0]) return message.channel.send("❌ | Please provide a song name or URL");
		if (!message.member.voice.channel) return message.channel.send("❌ | You must be in a voice channel");
		const Player = await Manager.create(message.guild.id, {
			userdata: {
				channel: message.channel,
			},
			extensions: ["lyricsExt"],
		});
		try {
			if (!Player.connection) await Player.connect(message.member.voice.channel);
			const success = await Player.play(args.join(" ")).catch((e) => {
				console.log(e);

				return message.channel.send("❌ | No results found");
			});

			if (success) message.channel.send(`✅ | EnPlayerd **${args.join(" ")}**`);
		} catch (e) {
			console.log(e);

			return message.channel.send("❌ | Could not join your voice channel");
		}
		return;
	}
	if (command === "test") {
		const mng = getManager();
		console.log(mng);
	}
	const Player = Manager.get(message.guild.id);
	if (!Player || !Player.isPlaying) return message.channel.send("❌ | No music is being played");

	if (command === "skip") {
		Player.skip();
		message.channel.send("⏭ | Skipped the current track");
	} else if (command === "autoplay") {
		Player.queue.autoPlay(!Player.queue.autoPlay());
		message.channel.send(`🔁 | Autoplay is now: **${Player.queue.autoPlay() ? "Enabled" : "Disabled"}**`);
	} else if (command === "stop") {
		Player.stop();
		message.channel.send("⏹ | Stopped the music and cleared the Player");
	} else if (command === "pause") {
		if (Player.isPaused) return message.channel.send("❌ | Music is already paused");
		Player.pause();
		message.channel.send("⏸ | Paused the music");
	} else if (command === "resume") {
		if (!Player.isPaused) return message.channel.send("❌ | Music is not paused");
		Player.resume();
		message.channel.send("▶ | Resumed the music");
	} else if (command === "Player") {
		const current = Player.currentTrack;
		const list = Player.upcomingTracks
			.map((t, i) => `${i + 1}. ${t.title} - ${t.requestedBy}`)
			.slice(0, 10)
			.join("\n");
		message.channel.send(
			`**Current Track:**\n${current.title} - ${current.requestedby}\n\n**Queue:**\n${
				list.length > 0 ? list : "No more tracks in the Player"
			}`,
		);
	} else if (command === "volume") {
		if (!args[0]) return message.channel.send(`🔊 | Current volume is: **${Player.volume}**`);
		const volume = parseInt(args[0]);
		if (isNaN(volume) || volume < 0 || volume > 100)
			return message.channel.send("❌ | Volume must be a number between 0 and 100");
		Player.setVolume(volume);
		message.channel.send(`🔊 | Volume set to: **${volume}**`);
	} else if (command === "nowplaying" || command === "np") {
		const current = Player.currentTrack;
		const progress = Player.getProgressBar();
		message.channel.send(`▶ | Now playing: **${current.title}**\n${progress}`);
	} else if (command === "leave") {
		Player.destroy();
		message.channel.send("👋 | Left the voice channel");
	} else {
		message.channel.send("❌ | Unknown command");
	}
});

Manager.on("error", (Player, error) => {
	console.log(`[${Player.guild.id}] Error emitted from the Player: ${error}`);
});
Manager.on("debug", console.log);

Manager.on("lyricsCreate", (_player, track, result) => {
	if (result.synced) {
		console.log("[LRC]\n" + result.synced.slice(0, 256) + (result.synced.length > 256 ? "..." : ""));
	} else if (result.text) {
		console.log("[TEXT]\n" + result.text.slice(0, 256) + (result.text.length > 256 ? "..." : ""));
	} else {
		console.log("No lyrics found");
	}
});

Manager.on("lyricsChange", async (_player, track, result) => {
	// Per-line update when synced lyrics available
	if (result.current) {
		const msg = [
			result.previous ? `Prev: ${result.previous}` : null,
			`Curr: **${result.current}**`,
			result.next ? `Next: ${result.next}` : null,
		]
			.filter(Boolean)
			.join("\n");
		try {
			if (_player?.userdata?.lrcmess) {
				_player.userdata.lrcmess.edit(msg);
			} else {
				const lrcmess = await _player?.userdata?.channel?.send({ content: msg });
				_player.userdata.lrcmess = lrcmess;
			}
		} catch (e) {
			console.log(e);
			const lrcmess = await _player?.userdata?.channel?.send(msg);
			_player.userdata.lrcmess = lrcmess;
		}

		console.log(`[LINE ${result.lineIndex}] ${result.current}`);
	} else if (result.text) {
		// Fallback plain text chunk
		_player?.userdata?.channel?.send(result.text.slice(0, 256) + (result.text.length > 256 ? "..." : ""));
	}
});

Manager.on("trackStart", (Player, track) => {
	Player.userdata.channel.send(`▶ Started playing: **${track.title}**`);
});
Manager.on("trackAdd", (Player, track) => {
	Player.userdata.channel.send(`✅ Added to Player: **${track.title}**`);
});

client.login(process.env.TOKEN);

process.on("uncaughtException", function (err) {
	console.log("Caught exception: " + err);
	console.log(err.stack);
});

process.on("unhandledRejection", function (err) {
	console.log("Handled exception: " + err);
	console.log(err.stack);
});
