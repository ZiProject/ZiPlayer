<p align="center">
  <img width="800" alt="ZiPlayer Logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />
</p>

# ZiPlayer

> Next-generation, event-driven, controller-architected audio engine for Discord bots, built on top of `@discordjs/voice`.

[![npm version](https://img.shields.io/npm/v/ziplayer.svg?style=flat-square)](https://www.npmjs.com/package/ziplayer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.3.0-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org)

ZiPlayer is an enterprise-grade Discord music engine. Built around an asynchronous **Global Bus & Distributed Controller**
architecture, it separates business logic into decoupled, testable controllers while exposing a clean, intuitive, and
backwards-compatible `Player` facade.

---

## ✨ Key Features

- 🚌 **Bus & Controller Architecture** — Fully decoupled internal design with synchronized state queries, ordered actions, and
  granular RPC handlers.
- 🔌 **Extensible Plugin Ecosystem** — First-class support for YouTube, SoundCloud, Spotify, TTS, Apple Music, and custom
  extractors.
- 🎛️ **Real-Time FFmpeg Audio Filters** — Live filter switching with zero playback interruption (`bassboost`, `nightcore`, `8D`,
  `vaporwave`, `equalizer`, custom chains).
- 🔁 **Smart Autoplay & Queue Management** — Automatic related-track generation based on history, customizable loop modes (`off`,
  `track`, `queue`), atomic queue insertions, and batch manipulation.
- 🔄 **Anti-Stuck & Resilience 2.0** — Automatic stall recovery, rapid stream retry, preload fallback, and controlled error-skip
  protection to prevent infinite loops.
- 🧠 **Smart Transitions & Crossfade** — BPM/genre-aware crossfade (long smooth fades for ambient/chill, punchy fades for
  EDM/rock) with beat-alignment capabilities.
- 🔊 **LUFS Loudness Normalization** — EBU R128 loudness normalization and soft-knee peak limiting to prevent jarring volume jumps
  between tracks.
- 📻 **Playback Mirror / Forward Mode** — Zero-overhead multi-guild broadcasting where follower guilds subscribe directly to a
  leader's audio stream without re-downloading or re-encoding.
- 💾 **Session Serialization & State Recovery** — Export and restore full player states across bot restarts (queue, position,
  volume, active filters, loop mode).
- ⚡ **High Performance & Auto-Scaling** — Low-performance mode automatically disables memory-heavy features (preload, crossfade)
  on constrained host environments.

---

## 📦 Installation

```bash
# Using npm
npm install ziplayer @discordjs/voice discord.js

# Recommended audio dependencies
npm install @discordjs/opus ffmpeg-static

# Recommended plugin
npm install @ziplayer/plugin @ziplayer/infinity
```

> **Note**: An Opus encoder library (e.g. `@discordjs/opus` or `opusscript`) and an FFmpeg binary in your environment (or
> `ffmpeg-static`) are required for audio encoding and real-time filtering.

---

## 🚀 Quick Start

Here is a minimal, production-ready Discord.js bot using ZiPlayer:

```typescript
import { Client, GatewayIntentBits } from "discord.js";
import { PlayerManager } from "ziplayer";
// Official plugins can be imported from @ziplayer/plugin
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin, AttachmentsPlugin } from "@ziplayer/plugin";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// Initialize the global PlayerManager
const manager = new PlayerManager({
	plugins: [
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
		new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }), //25mb
	],
	autoCleanup: true,
	enableSearchCache: true,
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guildId) return;

	if (message.content.startsWith("!play ")) {
		const voiceChannel = message.member?.voice?.channel;
		if (!voiceChannel) {
			return message.reply("Please join a voice channel first!");
		}

		const query = message.content.slice(6).trim();

		// Create or retrieve player for this guild
		const player = await manager.create(message.guildId, {
			leaveOnEnd: true,
			leaveOnEmpty: true,
			volume: 80,
			userdata: { textChannelId: message.channelId },
		});

		// Connect to voice if not already connected
		if (!player.connection) {
			await player.connect(voiceChannel);
		}

		// Play query (URL, search term, or Track)
		await player.play(query, message.author.id);
		message.reply(`🔍 Queued: **${query}**`);
	}
});

// Global Event Listeners
manager.on("trackStart", (player, track) => {
	console.log(`[${player.guildId}] Now Playing: ${track.title}`);
});

manager.on("queueEnd", (player) => {
	console.log(`[${player.guildId}] Queue finished.`);
});

manager.on("playerError", (player, error, track) => {
	console.error(`[${player.guildId}] Playback error on ${track?.title}:`, error);
});

client.login(process.env.DISCORD_TOKEN);
```

---

## 🧱 Architecture Overview

ZiPlayer separates high-level facade controls from low-level audio and state handling using an asynchronous message bus:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             PlayerManager                                        │
│              (Process-wide lifecycle, pooling & broadcast)                       │
└──────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Player Bus                                          │
│       (RPC Handlers, Synchronous Queries, Actions & Event Streams)               │
├──────────────────────────────────────────────────────────────────────────────────┤
│  • ConnectionController       • QueueController        • FilterController        │
│  • PlaybackPlayController     • PlaybackStartController • PlaybackSkipController │
│  • PlaybackSeekController     • TrackLoader / Preload  • AntiStuckController     │
│  • TransitionController       • VolumeController       • ForwardController       │
│  • SearchController           • LifecycleController    • PlayerEventBridge       │
└──────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                 Player                                           │
│                  (Ergonomic, per-guild object API)                               │
│   player.play()  •  player.queue  •  player.filter  •  player.seek()             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **`PlayerManager`**: Manages all guild instances, process-wide controller registration, health monitoring, and broadcast
  controls.
- **`Bus`**: Single message highway orchestrating queries, actions, RPCs, and event publishing without tight coupling between
  components.
- **`Controllers`**: Independent domain owners (Queue, AudioPlayer, FFmpeg filters, Preload, Transitions) holding isolated state.
- **`Player`**: A clean facade for your bot code that delegates internally to the Bus.

---

## 🎵 Core Usage & Controls

### Playback Operations

```typescript
// Play from search query, URL, SearchResult, or resume queue
await player.play("Never Gonna Give You Up", message.author.id);
await player.play("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
await player.play("tts:Hello world! Welcome to the voice channel");
await player.play(null); // Resume from queue if idle

// Controls (All state transitions return a boolean indicating success)
player.pause(); // Returns false if already paused or not playing
player.resume(); // Returns false if not paused
player.skip(); // Skips to next track
player.skip(3); // Skips directly to track at queue index 3
player.stop(); // Stops playback and clears the queue
await player.seek(45000); // Seek to 45 seconds (45,000 ms)
await player.previous(); // Return to previous track in history
player.setVolume(120); // Volume supported from 0% up to 200%
```

### Queue Management

The `player.queue` object provides rich queue operations:

```typescript
// Inspection
console.log(player.queue.size); // Number of upcoming tracks
console.log(player.queue.isEmpty); // Boolean
console.log(player.queue.currentTrack); // Currently playing track
console.log(player.queue.nextTrack); // Next track in line
console.log(player.queue.previousTracks); // History of played tracks

// Adding & Inserting
player.queue.add(track);
player.queue.addMultiple([track1, track2]);
await player.insert(track, 0); // Insert track at the top (play next)
await player.insert("query string", 2); // Searches and inserts at index 2

// Removing & Reordering
player.queue.remove(0); // Removes and returns track at index 0
player.queue.removeMultiple([1, 3, 5]); // Batch removal by indices
player.queue.removeWhere((t) => t.duration > 600000); // Filter removal
player.queue.move(3, 0); // Move track at index 3 to front
player.queue.swap(1, 2); // Swap positions 1 and 2
player.queue.shuffle(); // Shuffle remaining tracks
player.queue.clear(); // Clear upcoming tracks
```

### Looping & Autoplay

```typescript
// Set loop mode: "off" | "track" | "queue" (or numeric: 0 | 1 | 2)
player.loop("track"); // Loops current song
player.loop("queue"); // Cycles entire queue
player.loop("off"); // Standard progression

// Enable automatic recommendation of related songs when queue ends
player.autoPlay(true);
```

---

## 🎛️ Audio Filters

ZiPlayer features dynamic FFmpeg filter chains executed in real-time. Filters can be stacked and modified on the fly:

```typescript
// Apply predefined filters
await player.filter.applyFilter("bassboost");
await player.filter.applyFilter("nightcore");

// Apply multiple filters in batch
await player.filter.applyFilters(["bassboost", "8D", "vaporwave"]);

// Inspect current filter string
console.log(player.filter.getFilterString()); // "bassboost,8D,vaporwave"

// Remove a filter or clear all
await player.filter.removeFilter("bassboost");
await player.filter.clearFilters(); // or player.filter.clearAll()
```

### Built-in Filters

| Filter Name                    | Description                      |
| ------------------------------ | -------------------------------- |
| `bassboost` / `bassboost_high` | Low-frequency amplification      |
| `8D`                           | Spatial rotating stereo panning  |
| `nightcore`                    | Increased pitch and tempo        |
| `vaporwave`                    | Decreased pitch and slowed tempo |
| `lofi`                         | Lowpass analog tape warmth       |
| `echo` / `reverb`              | Acoustic space emulation         |
| `karaoke`                      | Voice center-channel suppression |
| `trebleboost`                  | High-frequency clarity           |
| `compressor` / `limiter`       | Dynamic range control            |

---

## 🧠 Smart Transitions & Crossfade

ZiPlayer provides intelligent crossfading between tracks:

- **Genre-Aware Duration**: Automatically lengthens crossfades for ambient/chill tracks and shortens them for fast-paced genres.
- **Beat Alignment**: Detects tempo (`track.metadata.bpm`) and synchronizes the entry of the next track on beat boundaries.
- **Fade Out on Skip**: Calling `player.skip()` executes a smooth fadeout rather than an abrupt audio cut.

```typescript
const player = await manager.create(guildId, {
	crossfade: {
		enabled: true,
		durationMs: 4000,
		autoDisableInLowPerformance: true,
	},
	smartTransition: {
		enabled: true,
		genreAware: true,
		beatAlign: true,
		genreDurations: { chill: 6000, edm: 2000, rock: 2500 },
	},
});
```

---

## 📻 Multi-Guild Forward Mode (Stream Mirroring)

Broadcast one stream across multiple guilds simultaneously with **zero duplicate bandwidth or decoding overhead**:

```typescript
// Guild A is playing music
const leader = manager.get("guild-A");
const follower = manager.get("guild-B");

// Follower subscribes directly to leader's AudioPlayer
follower.subscribeTo(leader);

// Follower automatically mirrors trackStart, trackEnd, pause, resume, and volume!
// Follower mutations are guarded to prevent disrupting the leader.

// To stop mirroring:
follower.unsubscribeForward();
```

---

## 💾 Session Persistence & State Restoration

Save and restore active players across bot restarts or server migrations:

```typescript
// Save serializable session state
const sessionData = player.saveSession();
// Store sessionData in Redis, MongoDB, SQLite, etc.
await db.set(`session:${player.guildId}`, JSON.stringify(sessionData));

// After restart: recreate player and restore state
const savedState = JSON.parse(await db.get(`session:${guildId}`));
const newPlayer = await manager.create(guildId);
await newPlayer.connect(voiceChannel);

const success = await newPlayer.restoreState(savedState);
if (success) {
	console.log("Player state (queue, volume, filters, loop) restored successfully!");
}
```

---

## 📡 Events Reference

Both `PlayerManager` and `Player` emit typed events. `PlayerManager` emits the originating `player` instance as the first
argument.

| Event              | Arguments                  | Description                                         |
| ------------------ | -------------------------- | --------------------------------------------------- |
| `trackStart`       | `(player, track)`          | Emitted when a track starts playing                 |
| `trackEnd`         | `(player, track)`          | Emitted when a track finishes playing               |
| `queueEnd`         | `(player)`                 | Emitted when the queue is completely exhausted      |
| `queueAdd`         | `(player, track)`          | A single track was added to the queue               |
| `queueAddList`     | `(player, tracks)`         | Multiple tracks were appended to the queue          |
| `queueRemove`      | `(player, track, index)`   | A track was removed from the queue                  |
| `playerPause`      | `(player, track)`          | Playback was paused                                 |
| `playerResume`     | `(player, track)`          | Playback was resumed                                |
| `playerStop`       | `(player)`                 | Player stopped and queue was cleared                |
| `playerError`      | `(player, error, track)`   | Playback or stream resolution encountered an error  |
| `volumeChange`     | `(player, oldVol, newVol)` | Player volume was modified                          |
| `filterApplied`    | `(player, filter)`         | An audio filter was activated                       |
| `filterRemoved`    | `(player, filter)`         | An audio filter was removed                         |
| `filtersCleared`   | `(player)`                 | All active audio filters were cleared               |
| `forwardModeStart` | `(player, leader)`         | Player entered forward mode subscribing to a leader |
| `forwardModeEnd`   | `(player, leader, reason)` | Player exited forward mode                          |
| `playerDestroy`    | `(player)`                 | Player instance was destroyed and detached          |

---

## ⚙️ Configuration Reference

### PlayerOptions

Passed to `manager.create(guildId, options)`:

```typescript
interface PlayerOptions {
	volume?: number; // Initial volume (0 - 200, default: 100)
	quality?: "low" | "medium" | "high"; // Stream quality preset
	leaveOnEnd?: boolean; // Leave voice when queue ends (default: true)
	leaveOnEmpty?: boolean; // Leave voice when voice channel is empty
	pauseOnEmpty?: boolean; // Pause when voice channel is empty and resume when a user returns (default: false)
	leaveTimeout?: number; // Inactivity timeout in ms before leave (default: 100000; 0 to disable)
	selfDeaf?: boolean; // Join deafened (default: true)
	selfMute?: boolean; // Join muted (default: false)
	lowPerformance?: boolean; // Low performance mode (disables preload/crossfade)
	filters?: string[]; // Initial audio filters to apply
	preload?: {
		enabled?: boolean; // Auto-preload upcoming track (default: true)
		autoDisableInLowPerformance?: boolean;
	};
	crossfade?: {
		enabled?: boolean;
		durationMs?: number; // Crossfade duration in ms (default: 1000)
		autoEnable?: boolean;
		autoDisableInLowPerformance?: boolean;
	};
	antiStuck?: {
		enabled?: boolean; // Enable stall recovery watchdog
		stuckTimeoutMs?: number; // Buffer stall threshold (default: 10000)
		controlledSkipThreshold?: number; // Consecutive error threshold (default: 3)
	};
	loudnessNormalization?: {
		enabled?: boolean;
		targetLUFS?: number; // Target LUFS (default: -14)
		maxBoostDb?: number; // Maximum boost in dB (default: 8)
		maxCutDb?: number; // Maximum cut in dB (default: 10)
		limiterCeiling?: number; // Peak ceiling (default: 0.95)
	};
	userdata?: Record<string, any>; // Arbitrary custom metadata
}
```

---

## 📚 Advanced Developer Guide

For contributors, custom controller authors, and AI agent instructions detailing internal Bus protocols, controller state
ownership, and teardown lifecycle, see [**AGENTS.md**](./AGENTS.md).

---

## 📄 License

MIT © [ZiProject](https://github.com/ZiProject)
