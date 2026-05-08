# 🤖 AI Guide for ZiPlayer

A comprehensive guide for AI assistants and developers working with ZiPlayer - a powerful Discord music player library.

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Core Concepts](#core-concepts)
4. [API Reference](#api-reference)
5. [Common Patterns](#common-patterns)
6. [Troubleshooting](#troubleshooting)
7. [Code Examples](#code-examples)

---

## 🎯 Project Overview

**ZiPlayer** is an extensible Discord music engine built on `@discordjs/voice`.

### Key Features

- Plugin-driven architecture (YouTube, SoundCloud, Spotify, TTS)
- Extension system (voice commands, lyrics, Lavalink)
- Audio filters (bassboost, nightcore, etc.)
- Smart caching and fallback system

### Tech Stack

- TypeScript
- `@discordjs/voice` for audio
- FFmpeg for audio processing
- Node.js EventEmitter for events

---

### Component Responsibilities

| Component          | Responsibility                                     |
| ------------------ | -------------------------------------------------- |
| `PlayerManager`    | Creates/manages players, global event bus          |
| `Player`           | Per-guild audio playback, controls, event emission |
| `Queue`            | Track management, loop modes, history, auto-play   |
| `PluginManager`    | Audio source resolution, streaming, fallback logic |
| `ExtensionManager` | Custom hooks (search, stream, before/after play)   |
| `FilterManager`    | FFmpeg audio effects                               |

---

## 🧠 Core Concepts

### 1. Player Lifecycle

```typescript
// Create → Connect → Play → (Auto-save) → Destroy
const player = await manager.create(guildId, options);
await player.connect(voiceChannel);
await player.play(query, userId);
// ... auto-saves periodically
player.destroy();
```

### 2. Queue Loop Modes

```typescript
player.loop("off"); // No loop (default)
player.loop("track"); // Repeat current track
player.loop("queue"); // Repeat entire queue
```

### 3. Event Flow

```
trackStart → playing → trackEnd → playNext → (loop/autoplay)
                                    ↓
                              queueEnd → leave
```

### 4. Plugin Priority & Fallback

```typescript
// Plugins are tried in priority order (higher = first)
// If primary fails, fallback plugins are attempted sequentially
// Failed plugins don't block the queue

plugin.priority = 10; // Higher priority
```

### 5. Caching Strategy

| Cache Type      | TTL     | Purpose                     |
| --------------- | ------- | --------------------------- |
| Search cache    | 2 min   | Avoid duplicate API calls   |
| Stream cache    | 5 min   | Cache resolved streams      |
| Extension cache | 1-5 min | Extension operation results |

---

## 📚 API Reference

### PlayerManager

#### Constructor Options

```typescript
interface PlayerManagerOptions {
	plugins?: SourcePlugin[]; // Audio source plugins
	extensions?: BaseExtension[]; // Custom extensions
	extractorTimeout?: number; // Default: 10000ms
	autoCleanup?: boolean; // Default: true
	cleanupInterval?: number; // Default: 60000ms
	enableSearchCache?: boolean; // Default: true
	enableStatsCollection?: boolean; // Default: false
}
```

#### Key Methods

| Method                       | Description                |
| ---------------------------- | -------------------------- |
| `create(guildId, options)`   | Create new player          |
| `get(guildId)`               | Get existing player        |
| `delete(guildId)`            | Destroy and remove player  |
| `getAll()`                   | Get all players            |
| `broadcast(action, ...args)` | Send action to all players |

### Player

#### Core Methods

| Method                         | Description             | Returns             |
| ------------------------------ | ----------------------- | ------------------- |
| `play(query, userId)`          | Play track/search/queue | `Promise<boolean>`  |
| `pause()`                      | Pause current           | `boolean`           |
| `resume()`                     | Resume playback         | `boolean`           |
| `skip(index?)`                 | Skip to next/index      | `boolean`           |
| `stop()`                       | Stop and clear queue    | `boolean`           |
| `seek(position)`               | Seek to position (ms)   | `Promise<boolean>`  |
| `previous()`                   | Play previous track     | `Promise<boolean>`  |
| `setVolume(vol)`               | Set volume (0-200)      | `boolean`           |
| `loop(mode)`                   | Set loop mode           | `LoopMode`          |
| `shuffle()`                    | Shuffle queue           | `void`              |
| `insert(query, index, userId)` | Insert at position      | `Promise<boolean>`  |
| `save(track, options)`         | Save track to stream    | `Promise<Readable>` |

#### Getters

```typescript
player.currentTrack; // Track | null
player.queueSize; // number
player.isPlaying; // boolean
player.isPaused; // boolean
player.volume; // number
player.upcomingTracks; // Track[]
player.previousTracks; // Track[]
player.relatedTracks; // Track[] | null
```

### Queue

#### Methods

| Method                    | Description          |
| ------------------------- | -------------------- |
| `add(track)`              | Add single track     |
| `addMultiple(tracks)`     | Add multiple tracks  |
| `insert(track, index)`    | Insert at position   |
| `remove(index)`           | Remove at index      |
| `removeMultiple(indices)` | Remove multiple      |
| `removeWhere(predicate)`  | Remove by condition  |
| `move(from, to)`          | Move track           |
| `swap(a, b)`              | Swap tracks          |
| `shuffle()`               | Randomize order      |
| `clear()`                 | Clear all tracks     |
| `loop(mode)`              | Set loop mode        |
| `autoPlay(enabled)`       | Enable/disable       |
| `previous()`              | Get previous track   |
| `jumpToHistory(steps)`    | Jump back in history |

#### Properties

```typescript
queue.size; // number
queue.isEmpty; // boolean
queue.currentTrack; // Track | null
queue.nextTrack; // Track | null
queue.lastTrack; // Track | null
queue.previousTracks; // Track[]
```

### FilterManager

```typescript
// Apply filters
await player.filter.applyFilter("bassboost");
await player.filter.applyFilters(["bassboost", "nightcore"]);

// Available filters
// bassboost, trebleboost, nightcore, lofi, vaporwave,
// echo, reverb, chorus, karaoke, normalize, compressor, limiter

// Clear filters
await player.filter.clearAll();
await player.filter.clear("bassboost");

// Get current filters
const filterString = player.filter.getFilterString(); // "bassboost,nightcore"
```

## 🔧 Common Patterns

### 1. Basic Music Bot Setup

```typescript
import { Client, GatewayIntentBits } from "discord.js";
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SpotifyPlugin } from "@ziplayer/plugin";

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const manager = new PlayerManager({
	plugins: [new YouTubePlugin(), new SpotifyPlugin()],
	autoCleanup: true,
});

client.on("ready", async () => {
	// Auto-load saved players
	await manager.loadAllPlayers();
});

client.on("messageCreate", async (msg) => {
	if (msg.content.startsWith("!play")) {
		const player = await manager.create(msg.guildId);
		const voiceChannel = msg.member?.voice.channel;

		if (!player.connection) {
			await player.connect(voiceChannel);
		}

		const query = msg.content.slice(6);
		await player.play(query, msg.author.id);
	}
});
```

### 2. Progress Bar with Time Format

```typescript
// Get formatted time
const time = player.getTime();
console.log(`Current: ${time.formatted.current}`); // "1:22:12"
console.log(`Total: ${time.formatted.total}`); // "3:45:30"

// Progress bar
const progressBar = player.getProgressBar({
	size: 20,
	barChar: "▬",
	progressChar: "🔘",
	timeFormat: "compact",
	showPercentage: true,
});
// Output: "1:22:12 ▬▬▬▬▬▬▬▬▬🔘▬▬▬▬▬▬▬▬ 3:45:30 (36%)"
```

### 3. Queue Management Commands

```typescript
// Skip to specific track
await player.skip(3); // Skip to index 3

// Move track to front
player.queue.move(5, 0);

// Remove all tracks from specific source
player.queue.removeWhere((t) => t.source === "soundcloud");

// Jump back 2 tracks
await player.queue.jumpToHistory(2);

// Insert as next track
await player.insert("song name", 0, userId);
```

### 4. Custom Plugin Implementation

```typescript
import { BasePlugin, Track, StreamInfo } from "ziplayer";

class CustomPlugin extends BasePlugin {
	name = "CustomPlugin";
	priority = 5;

	canHandle(query: string): boolean {
		return query.startsWith("custom:");
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		// Implementation
		return { tracks: [] };
	}

	async getStream(track: Track, signal: AbortSignal): Promise<StreamInfo> {
		// Return audio stream
		return { stream: readableStream, type: "arbitrary" };
	}

	async getRelatedTracks(track: Track): Promise<Track[]> {
		// Return recommendations
		return [];
	}
}
```

### 5. Custom Extension Implementation

```typescript
import { BaseExtension, ExtensionContext } from "ziplayer";

class LoggerExtension extends BaseExtension {
	name = "Logger";
	priority = 10;

	async beforePlay(context: ExtensionContext, request: any) {
		console.log(`Playing: ${request.query}`);
		return { handled: false };
	}

	async afterPlay(context: ExtensionContext, payload: any) {
		if (payload.success) {
			console.log(`Successfully played ${payload.tracks?.length} tracks`);
		}
	}
}
```

### 6. Event Handling

```typescript
manager.on("trackStart", (player, track) => {
	console.log(`Now playing: ${track.title}`);
});

manager.on("queueEnd", (player) => {
	console.log("Queue finished!");
});

manager.on("playerError", (player, error, track) => {
	console.error(`Error on ${track?.title}:`, error.message);
});

manager.on("playerSaved", (guildId) => {
	console.log(`Saved state for guild ${guildId}`);
});

manager.on("stats", (stats) => {
	console.log(`Active players: ${stats.activePlayers}`);
});
```

---

## 🐛 Troubleshooting

### Common Issues

| Issue                    | Solution                                                    |
| ------------------------ | ----------------------------------------------------------- |
| **No audio**             | Check `player.connection` exists, voice channel permissions |
| **Plugin not working**   | Verify `canHandle()` returns true, check priority           |
| **Filters not applying** | Call `refreshPlayerResource(true)` after applying           |
| **Memory leak**          | Enable `autoCleanup`, call `player.destroy()` when done     |
| **Rate limiting**        | Use search cache, increase `extractorTimeout`               |

### Debug Mode

```typescript
// Enable debug logging
manager.on("debug", (message) => {
	console.log("[DEBUG]", message);
});

// Or check debug flag
if (manager.debugEnabled) {
	// Debug-specific logic
}
```

### Performance Tips

1. **Enable caching** for search and stream results
2. **Set appropriate timeouts** based on network conditions
3. **Batch operations** when modifying queue
4. **Destroy players** when no longer needed

---

## 📝 Code Examples

### Full Bot Example

```typescript
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SpotifyPlugin, TTSPlugin } from "@ziplayer/plugin";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const manager = new PlayerManager({
	plugins: [new YouTubePlugin(), new SpotifyPlugin(), new TTSPlugin()],
	autoCleanup: true,
	extractorTimeout: 30000,
});

client.on("messageCreate", async (msg) => {
	if (!msg.guildId || msg.author.bot) return;

	const args = msg.content.slice(1).split(" ");
	const command = args[0].toLowerCase();
	const query = args.slice(1).join(" ");

	const player = await manager.create(msg.guildId);
	const voiceChannel = msg.member?.voice.channel;

	switch (command) {
		case "play":
			if (!voiceChannel) return msg.reply("Join a voice channel!");
			if (!player.connection) await player.connect(voiceChannel);
			await player.play(query, msg.author.id);
			break;

		case "pause":
			player.pause();
			break;

		case "resume":
			player.resume();
			break;

		case "skip":
			player.skip();
			break;

		case "stop":
			player.stop();
			break;

		case "volume":
			const vol = parseInt(query);
			if (isNaN(vol)) return msg.reply("Volume must be a number!");
			player.setVolume(vol);
			break;

		case "queue":
			const tracks = player.upcomingTracks.slice(0, 10);
			const embed = new EmbedBuilder()
				.setTitle("Queue")
				.setDescription(tracks.map((t, i) => `${i + 1}. ${t.title}`).join("\n") || "Empty");
			msg.reply({ embeds: [embed] });
			break;

		case "nowplaying":
			const track = player.currentTrack;
			if (!track) return msg.reply("Nothing playing!");

			const progress = player.getProgressBar({ size: 15 });
			const time = player.getTime();

			const embed = new EmbedBuilder()
				.setTitle(track.title)
				.setURL(track.url)
				.setThumbnail(track.thumbnail)
				.setDescription(`\`${progress}\`\n${time.formatted.current} / ${time.formatted.total}`);
			msg.reply({ embeds: [embed] });
			break;
	}
});

client.login(process.env.DISCORD_TOKEN);
```

---

## 🔗 Quick Reference

### Import Paths

```typescript
// Core
import { PlayerManager, Player, Queue } from "ziplayer";

// Types
import type { Track, SearchResult, LoopMode, StreamInfo } from "ziplayer";

// Plugins (external package)
import { YouTubePlugin, SpotifyPlugin, TTSPlugin } from "@ziplayer/plugin";

// infinity plugin support stream audio from YouTube, TikTok, Instagram, Twitter/X, SoundCloud, Reddit, Twitch, Bilibili, and 1000+ other sites

import { InfinityPlugin } from "@ziplayer/infinity";

// Extensions (external package)
import { voiceExt, lyricsExt, lavalinkExt } from "@ziplayer/extension";
```

### Type Definitions

```typescript
interface Track {
	id: string;
	title: string;
	url: string;
	source: string;
	duration: number;
	thumbnail?: string;
	requestedBy?: string;
	isLive?: boolean;
}

type LoopMode = "off" | "track" | "queue";

interface SearchResult {
	tracks: Track[];
	playlist?: { name: string; url?: string };
}
```

---

## 📖 Additional Resources

- [GitHub Repository](https://github.com/ZiProject/ZiPlayer)
- [npm Package](https://www.npmjs.com/package/ziplayer)
- [Examples Folder](https://github.com/ZiProject/ZiPlayer/tree/main/examples)

---

_This guide is maintained for AI assistants and developers. For questions or contributions, please open an issue on GitHub._
