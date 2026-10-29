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
- 🎛️ Shared Discord and browser playback through the `AudioPlayer` Opus subscriber path

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

## 🌐 Browser Playback with `@ziplayer/client`

Browser playback uses `WebAudioConnection` to subscribe to the shared `AudioPlayer` and publish Opus packets. It can fan out the
same server-volume-adjusted Opus packets as Discord Voice. The WebSocket gateway is application-provided; ZiPlayer does not create
or host it.

Install the browser receiver separately:

```bash
npm install @ziplayer/client
```

Connect a WebAudio subscriber to a regular player. Keep the player ID as the connection's `sessionId` so listeners can stay
subscribed across track changes:

```ts
import { PlayerManager, WebAudioConnection } from "ziplayer";

const manager = new PlayerManager();
const playerId = "web-player";
const player = await manager.create(playerId);
const webConnection = new WebAudioConnection({ sessionId: playerId });
webConnection.attachSocket(await connectPublisherSocket({ sessionId: playerId, gatewayUrl, token }));
const browserOutput = await player.connect(webConnection);

await player.play(query, userId);
// Disconnect only the browser output when it is no longer needed.
await browserOutput.disconnect();
```

`connectPublisherSocket` is application/gateway-specific and must resolve to an open WebSocket; authenticate the publisher on the
server. For the included local gateway, a minimal Node.js helper using `ws` is:

```sh
npm install ws
```

```ts
import { WebSocket } from "ws";

function connectPublisherSocket({ gatewayUrl, sessionId }: { gatewayUrl: string; sessionId: string }): Promise<WebSocket> {
	const url = new URL("/publish", gatewayUrl);
	url.searchParams.set("sessionId", sessionId);
	const socket = new WebSocket(url);

	return new Promise<WebSocket>((resolve, reject) => {
		const onError = (error: Error) => {
			socket.off("open", onOpen);
			socket.terminate();
			reject(error);
		};
		const onOpen = () => {
			socket.off("error", onError);
			socket.on("error", (error: Error) => {
				console.error("Publisher socket error:", error);
				socket.close(1011, "Publisher transport error");
			});
			resolve(socket);
		};
		socket.once("error", onError);
		socket.once("open", onOpen);
	});
}
```

This example assumes the gateway's `/publish` endpoint and no authentication; adapt the URL and auth handshake for your gateway.
In the browser, import `WebAudioClient` from `@ziplayer/client` and call `connect()` from a user gesture. For a newly starting
stream, connect with `nextPublisher: true` before requesting playback so the listener is ready before the first Opus frames
arrive. The client validates the protocol, decodes Opus, and plays it through a bounded AudioWorklet buffer.

### Minimal browser client (Vite)

The browser package receives and plays audio; it does not start or control a ZiPlayer. Point it at an application gateway that
implements the `/listen` WebSocket endpoint and is already publishing the selected player's stream. Start a vanilla Vite app and
install the client:

```sh
npm create vite@latest ziplayer-web -- --template vanilla
cd ziplayer-web
npm install
npm install @ziplayer/client
npm run dev
```

Replace `index.html` with a small page containing the gateway URL and the exact player ID used by `WebAudioConnection`:

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta
			name="viewport"
			content="width=device-width, initial-scale=1.0" />
		<title>ZiPlayer listener</title>
	</head>
	<body>
		<label>
			Gateway WebSocket URL
			<input
				id="gateway"
				value="ws://127.0.0.1:8080" />
		</label>
		<label>
			Player ID
			<input
				id="session"
				value="web-audio-demo" />
		</label>
		<label>
			Token (if required by your gateway)
			<input
				id="token"
				type="password"
				autocomplete="off" />
		</label>
		<button id="connect">Listen</button>
		<button
			id="disconnect"
			disabled>
			Disconnect
		</button>
		<p id="status">Disconnected</p>
		<script
			type="module"
			src="/src/main.js"></script>
	</body>
</html>
```

Replace `src/main.js` with:

```js
import { WebAudioClient } from "@ziplayer/client";

const client = new WebAudioClient();
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const status = document.querySelector("#status");

client.addEventListener("config", ({ detail }) => {
	status.textContent = `Receiving audio from: ${detail.sessionId}`;
});
client.addEventListener("error", ({ detail }) => {
	status.textContent = `Audio error: ${detail.error.message}`;
	console.error("ZiPlayer client error:", detail.error);
});
client.addEventListener("close", ({ detail }) => {
	status.textContent = `Connection closed (${detail.code})`;
});

connectButton.addEventListener("click", async () => {
	connectButton.disabled = true;
	status.textContent = "Connecting…";
	try {
		const token = document.querySelector("#token").value.trim();
		await client.connect({
			gatewayUrl: document.querySelector("#gateway").value.trim(),
			sessionId: document.querySelector("#session").value.trim(),
			...(token ? { token } : {}),
		});
		disconnectButton.disabled = false;
		status.textContent = "Connected; waiting for audio…";
	} catch (error) {
		status.textContent = `Could not connect: ${error.message}`;
		connectButton.disabled = false;
	}
});

