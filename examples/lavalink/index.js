const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { PlayerManager } = require("ziplayer");
const { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const { lavalinkExt } = require("@ziplayer/extension");
require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
	throw new Error("Missing DISCORD_TOKEN environment variable");
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel],
});

const lavalink = new lavalinkExt(null, {
	nodes: [
		{
			identifier: "testlava",
			password: "youshallnotpass",
			host: "5.39.63.207",
			port: 4722,
			secure: false,
		},
		// {
		// 	identifier: "Fedot_Compot-main",
		// 	password: "https://discord.gg/wbhBExpMNj",
		// 	host: "lavalink.fedotcompot.net",
		// 	port: 443,
		// 	secure: true,
		// },
	],
	client: client,
	searchPrefix: "scsearch",
	debug: true,
});

const manager = new PlayerManager({
	// plugins: [new YouTubePlugin(), new SoundCloudPlugin(), new SpotifyPlugin()],
	extensions: [lavalink],
});

manager.on("trackStart", (player, track) => {
	const channel = player?.userdata?.channel;
	if (channel) channel.send(`Now playing: ${track.title}`);
});

manager.on("debug", console.log);

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

const prefix = "!";

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guildId || !message.content.startsWith(prefix)) return;
	if (message.author.id !== "661968947327008768") return message.reply("You are not allowed to use this command.");

	const [command, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
	const voiceChannel = message.member?.voice?.channel;

	const ensurePlayer = () => {
		const existing = manager.get(message.guildId);
		if (existing) {
			existing.userdata = existing.userdata || {};
			existing.userdata.channel = message.channel;
			return existing;
		}
		return manager.create(message.guildId, {
			leaveOnEnd: true,
			leaveOnEmpty: true,
			leaveTimeout: 30_000,
			userdata: { channel: message.channel },
			extensions: ["lavalinkExt"],
		});
	};

	try {
		switch (command?.toLowerCase()) {
			case "join": {
				if (!voiceChannel) {
					await message.reply("Join a voice channel first.");
					return;
				}
				const player = await ensurePlayer();
				await player.connect(voiceChannel);
				await message.react("✅");
				break;
			}
			case "play": {
				if (!voiceChannel) {
					await message.reply("Join a voice channel first.");
					return;
				}
				const query = args.join(" ");
				if (!query) {
					await message.reply("Usage: !play <url or search>");
					return;
				}
				const player = await ensurePlayer();
				if (!player.connection) await player.connect(voiceChannel);
				await message.channel.send(`Searching: ${query}`);
				const success = await player.play(query, message.author.id);
				if (!success) await message.reply("Could not queue your track.");
				break;
			}
			case "skip": {
				const player = manager.get(message.guildId);
				if (!player) {
					await message.reply("Nothing playing.");
					return;
				}
				player.skip();
				await message.react("⏭️");
				break;
			}
			case "stop":
			case "leave": {
				const player = manager.get(message.guildId);
				if (!player) {
					await message.reply("Nothing to stop.");
					return;
				}
				player.destroy();
				await message.react("🛑");
				break;
			}
			default:
				await message.reply("Commands: !join, !play, !skip, !stop");
		}
	} catch (error) {
		console.error("Command error", error);
		await message.reply("Something went wrong, check logs.");
	}
});

client.login(TOKEN);

process.on("SIGINT", async () => {
	console.log("Shutting down...");
	client.destroy();
	manager.destroy();
	process.exit(0);
});
