require("dotenv").config();

const { PlayerManager } = require("ziplayer");
const { Client, GatewayIntentBits } = require("discord.js");
const { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const prefix = "!";
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});

const player = new PlayerManager({
	plugins: [new SoundCloudPlugin(), new YouTubePlugin(), new SpotifyPlugin()],
});

player.on("trackStart", (queue, track) => {
	queue.userdata.channel.send(`▶ Started playing: **${track.title}**`);
});
player.on("trackAdd", (queue, track) => {
	queue.userdata.channel.send(`✅ Added to queue: **${track.title}**`);
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
		const queue = await player.create(message.guild.id, {
			userdata: {
				channel: message.channel,
			},
			selfDeaf: true,
		});
		try {
			if (!queue.connection) await queue.connect(message.member.voice.channel);
			const success = await queue.play(args.join(" ")).catch((e) => {
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

	const queue = player.get(message.guild.id);
	if (!queue || !queue.isPlaying) return message.channel.send("❌ | No music is being played");

	if (command === "skip") {
		queue.skip();
		message.channel.send("⏭ | Skipped the current track");
	} else if (command === "autoplay") {
		queue.queue.autoPlay(!queue.queue.autoPlay());
		message.channel.send(`🔁 | Autoplay is now: **${queue.queue.autoPlay() ? "Enabled" : "Disabled"}**`);
	} else if (command === "stop") {
		queue.stop();
		message.channel.send("⏹ | Stopped the music and cleared the queue");
	} else if (command === "pause") {
		if (queue.isPaused) return message.channel.send("❌ | Music is already paused");
		queue.pause();
		message.channel.send("⏸ | Paused the music");
	} else if (command === "resume") {
		if (!queue.isPaused) return message.channel.send("❌ | Music is not paused");
		queue.resume();
		message.channel.send("▶ | Resumed the music");
	} else if (command === "queue") {
		const current = queue.currentTrack;
		const list = queue.upcomingTracks
			.map((t, i) => `${i + 1}. ${t.title} - ${t.requestedBy}`)
			.slice(0, 10)
			.join("\n");
		message.channel.send(
			`**Current Track:**\n${current.title} - ${current.requestedby}\n\n**Queue:**\n${
				list.length > 0 ? list : "No more tracks in the queue"
			}`,
		);
	} else if (command === "volume") {
		if (!args[0]) return message.channel.send(`🔊 | Current volume is: **${queue.volume}**`);
		const volume = parseInt(args[0]);
		if (isNaN(volume) || volume < 0 || volume > 100)
			return message.channel.send("❌ | Volume must be a number between 0 and 100");
		queue.setVolume(volume);
		message.channel.send(`🔊 | Volume set to: **${volume}**`);
	} else if (command === "nowplaying" || command === "np") {
		const current = queue.currentTrack;
		const progress = queue.getProgressBar();
		message.channel.send(`▶ | Now playing: **${current.title}**\n${progress}`);
	} else if (command === "leave") {
		queue.destroy();
		message.channel.send("👋 | Left the voice channel");
	} else {
		message.channel.send("❌ | Unknown command");
	}
});
player.on("error", (queue, error) => {
	console.log(`[${queue.guild.id}] Error emitted from the queue: ${error}`);
});
player.on("debug", console.log);

player.on("willPlay", (player, track, upcomming) => {
	console.log(`${track.title} will play next!`);

	player.userdata.channel.send(`⏭ | Upcomming: **${track.title}**, and \n${upcomming.map((t) => `${t.title}\n`)}`);
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