disconnectButton.addEventListener("click", async () => {
	await client.disconnect();
	connectButton.disabled = false;
	disconnectButton.disabled = true;
	status.textContent = "Disconnected";
});
```

Run the gateway separately and make sure its publisher uses the same player ID. To try the included local gateway and publisher,
follow the [Web Audio quick start](../examples/backend/README.md), start playback there, and then open the Vite URL and click
**Listen**. The gateway URL is the WebSocket origin (for example `ws://127.0.0.1:8080`); the client appends `/listen`. To listen
before a new publisher starts, use `nextPublisher: true` instead of `sessionId`, then start playback through your application API
after the WebSocket connects. Supply a short-lived token only if the gateway requires one. Serve the page over HTTPS when
connecting to a non-local `wss://` gateway.

### Shared Discord and browser playback with server-side volume

For simultaneous Discord and browser playback, attach `WebAudioConnection` to the player's `AudioPlayer`:

```ts
import { WebAudioConnection } from "ziplayer";

const player = await manager.create(guildId);
const voiceConnection = await player.connect(voiceChannel);
const webConnection = new WebAudioConnection({ sessionId: player.id });
webConnection.attachSocket(await connectPublisherSocket({ sessionId: player.id }));
const webOutput = await player.connect(webConnection);

await player.play(query, { requestedBy: userId });
player.setVolume(65); // server-side player volume, shared by Discord and browser listeners
// Call webOutput.disconnect() when the browser output is no longer needed.
```

The source `Readable` is wrapped in a Discord `AudioResource` with inline volume, then played by the shared Discord `AudioPlayer`.
The player emits Opus packets to both subscribers: `DiscordVoiceConnection` sends them through the Discord Voice protocol, while
`WebAudioConnection` adds the ZI v1 frame header and publishes them over WebSocket. The gateway relays those Opus frames to the
browser for local decoding and playback. `player.setVolume()` changes the shared server-side resource before the fan-out, so the
updated audio is heard by both outputs. It is not a per-browser volume control.

Inline volume is applied to the shared `AudioResource` before Opus packets are distributed. This in-process codec step does not
require FFmpeg; both subscribers receive the same post-volume Opus packets. Passing an `AudioResource` created externally may
bypass ZiPlayer's inline-volume resource setup.

For a complete runnable gateway, player session, and browser UI example, see
[`examples/backend`](https://github.com/ZiProject/ZiPlayer/tree/main/examples/backend/README.md). For client events, options, and
browser requirements, see [`@ziplayer/client` documentation](https://github.com/ZiProject/ZiPlayer/tree/main/client/README.md).

---

## Singleton Access

ZiPlayer exposes a process-wide manager singleton. Create `PlayerManager` once during application startup so it registers the
singleton, then use `getManager()` and `getPlayer(guildId)` from command handlers and other modules. Do not create a manager per
guild/command or attach it to the Discord client just to share it.

```ts
import { PlayerManager, getManager, getPlayer } from "ziplayer";

// Application bootstrap: configure plugins and options once.
new PlayerManager({ plugins, autoCleanup: true });

// In a command or another module:
const manager = getManager(); // PlayerManager | null
if (!manager) throw new Error("ZiPlayer has not been initialized");

let player = getPlayer(guildId); // Player | undefined; lookup only, does not create
if (!player) {
	player = await manager.create(guildId, playerOptions);
}
```

`getManager()` returns `null` until a manager has been constructed. `getPlayer(guildId)` returns `undefined` until that guild's
player has been created; use `manager.create()` to create it. Keep the single manager initialization in the bot's startup path,
and use the helpers wherever code needs to retrieve the shared instances.

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

## Shared Discord and WebAudio playback

`Player.connect(voiceChannel)` joins Discord Voice. A browser publisher can subscribe to the same `AudioPlayer`:

```ts
const webConnection = new WebAudioConnection({ sessionId: player.id });
webConnection.attachSocket(publisherSocket);
const subscription = await player.connect(webConnection);
await subscription.disconnect(); // Discord playback continues
```

The source `Readable` is wrapped in an inline-volume Discord `AudioResource` and played once through the shared `@discordjs/voice`
`AudioPlayer`. The player applies volume and fans out Opus packets directly to the Discord Voice and `WebAudioConnection`
subscribers. Remove a browser subscriber by its registration handle or with `player.disconnectWebAudio(id)`. Generic stream-output
backends and output factories are not part of the player API. The shared `ConnectionController` owns each player's voice and
WebAudio connection state; `Player` delegates WebAudio registration, lookup, and teardown through the Bus. `player.connections`
(also exposed through `PLAYER_QUERY.connection`) returns all currently subscribed Voice and WebAudio connections; each WebAudio
connection can be removed through its registration handle or destroyed during player teardown.
