require("dotenv").config();

const { PlayerManager } = require("ziplayer");
const { Client, GatewayIntentBits } = require("discord.js");
const { SoundCloudPlugin: ZiSoundCloudPlugin, YouTubePlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const { DefaultExtractors } = require("@discord-player/extractor");
const { provide } = require("@ziplayer/adapters");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const { YoutubeiExtractor } = require("discord-player-youtubei");

const client = new Client({ intents: 33409 });

const manager = new PlayerManager({
	plugins: [
		provide(DefaultExtractors),
		provide(SoundCloudPlugin),
		provide(YoutubeiExtractor),
		// new ZiSoundCloudPlugin(),
		// new YouTubePlugin(),
		// new SpotifyPlugin(),
	],
});

manager.on("trackStart", (player, track) => {
	console.log(`▶ Started playing: **${track.title}**`);
});
manager.on("trackAdd", (player, track) => {
	console.log(`✅ Added to queue: **${track.title}**`);
});

client.on("clientReady", async (client) => {
	console.log(`Logged in as ${client.user.tag}`);
	console.log(`Start music`);
	const player = await manager.create("__test_", {
		userdata: {},
		selfDeaf: true,
	});
	try {
		const voiceChannel = await client.channels.fetch("1333093279402692661");
		if (!player.connection) await player.connect(voiceChannel);
		const success = await player.play("NEVER - Neuro x Evil").catch((e) => {
			console.log(e);
		});

		if (success) console.log(`✅ | success play track`);
	} catch (e) {
		console.log(e);

		return console.log("❌ | Could not join your voice channel");
	}
	return;
});

manager.on("error", (queue, error) => {
	console.log(`[${queue.guild.id}] Error emitted from the queue: ${error}`);
});

manager.on("debug", console.log);

manager.on("willPlay", (player, track, upcomming) => {
	console.log(`${track.title} will play next!`);
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
