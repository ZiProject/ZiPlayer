# ZiPlayer — AI Developer Guide

<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />
> A complete reference for AI assistants helping developers build Discord music bots with the `ziplayer` ecosystem.

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Installation](#2-installation)
3. [Core Architecture](#3-core-architecture)
4. [PlayerManager](#4-playermanager)
5. [Player](#5-player)
6. [Queue](#6-queue)
7. [Plugins](#7-plugins)
8. [Extensions](#8-extensions)
9. [Audio Filters](#9-audio-filters)
10. [Events Reference](#10-events-reference)
11. [TypeScript Types](#11-typescript-types)
12. [Common Patterns & Recipes](#12-common-patterns--recipes)
13. [Error Handling](#13-error-handling)
14. [Anti-Patterns to Avoid](#14-anti-patterns-to-avoid)

---

## 1. Package Overview

| Package                | Role                                                            | npm                |
| ---------------------- | --------------------------------------------------------------- | ------------------ |
| `ziplayer`             | Core player engine                                              | Required           |
| `@ziplayer/plugin`     | Source plugins (YouTube, SoundCloud, Spotify, TTS, Attachments) | Required for audio |
| `@ziplayer/extension`  | Extensions (voice STT, Lavalink, lyrics)                        | Optional           |
| `@ziplayer/infinity`   | Cobalt-powered multi-platform plugin                            | Optional           |
| `@ziplayer/ytexecplug` | yt-dlp fallback for YouTube                                     | Optional           |
| `@discordjs/voice`     | Discord voice layer                                             | Peer dep           |
| `discord.js`           | Discord bot framework                                           | Peer dep           |

---

## 2. Installation

```bash
npm install ziplayer @ziplayer/plugin @ziplayer/extension @ziplayer/infinity @discordjs/voice discord.js opusscript
```

---

## 3. Core Architecture

```
PlayerManager            ← singleton-like, manages all guilds
  └── Player (per guild) ← controls audio for one server
        ├── Queue        ← ordered list of tracks
        ├── PluginManager← resolves queries → streams
        ├── ExtensionManager ← hooks into lifecycle
        └── FilterManager← real-time FFmpeg audio effects
```

### Lifecycle flow

```
manager.create(guildId, opts)
  → Player constructed → extensions attached
  → player.connect(voiceChannel)
  → player.play(query, userId)
      → extensionManager.BeforePlayHooks()   ← extensions may intercept
      → pluginManager.search() / getStream()
      → AudioResource created (with filters)
      → audioPlayer.play(resource)
      → events: queueAdd → trackStart → trackEnd → queueEnd
  → player.destroy()
      → extensions.onDestroy() → voice disconnected → cleanup
```

---

## 4. PlayerManager

### Construction

```typescript
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin } from "@ziplayer/plugin";
import { InfinityPlugin } from "@ziplayer/infinity";
import { voiceExt, lyricsExt } from "@ziplayer/extension";

const manager = new PlayerManager({
	plugins: [
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin({}),
		new SoundCloudPlugin(),
		new InfinityPlugin(),
		new SpotifyPlugin(),
	],
	extensions: [new voiceExt(null, { lang: "en-US" }), new lyricsExt(null, { provider: "lrclib", includeSynced: true })],
});
```

### Key methods

| Method    | Signature                                      | Description                                          |
| --------- | ---------------------------------------------- | ---------------------------------------------------- |
| `create`  | `(guildOrId, options?) → Promise<Player>`      | Creates (or returns existing) player for a guild     |
| `get`     | `(guildOrId) → Player \| undefined`            | Gets existing player                                 |
| `has`     | `(guildOrId) → boolean`                        | Checks if player exists                              |
| `delete`  | `(guildOrId) → boolean`                        | Destroys and removes a player                        |
| `getall`  | `() → Player[]`                                | All active players                                   |
| `destroy` | `() → void`                                    | Destroys ALL players                                 |
| `search`  | `(query, requestedBy) → Promise<SearchResult>` | Search without a player (uses first matching plugin) |

### PlayerManager options

```typescript
interface PlayerManagerOptions {
	plugins?: SourcePluginLike[];
	extensions?: any[];
	extractorTimeout?: number; // ms, default 10000
}
```

---

## 5. Player

### Creating a player

```typescript
const player = await manager.create(guildId, {
	leaveOnEnd: true, // leave voice when queue ends
	leaveTimeout: 30_000, // ms before leaving (default 100000)
	volume: 100, // 0–200, default 100
	quality: "high", // "high" | "low"
	selfDeaf: true,
	selfMute: false,
	extractorTimeout: 50_000, // ms per plugin operation
	userdata: { channel: textChannel }, // arbitrary data, access via player.userdata
	extensions: ["voiceExt", "lyricsExt"], // activate by name or instance
	filters: ["bassboost", "normalize"], // pre-apply audio filters
	tts: {
		createPlayer: true, // pre-create TTS AudioPlayer
		interrupt: true, // pause music → play TTS → resume
		volume: 100, // TTS volume (0–200)
		Max_Time_TTS: 60_000, // max TTS playback time ms
	},
});
```

### Connecting

```typescript
await player.connect(voiceChannel); // discord.js VoiceChannel
```

### Playing

```typescript
// All of these work:
await player.play("Never Gonna Give You Up", userId); // text search
await player.play("https://youtube.com/watch?v=...", userId); // direct URL
await player.play("https://youtube.com/playlist?list=...", userId); // playlist
await player.play("tts: Hello everyone!", userId); // TTS
await player.play(trackObject, userId); // Track object
await player.play(searchResult, userId); // SearchResult object
await player.play(null); // resume from queue

//InfinityPlugin:
await player.play("https://www.youtube.com/watch?v=dQw4w9WgXcQ", userId);
await player.play("https://www.tiktok.com/@user/video/123", userId);
await player.play("https://soundcloud.com/artist/track", userId);
await player.play("https://twitter.com/user/status/123", userId);
```

### Playback controls

```typescript
player.pause(); // → boolean
player.resume(); // → boolean
player.skip(); // → boolean (skip to next)
player.skip(2); // → boolean (skip to index 2)
await player.previous(); // → boolean (go back one)
player.stop(); // → boolean (stop + clear queue)
await player.seek(30_000); // → boolean (seek to 30s)
player.setVolume(75); // 0–200, returns boolean
player.shuffle(); // shuffles queue
player.clearQueue();
player.loop("off"); // "off" | "track" | "queue"
player.loop(0); // same as "off"
player.autoPlay(true); // enable auto-play (related tracks)
```

### Information

```typescript
player.currentTrack; // Track | null
player.previousTrack; // Track | null (last played)
player.upcomingTracks; // Track[]
player.previousTracks; // Track[]
player.relatedTracks; // Track[] | null
player.queueSize; // number
player.volume; // number
player.isPlaying; // boolean
player.isPaused; // boolean
player.availablePlugins; // string[] (plugin names)
player.userdata; // Record<string, any>

player.getProgressBar(); // "0:00 | ▬▬▬🔘▬ | 3:32"
player.getProgressBar({ size: 30, barChar: "━", progressChar: "⬤" });
player.getTime(); // { current: ms, total: ms, format: "1:23" }
player.formatTime(90_000); // "01:30"
```

### Saving a track stream

```typescript
const stream = await player.save(track);
stream.pipe(fs.createWriteStream("output.mp3"));

// With options:
const stream = await player.save(track, {
	filename: "my-song.mp3",
	seek: 30_000, // start at 30s
	filter: [{ name: "normalize", ffmpegFilter: "loudnorm", description: "Normalize" }],
});
```

### Inserting tracks mid-queue

```typescript
// Insert at position 0 = plays after current track
await player.insert("song name", 0, userId);
await player.insert(trackObject, 0);
await player.insert([track1, track2], 0);
```

### Removing a track

```typescript
const removed = player.queue.remove(2); // removes track at index 2
```

### Destroying

```typescript
player.destroy();
// Stops audio, disconnects voice, clears queue, fires onDestroy on all extensions.
// After this call, do NOT reuse the player instance — call manager.create() again.
```

### Extension management

```typescript
player.attachExtension(myExt);
player.detachExtension(myExt);
player.getExtensions(); // readonly BaseExtension[]
```

### Filter management (see §9)

```typescript
await player.filter.applyFilter("bassboost");
await player.filter.removeFilter("bassboost");
await player.filter.clearAll();
player.filter.getActiveFilters(); // AudioFilter[]
player.filter.hasFilter("nightcore"); // boolean
player.filter.getAvailableFilters();
player.filter.getFiltersByCategory("eq");
```

---

## 6. Queue

Access via `player.queue`.

### Adding

```typescript
player.queue.add(track);
player.queue.addMultiple([track1, track2]);
player.queue.insert(track, 0); // 0 = next up
player.queue.insertMultiple([t1, t2], 0);
```

### Removing / navigating

```typescript
player.queue.remove(index)           // Track | null
player.queue.next(ignoreLoop?)       // Track | null — advances queue
player.queue.previous()              // Track | null — goes back in history
player.queue.clear()
player.queue.shuffle()
```

### State / getters

```typescript
player.queue.size; // number of upcoming tracks
player.queue.isEmpty; // boolean
player.queue.currentTrack; // Track | null
player.queue.nextTrack; // Track | null (peek)
player.queue.previousTracks; // Track[] (history, max 200)
player.queue.getTracks(); // Track[] (all upcoming)
player.queue.getTrack(index); // Track | null
player.queue.willNextTrack(); // Track | null (autoplay hint)
player.queue.relatedTracks(); // Track[] | null
```

### Loop & autoplay

```typescript
player.queue.loop(); // get current mode
player.queue.loop("track"); // "off" | "track" | "queue"
player.queue.autoPlay(); // get state
player.queue.autoPlay(true); // enable/disable
```

---

## 7. Plugins

### Built-in plugins (`@ziplayer/plugin`)

#### YouTubePlugin

```typescript
new YouTubePlugin({
	searchLimit: 10, // max search results
	// fallbackStream: fn(Track) => Promise<StreamInfo>
	// fistStream: fn(Track) => Promise<StreamInfo>
});
```

Handles: `youtube.com`, `youtu.be`, `music.youtube.com`, any free text search.

#### SoundCloudPlugin

```typescript
new SoundCloudPlugin();
```

Handles: `soundcloud.com` URLs, free text search (if not a URL for another service).

#### SpotifyPlugin

```typescript
new SpotifyPlugin();
```

Handles: `spotify:track:...`, `open.spotify.com/...` ⚠️ Metadata only — does NOT stream. Relies on YouTube/SoundCloud fallback for
audio.

#### TTSPlugin

```typescript
new TTSPlugin({
	defaultLang: "vi", // language code
	slow: false,
	createStream: async (text, ctx) => {
		// return Readable | URL string | Buffer
	},
});
```

Query formats:

- `tts: <text>` — uses defaultLang
- `tts:<lang>:<text>` — e.g., `tts:en:Hello`
- `tts:<lang>:<slow>:<text>` — e.g., `tts:en:1:Hello` (slow=true)

#### AttachmentsPlugin

```typescript
new AttachmentsPlugin({
	maxFileSize: 25 * 1024 * 1024, // 25 MB
	allowedExtensions: ["mp3", "wav", "ogg", "m4a", "flac"],
	debug: false,
});
```

Handles: Discord CDN URLs (`cdn.discordapp.com`), direct audio file URLs.

### Writing a custom plugin

```typescript
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";

export class MyRadioPlugin extends BasePlugin {
	name = "myradio";
	version = "1.0.0";
	priority = 5; // lower = tried first in fallback; default 0

	canHandle(query: string): boolean {
		return query.startsWith("radio:");
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		const track: Track = {
			id: query,
			title: "My Radio Station",
			url: "https://stream.myradio.com/live.mp3",
			duration: 0, // 0 for live streams
			requestedBy,
			source: this.name,
			metadata: { isLive: true },
		};
		return { tracks: [track] };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		const response = await fetch(track.url);
		const stream = Readable.fromWeb(response.body as any);
		return { stream, type: "arbitrary" };
	}

	// Optional: fallback when getStream fails
	async getFallback(track: Track): Promise<StreamInfo> {
		/* ... */
	}

	// Optional: related track suggestions for autoplay
	async getRelatedTracks(track: Track, opts = {}): Promise<Track[]> {
		return [];
	}

	// Optional: extract all tracks from a playlist URL
	async extractPlaylist(url: string, requestedBy: string): Promise<Track[]> {
		return [];
	}
}
```

### Plugin priority & fallback order

When `getStream` fails on the primary plugin, ZiPlayer tries all other plugins in order of `priority` (ascending — lower = higher
priority). Within the same priority group, `Promise.any` races them.

```typescript
new MyPlugin({ priority: 10 }); // tried last in fallback
```

---

## 8. Extensions

### Built-in extensions (`@ziplayer/extension`)

#### voiceExt — Speech-to-Text

```typescript
import { voiceExt } from "@ziplayer/extension";

new voiceExt(null, {
	lang: "en-US", // Google Speech language
	ignoreBots: true,
	focusUser: "userId", // only listen to one user
	minimalVoiceMessageDuration: 1, // seconds
	postSilenceDelayMs: 2000, // wait after silence before STT
	profanityFilter: false,
	key: process.env.GSPEECH_V2_KEY, // own API key (recommended)
	resolveSpeech: async (monoBuffer, opts) => "custom transcript",
	onVoiceChange: async ({ userId, guildId, current }) => {
		// return partial overrides per session
		return { lang: "vi-VN" };
	},
});
```

Listen for results:

```typescript
manager.on("voiceCreate", (player, evt) => {
	console.log(evt.userId, evt.content, evt.channelId, evt.guildId);
	// evt.user and evt.channel if client was passed
});
```

#### lyricsExt — Auto lyrics

```typescript
import { lyricsExt } from "@ziplayer/extension";

new lyricsExt(null, {
	provider: "lrclib", // "lrclib" | "lyricsovh"
	includeSynced: true, // prefer LRC synced lyrics
	autoFetchOnTrackStart: true,
	sanitizeTitle: true, // clean title before querying
	maxLength: 32_000,
});
```

Events:

```typescript
manager.on("lyricsCreate", (player, track, result) => {
	console.log(result.text); // plain text
	console.log(result.synced); // LRC string
});

manager.on("lyricsChange", (player, track, result) => {
	// Fires per line when synced lyrics available
	console.log(result.current, result.previous, result.next);
	console.log(result.lineIndex, result.timeMs);
});
```

#### lavalinkExt — Lavalink server

```typescript
import { lavalinkExt } from "@ziplayer/extension";

new lavalinkExt(null, {
	nodes: [{ host: "localhost", port: 2333, password: "youshallnotpass", secure: false }],
	client: discordClient, // discord.js Client (for voice events)
	userId: "botUserId", // auto-detected from client if omitted
	searchPrefix: "scsearch", // default search prefix for Lavalink
	nodeSort: "players", // "players" | "cpu" | "memory" | "random"
	requestTimeoutMs: 10_000,
	updateInterval: 5_000,
	debug: false,
});
```

### Writing a custom extension

```typescript
import { BaseExtension, Player, ExtensionContext } from "ziplayer";

export class MyExtension extends BaseExtension {
	name = "myExtension";
	version = "1.0.0";
	player: Player | null = null;

	// Called to check if extension should activate for this player
	active(ctx: { player: Player; manager: any }): boolean {
		if (!this.player) this.player = ctx.player;
		return true;
	}

	// Called once when registered to a player
	onRegister(ctx: ExtensionContext): void {
		ctx.player.on("trackStart", (track) => {
			console.log("Custom ext: now playing", track.title);
		});
	}

	// Called when player is destroyed
	onDestroy(ctx: ExtensionContext): void {
		// cleanup
	}

	// Intercept play requests BEFORE they resolve
	async beforePlay(ctx, payload) {
		// Can mutate payload.query, return tracks, or set handled: true
		return undefined; // let normal flow continue
	}

	// Called AFTER play resolves (success or failure)
	async afterPlay(ctx, payload) {
		console.log("Played:", payload.tracks?.length, "tracks, success:", payload.success);
	}

	// Provide search results (skips plugins if returns tracks)
	async provideSearch(ctx, { query, requestedBy }) {
		return null; // return SearchResult to intercept
	}

	// Provide audio stream (skips plugins if returns stream)
	async provideStream(ctx, { track }) {
		return null; // return StreamInfo to intercept
	}
}
```

---

## 9. Audio Filters

ZiPlayer applies FFmpeg filters in real-time. Filters are re-applied immediately to the current track.

### Predefined filters

| Name          | Category | Description            |
| ------------- | -------- | ---------------------- |
| `bassboost`   | eq       | Bass boost             |
| `trebleboost` | eq       | Treble boost           |
| `normalize`   | volume   | Loudness normalization |
| `nightcore`   | speed    | Speed + pitch up       |
| `lofi`        | speed    | Slow + lo-fi effect    |
| `vaporwave`   | speed    | Vaporwave aesthetic    |
| `8D`          | effect   | 8D surround effect     |
| `echo`        | effect   | Echo/reverb            |
| `reverb`      | effect   | Reverb                 |
| `chorus`      | effect   | Chorus                 |
| `karaoke`     | vocal    | Remove vocals          |
| `slow`        | speed    | 0.5× speed             |
| `fast`        | speed    | 2.0× speed             |
| `mono`        | channel  | Mono output            |
| `compressor`  | dynamics | Dynamic compression    |
| `limiter`     | dynamics | Limiter                |

### Usage

```typescript
// Apply
await player.filter.applyFilter("bassboost");
await player.filter.applyFilter("nightcore");

// Custom filter
await player.filter.applyFilter({
	name: "custom",
	ffmpegFilter: "volume=1.5,treble=g=5",
	description: "Volume + treble boost",
	category: "custom",
});

// Multiple at once
await player.filter.applyFilters(["bassboost", "normalize"]);

// Remove
await player.filter.removeFilter("bassboost");
await player.filter.clearAll();

// Query
player.filter.hasFilter("nightcore"); // boolean
player.filter.getActiveFilters(); // AudioFilter[]
player.filter.getFilterString(); // raw FFmpeg string
player.filter.getAvailableFilters(); // all predefined
player.filter.getFiltersByCategory("eq");
```

---

## 10. Events Reference

### Manager events (recommended — all player events forwarded here)

```typescript
manager.on("trackStart", (player, track) => {});
manager.on("trackEnd", (player, track) => {});
manager.on("queueEnd", (player) => {});
manager.on("willPlay", (player, track, upcomingTracks) => {});
manager.on("queueAdd", (player, track) => {});
manager.on("queueAddList", (player, tracks) => {});
manager.on("queueRemove", (player, track, index) => {});
manager.on("playerPause", (player, track) => {});
manager.on("playerResume", (player, track) => {});
manager.on("playerStop", (player) => {});
manager.on("playerDestroy", (player) => {});
manager.on("playerError", (player, error, track?) => {});
manager.on("connectionError", (player, error) => {});
manager.on("volumeChange", (player, oldVolume, newVolume) => {});
manager.on("ttsStart", (player, { track }) => {});
manager.on("ttsEnd", (player) => {});
manager.on("voiceCreate", (player, evt) => {}); // voiceExt
manager.on("lyricsCreate", (player, track, result) => {}); // lyricsExt
manager.on("lyricsChange", (player, track, result) => {}); // lyricsExt
manager.on("debug", (message, ...args) => {});
```

### Direct player events

```typescript
player.on("trackStart", (track) => {});
player.on("trackEnd", (track) => {});
player.on("queueEnd", () => {});
player.on("willPlay", (track, upcomingTracks) => {});
player.on("playerError", (error, track?) => {});
player.on("ttsStart", ({ track }) => {});
player.on("ttsEnd", () => {});
player.on("debug", (message) => {});
// ... same names as manager, minus the leading `player` param
```

---

## 11. TypeScript Types

```typescript
interface Track {
	id: string;
	title: string;
	url: string;
	duration: number; // milliseconds (some plugins use seconds — check source)
	thumbnail?: string;
	requestedBy: string;
	source: string; // plugin name: "youtube" | "soundcloud" | "tts" | ...
	metadata?: Record<string, any>;
}

interface SearchResult {
	tracks: Track[];
	playlist?: { name: string; url: string; thumbnail?: string };
}

interface StreamInfo {
	stream: Readable;
	type: "webm/opus" | "ogg/opus" | "arbitrary";
	metadata?: Record<string, any>;
}

type LoopMode = "off" | "track" | "queue";

interface AudioFilter {
	name: string;
	ffmpegFilter: string;
	description: string;
	category?: string;
}
```

---

## 12. Common Patterns & Recipes

### Basic Discord bot setup (TypeScript)

```typescript
import { Client, GatewayIntentBits } from "discord.js";
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin } from "@ziplayer/plugin";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const manager = new PlayerManager({
	plugins: [new YouTubePlugin({}), new SoundCloudPlugin(), new SpotifyPlugin()],
});

manager.on("trackStart", (player, track) => {
	(player.userdata?.channel as any)?.send(`▶ **${track.title}**`);
});

client.on("messageCreate", async (msg) => {
	if (msg.author.bot || !msg.guildId) return;
	if (!msg.content.startsWith("!play ")) return;

	const query = msg.content.slice(6).trim();
	const voiceChannel = (msg.member as any)?.voice?.channel;
	if (!voiceChannel) return msg.reply("Join a voice channel first!");

	const player = await manager.create(msg.guildId, {
		leaveOnEnd: true,
		leaveTimeout: 30_000,
		userdata: { channel: msg.channel },
	});

	if (!player.connection) await player.connect(voiceChannel);
	await player.play(query, msg.author.id);
	msg.reply(`Queued: **${query}**`);
});

client.login(process.env.DISCORD_TOKEN);
```

### TTS with music interrupt

```typescript
const player = await manager.create(guildId, {
	tts: { createPlayer: true, interrupt: true, volume: 100 },
});

// This pauses music, speaks, then auto-resumes:
await player.play("tts: Now playing your requested song!", userId);
```

### Voice-controlled bot

```typescript
manager.on("voiceCreate", (player, evt) => {
	const text = evt.content.toLowerCase();

	if (text.includes("skip")) player.skip();
	else if (text.includes("pause")) player.pause();
	else if (text.includes("resume")) player.resume();
	else if (text.includes("stop")) player.stop();
	else if (text.startsWith("play ")) {
		player.play(text.slice(5), evt.userId);
	}
});
```

### Autoplay (related tracks)

```typescript
player.queue.autoPlay(true);
// When queue empties, willNextTrack() is used (set by generateWillNext internally)
// ZiPlayer auto-fetches related tracks via pluginManager.getRelatedTracks()
```

### Loop patterns

```typescript
player.loop("track"); // repeat current song forever
player.loop("queue"); // loop entire playlist
player.loop("off"); // no loop (default)
```

### Progress bar in embeds

```typescript
manager.on("trackStart", (player, track) => {
	const progress = player.getProgressBar({
		size: 20,
		barChar: "▬",
		progressChar: "🔘",
	});
	// "0:00 | ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬🔘 | 3:32"
});
```

### Search without playing

```typescript
const result = await player.search("lofi hip hop", userId);
// result.tracks[0].title, .duration, .thumbnail, .url, etc.

// Or via manager (no player needed):
const result = await manager.search("lofi hip hop", userId);
```

### Custom extension for auto-announce

```typescript
class AutoAnnounceExt extends BaseExtension {
	name = "autoAnnounce";
	version = "1.0.0";
	player: Player | null = null;

	active(ctx: any): boolean {
		if (!this.player) this.player = ctx.player;
		const p = this.player!;
		if ((p as any).__announced) return true;
		(p as any).__announced = true;

		p.on("trackStart", (track) => {
			p.userdata?.channel?.send(`▶ Now playing: **${track.title}**`);
		});
		p.on("queueEnd", () => {
			p.userdata?.channel?.send("Queue finished.");
		});
		return true;
	}
}

const manager = new PlayerManager({ extensions: [new AutoAnnounceExt()] });
const player = await manager.create(guildId, { extensions: ["autoAnnounce"] });
```

### Getting global manager from anywhere

```typescript
import { getManager, getPlayer } from "ziplayer";

const manager = getManager(); // PlayerManager | null
const player = getPlayer("guild-id"); // Player | null
```

---

## 13. Error Handling

### Recommended pattern

```typescript
try {
	await player.connect(voiceChannel);
	const success = await player.play(query, userId);
	if (!success) channel.send("❌ Could not play that.");
} catch (err) {
	channel.send(`❌ Error: ${(err as Error).message}`);
}

manager.on("playerError", (player, error, track) => {
	console.error(`[${player.guildId}] Error on "${track?.title}":`, error.message);
	// ZiPlayer auto-skips to next track after playerError
});

manager.on("connectionError", (player, error) => {
	console.error(`[${player.guildId}] Voice error:`, error.message);
	player.destroy();
});
```

### Plugin timeout

```typescript
// Per-player timeout for plugin operations:
const player = await manager.create(guildId, {
	extractorTimeout: 15_000, // 15 seconds (default: 50000)
});
```

---

## 14. Anti-Patterns to Avoid

| ❌ Wrong                                               | ✅ Correct                                 |
| ------------------------------------------------------ | ------------------------------------------ |
| Reusing `player` after `player.destroy()`              | Call `manager.create()` again              |
| Creating a new `PlayerManager` per command             | One manager for the whole bot              |
| Not awaiting `player.connect()` before `player.play()` | Always `await connect()` first             |
| Ignoring `playerError` events                          | Always attach an error handler             |
| Calling `player.play()` with empty string              | Validate input before calling              |
| Setting `leaveTimeout: 0`                              | Use `leaveOnEnd: false` instead            |
| Using `player.queue.next()` directly                   | Use `player.skip()` to preserve events     |
| Forgetting `disconnect()` on bot shutdown              | Call `manager.destroy()` in SIGINT handler |

```typescript
// Clean shutdown
process.on("SIGINT", () => {
	manager.destroy();
	client.destroy();
	process.exit(0);
});
```

---

## Quick Reference Card

```
CREATE    manager.create(guildId, opts) → Player
CONNECT   player.connect(voiceChannel)
PLAY      player.play(query | Track | SearchResult | null, userId?)
PAUSE     player.pause()
RESUME    player.resume()
SKIP      player.skip(index?)
PREVIOUS  player.previous()
STOP      player.stop()           // also clears queue
SEEK      player.seek(ms)
VOLUME    player.setVolume(0–200)
LOOP      player.loop("off"|"track"|"queue")
SHUFFLE   player.shuffle()
AUTOPLAY  player.autoPlay(bool)
DESTROY   player.destroy()

FILTER    player.filter.applyFilter("bassboost")
          player.filter.removeFilter("nightcore")
          player.filter.clearAll()

QUEUE     player.queue.size / isEmpty / currentTrack / nextTrack
          player.queue.add(track) / insert(track, 0) / remove(index)
          player.queue.getTracks() / getTrack(index)

INFO      player.currentTrack / previousTrack / upcomingTracks
          player.getProgressBar() / getTime()
          player.isPlaying / isPaused / volume
```
