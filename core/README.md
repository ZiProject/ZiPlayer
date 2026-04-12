<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />

# ziplayer

A modular Discord voice player with plugin system for @discordjs/voice.

## Features

- 🎵 **Plugin-based architecture** - Easy to extend with new sources
- 🎶 **Multiple source support** - YouTube, SoundCloud, Spotify (with fallback)
- 🔊 **Queue management** - Add, remove, shuffle, clear
- 🎚️ **Volume control** - 0-200% volume range
- ⏯️ **Playback control** - Play, pause, resume, stop, skip
- 🔁 **Auto play** - Automatically replay the queue when it ends
- 🔂 **Loop control** - Repeat a single track or the entire queue
- 📊 **Progress bar** - Display playback progress with customizable icons
- 🔔 **Event-driven** - Rich event system for all player actions
- 🎭 **Multi-guild support** - Manage players across multiple Discord servers
- 🗃️ **User data** - Attach custom data to each player for later use
- 🔌 **Lavalink** - Support manage an external Lavalink JVM node
- 🎛️ **Audio Filters** - Apply real-time audio effects using FFmpeg (bassboost, nightcore, etc.)

## Installation

```bash
npm install ziplayer @ziplayer/plugin @ziplayer/extension @discordjs/voice discord.js
```

## Quick Start

```typescript
import { PlayerManager } from "ziplayer";
import { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } from "@ziplayer/plugin";
import { voiceExt } from "@ziplayer/extension";

const manager = new PlayerManager({
	plugins: [new SoundCloudPlugin(), new YouTubePlugin(), new SpotifyPlugin()],
	extensions: [new voiceExt()],
});

// Create player
const player = await manager.create(guildId, {
	leaveOnEnd: true,
	leaveTimeout: 30000,
	userdata: { channel: textChannel }, // store channel for events
	// Choose extensions for this player (by name or instances)
	// extensions: ["voiceExt"],
	// Apply audio filters
	// filters: ["bassboost", "normalize"],
});

// Connect and play
await player.connect(voiceChannel);
await player.play("Never Gonna Give You Up", userId);

// Play a full YouTube playlist
await player.play("https://www.youtube.com/playlist?list=PL123", userId);

// Enable autoplay
player.queue.autoPlay(true);

// Play a full SoundCloud playlist
await player.play("https://soundcloud.com/artist/sets/playlist", userId);

// Events
player.on("willPlay", (player, track) => {
	console.log(`Up next: ${track.title}`);
});
player.on("trackStart", (player, track) => {
	console.log(`Now playing: ${track.title}`);
	player.userdata?.channel?.send(`Now playing: ${track.title}`);
});

// Audio Filters
player.filter.applyFilter("bassboost"); // Apply bass boost
player.filter.applyFilter("nightcore"); // Apply nightcore effect
player.filter.removeFilter("bassboost"); // Remove specific filter
player.filter.clearFilters(); // Clear all filters

// Apply custom filter
player.filter.applyFilter({
	name: "custom",
	ffmpegFilter: "volume=1.5,treble=g=5",
	description: "Volume boost + treble boost",
});

// Receive transcripts
manager.on("voiceCreate", (player, evt) => {
	console.log(`User ${evt.userId} said: ${evt.content}`);
});
```

### TTS (Interrupt Mode)

Play short text-to-speech messages without losing music progress. The player pauses music, plays TTS on a dedicated AudioPlayer,
then resumes.

- Requirements: `@ziplayer/plugin` with `TTSPlugin` installed and registered in `PlayerManager`.

```ts
import { PlayerManager } from "ziplayer";
import { TTSPlugin, YouTubePlugin, SoundCloudPlugin, SpotifyPlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({
	plugins: [new TTSPlugin({ defaultLang: "vi" }), new YouTubePlugin(), new SoundCloudPlugin(), new SpotifyPlugin()],
});

// Create a player with TTS interrupt enabled
const player = await manager.create(guildId, {
	tts: {
		createPlayer: true, // pre-create the internal TTS AudioPlayer
		interrupt: true, // pause music, swap to TTS, then resume
		volume: 1, // 1 => 100%
	},
});

await player.connect(voiceChannel);

// Trigger TTS by playing a TTS query (depends on your TTS plugin)
await player.play("tts: xin chào mọi người", userId);

// Listen to TTS lifecycle events
manager.on("ttsStart", (plr, { track }) => console.log("TTS start", track?.title));
manager.on("ttsEnd", (plr) => console.log("TTS end"));
```

Notes

- The detection uses track.source that includes "tts" or query starting with `tts:`.
- If you need more control, call `player.interruptWithTTSTrack(track)` after building a TTS track via your plugin.

### extensions and Lavalink Process

Use `lavalinkExt` when you need ZiPlayer to manage an external Lavalink JVM node. The extension starts, stops, and optionally
restarts the Lavalink jar and forwards lifecycle events through the manager/player.

```ts
import { PlayerManager } from "ziplayer";
import { lavalinkExt, lyricsExt, voiceExt } from "@ziplayer/extension";

const manager = new PlayerManager({
	extensions: [
		new lavalinkExt(null, {
			nodes: [
				{
					identifier: "locallavalink",
					password: "youshallnotpass",
					host: "localhost",
					port: 2333,
					secure: false,
				},
			],
			client: client,
			searchPrefix: "scsearch",
		}),
		new voiceExt(null, { lang: "en-US" }),
		new lyricsExt(null, { provider: "lrclib" }),
	],
	//etc...
});

//crete player:
const player = await manager.create("id-player", {
	extensions: ["lavalinkExt", "voiceExt", "lyricsExt"],
	//etc... userdata,
});

//connec voice
if (!player.connection) await player.connect(interaction?.member?.voice?.channel);

//play music
await player.play(query, interaction?.user);
```

## Events

All player events are forwarded through the PlayerManager:

- `trackStart` - When a track starts playing
- `willPlay` - Before a track begins playing
- `trackEnd` - When a track finishes
- `queueEnd` - When the queue is empty
- `playerError` - When an error occurs
- `queueAdd` - When a track is added
- `volumeChange` - When volume changes
- And more...

## Useful Links

[Example](https://github.com/ZiProject/ZiPlayer/tree/main/examples) | [Repo](https://github.com/ZiProject/ZiPlayer) |
[Package](https://www.npmjs.com/package/ziplayer) | [Plugin](https://www.npmjs.com/package/@ziplayer/plugin) |
[Extension](https://www.npmjs.com/package/@ziplayer/extension)

## License

MIT License
