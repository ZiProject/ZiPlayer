<img width="1175" height="305" alt="logo" src="https://github.com/user-attachments/assets/b85a4976-ef7d-432a-9cae-36b11486ac0f" />

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
	extensions: [
		new voiceExt(null, {
			lang: "vi-VN",
			minimalVoiceMessageDuration: 1,
			postSilenceDelayMs: 2000,
		}),
	],
});

// Create player
const player = manager.create(guildId, {
	leaveOnEnd: true,
	leaveTimeout: 30000,
	userdata: { channel: textChannel }, // store channel for events
	// Choose extensions for this player (by name or instances)
	extensions: ["voiceExt"],
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
const player = manager.create(guildId, {
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
- For CPU-heavy TTS generation, consider offloading to `worker_threads` or a separate process and pass a stream/buffer to the
  plugin.

## Creating Custom Plugins

```typescript
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

export class MyPlugin extends BasePlugin {
	name = "myplugin";
	version = "1.0.0";

	canHandle(query: string): boolean {
		return query.includes("mysite.com");
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		// Implement search logic
		return {
			tracks: [
				/* ... */
			],
		};
	}

	async getStream(track: Track): Promise<StreamInfo> {
		// Return audio stream
		return { stream, type: "arbitrary" };
	}
}
```

## Progress Bar

Display the current playback progress with `getProgressBar`:

```typescript
console.log(player.getProgressBar({ size: 30, barChar: "-", progressChar: "🔘" }));
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

## Testing

This repository includes a lightweight unit test suite using Node's built-in test runner (no external dependencies).

- Requirements: Node.js 18+
- Run tests from the repository root:

```
npm test
```

Notes
<img width="1000" height="1000" alt="Untitled-1" src="https://github.com/user-attachments/assets/4e7855e8-6044-4c49-90bd-867436173b4f" />

- Tests focus on core data structures (Queue, PluginManager, Player/Manager basics) and plugin logic that does not require network
  calls.
- Network-heavy behaviors (e.g., resolving or streaming from YouTube/SoundCloud/Spotify) are intentionally not exercised to keep
  tests deterministic and fast.

## License

MIT License
