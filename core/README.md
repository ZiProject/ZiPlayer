<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />

# ZiPlayer

A powerful, extensible Discord music engine built on top of `@discordjs/voice`, designed for scalability, flexibility, and
developer experience.

ZiPlayer is not just a player — it's a **full ecosystem** with plugins, extensions, and a modular architecture that lets you build
advanced music bots quickly.

---

## ✨ Highlights

- 🔌 **Plugin-driven architecture** — Easily support new audio sources
- 🌐 **Multi-source playback** — YouTube, SoundCloud, Spotify (with fallback), TTS, and more
- 🧠 **Smart fallback system** — Automatically resolves streams across plugins
- 🎛️ **Advanced audio filters** — Real-time FFmpeg effects (bassboost, nightcore, etc.)
- 🔁 **Autoplay & looping** — Seamless listening experience
- 🧩 **Extension system** — Add STT, lyrics, Lavalink, and custom logic
- 🗂️ **Per-guild player system** — Scales across multiple Discord servers
- 📡 **Event-driven core** — Full lifecycle hooks for customization
- 💾 **Custom userdata** — Attach context to each player
- ⚡ **Smart caching** — Search and stream caching for better performance
- 🎯 **Queue management** — Advanced queue operations (move, swap, batch remove)
- 💹 **Preload** - Auto Preload next Track
- 🔃 **Crossfade** - Suport crossfade for new/slip Track
- 🧠 **Transition Engine** - BPM/genre-aware crossfade (chill → long fade, EDM → short fade) with beat-aligned entry instead of
  blind time-based fading
- 🔄 **Anti-Stuck Recovery 2.0** - Automatic stream failure recovery: reuse preload → fallback plugin → reduce quality →
  controlled skip (no chaotic skipping)
- 🔊 **Loudness Normalization** - LUFS-based normalization prevents sudden volume jumps between tracks, with gentle limiter to
  avoid distortion
- 🧪 **Track middleware (extensions)** — Transform or enrich tracks before streaming (for example fill `metadata.bpm`,
  `metadata.lufs`, `metadata.genre` from an audio-analysis HTTP API instead of manual entry)
- 📻 **Multi-guild broadcast** — Fan out the same Player API calls to every active guild with `manager.broadcast()` (shared
  controls / mirrored sessions across servers)
- 🎛️ **Playback Mirror / Forward Mode** - "forward mode", where the follower player directly subscribes to the leader player's
  instead of creating its own stream.

---

## 📦 Installation

```bash
npm install ziplayer @ziplayer/plugin @ziplayer/extension @ziplayer/infinity @discordjs/voice discord.js opusscript
```

---

## 🚀 Quick Start

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin } from "@ziplayer/plugin";
import { InfinityPlugin } from "@ziplayer/infinity";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const manager = new PlayerManager({
	plugins: [new YouTubePlugin(), new SoundCloudPlugin(), new SpotifyPlugin(), new InfinityPlugin()],
});

client.on("messageCreate", async (msg) => {
	if (!msg.content.startsWith("!play ") || !msg.guildId) return;

	const voiceChannel = msg.member?.voice?.channel;
	if (!voiceChannel) return msg.reply("Join a voice channel first!");

	const player = await manager.create(msg.guildId, {
		leaveOnEnd: true,
		userdata: { channel: msg.channel },
	});

	if (!player.connection) await player.connect(voiceChannel);
	await player.play(msg.content.slice(6), msg.author.id);
});

client.login(process.env.DISCORD_TOKEN);
```

---

## 🧱 Architecture Overview

```
PlayerManager (global)
  └── Player (per guild)
        ├── Queue (advanced operations)
        ├── PluginManager (with caching & fallback)
        ├── ExtensionManager (with priority & caching)
		├── StreamManager (Store & Manage streams)
        ├── PreloadManager (Preload next tracks)
        └── FilterManager (FFmpeg filters)

```

---

## 🎵 Core Usage

### Play music

```ts
await player.play("Never Gonna Give You Up", userId);
await player.play("https://youtube.com/watch?v=...", userId);
await player.play("tts: Hello world", userId);
await player.play(searchResult, userId); // Play from SearchResult
await player.play(null); // Resume from queue
```

### Controls

```ts
player.pause();
player.resume();
player.skip();
player.skip(2); // Skip to track at index 2
player.stop();
player.setVolume(100);
player.loop("track"); // Loop current track
player.loop("queue"); // Loop entire queue
player.loop(1); // Number mode: 0=off, 1=track, 2=queue
player.shuffle();
player.seek(30000); // Seek to 30 seconds
player.previous(); // Go back to previous track
```

### Queue Management

```ts
// Basic operations
player.queue.add(track);
player.queue.addMultiple([track1, track2]);
player.queue.remove(0);
player.queue.removeMultiple([0, 2, 5]); // Remove multiple indices
player.queue.removeWhere((t) => t.source === "youtube"); // Remove by condition
player.queue.clear();

// Queue manipulation
player.queue.move(3, 0); // Move track at index 3 to front
player.queue.swap(1, 3); // Swap positions 1 and 3
player.queue.shuffle();

// Queue inspection
player.queue.size;
player.queue.isEmpty;
player.queue.currentTrack;
player.queue.nextTrack;
player.queue.lastTrack;
player.queue.previousTracks;
player.queue.getTrack(5);
player.queue.findTracks((t) => t.duration > 300000);
player.queue.indexOf(track);
player.queue.has(track);

// History navigation
player.queue.jumpToHistory(2); // Go back 2 tracks
```

---

## 🔌 Plugins

Install via `@ziplayer/plugin`:

- **YouTubePlugin** — YouTube + search
- **SoundCloudPlugin** — SoundCloud streaming
- **SpotifyPlugin** — Metadata (uses fallback)
- **TTSPlugin** — Text-to-speech
- **AttachmentsPlugin** — Local/URL audio files

### Example

```ts
import { TTSPlugin } from "@ziplayer/plugin";

new PlayerManager({
	plugins: [new TTSPlugin({ defaultLang: "en" })],
});
```

### Dynamic Plugin Registration

```ts
// Register plugin after initialization
manager.registerPlugin(new YouTubePlugin());

// Get all registered plugins
const plugins = manager.getPlugins();
```

---

## 🧩 Extensions

Enhance player behavior:

- 🎤 `voiceExt` — Speech-to-text commands
- 🎤 `lyricsExt` — Auto lyrics (synced support)
- ⚡ `lavalinkExt` — External Lavalink node

### Example

```ts
import { voiceExt, lyricsExt } from "@ziplayer/extension";

const manager = new PlayerManager({
	extensions: [new voiceExt(null, { lang: "en-US" }), new lyricsExt(null, { provider: "lrclib" })],
});
```

### Extension Capabilities

Extensions can now provide:

- **Search** — Custom search handling
- **Stream** — Custom stream sources (Lavalink, etc.)
- **Before/After play hooks** — Modify playback behavior

### Track middleware (metadata before stream)

Core exposes **`trackMiddleware`** on **`PlayerManager`** options and **`Player`** options: an ordered chain of async/sync
functions `(track, { player, manager }) => void | Track`. They run **once per stream resolution**, immediately before extension
`provideStream` and plugins — including preload and `player.save()`.

Prefer mutating **`track.metadata`** in place. If you return a **new** object, its enumerable fields (and merged `metadata`) are
copied onto the original track reference so queue/current-track pointers stay stable.

```ts
const manager = new PlayerManager({
	plugins: [...],
	trackMiddleware: async (track, { player }) => {
		const analysis = await fetchAnalysis(track.url); // your HTTP API
		track.metadata = {
			...track.metadata,
			bpm: analysis.bpm,
			lufs: analysis.lufs,
			genre: analysis.genre,
		};
	},
});

// Per-player middleware runs after manager-level middleware
await manager.create(guildId, {
	trackMiddleware: [(track) => {
		track.metadata = { ...track.metadata, sourcePreset: "guild-radio" };
	}],
});
```

Extensions remain useful for **`beforePlay`** (rewrite query / inject tracks before search) and **`provideStream`** (custom
backends):

1. **`beforePlay`** (capability `beforePlay`) runs inside `player.play()` before search resolution. You can:
   - Adjust `payload.query` when it is a string (rewrite query) or a **`Track`** (mutate the object, including `track.metadata`).
   - Return **`tracks`** to inject or replace the list of tracks (with enriched metadata).
   - Set **`handled: true`** to short-circuit normal handling when you fully control the outcome.

2. **`provideStream`** (capability `stream`) runs **after** track middleware and **before** plugin extraction in
   `Player.getStream()`. Use it to supply a stream from Lavalink or another backend while still using plugins for search.

Core features read optional **`Track.metadata`** fields:

| Key (in `track.metadata`) | Used by                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `bpm`                     | Smart transition beat alignment (`smartTransition.beatAlign`)              |
| `genre`                   | Genre-aware fade duration (`smartTransition.genreAware`, `genreDurations`) |
| `lufs`                    | Loudness normalization (`loudnessNormalization`)                           |

Example sketch (extension path): in `beforePlay`, if `payload.query` is a `Track`, call your analysis service (or cache), then
assign `track.metadata = { ...track.metadata, bpm, lufs, genre }` before returning.

---

## 🎛️ Audio Filters

Apply FFmpeg filters in real-time:

```ts
await player.filter.applyFilter("bassboost");
await player.filter.applyFilter("nightcore");
await player.filter.applyFilters(["bassboost", "trebleboost"]); // Multiple filters
await player.filter.getFilterString(); // "bassboost,trebleboost"
await player.filter.clearAll();
```

### Available filters

- bassboost, trebleboost
- nightcore, lofi, vaporwave
- echo, reverb, chorus
- karaoke
- normalize, compressor, limiter

---

## 🔊 TTS (Interrupt Mode)

```ts
const player = await manager.create(guildId, {
	tts: {
		createPlayer: true,
		interrupt: true,
		volume: 100,
		maxTimeTts: 60000,
	},
});

await player.play("tts: Hello everyone", userId);
```

---

## 📡 Events

Listen globally via manager:

```ts
manager.on("trackStart", (player, track) => {});
manager.on("trackEnd", (player, track) => {});
manager.on("queueEnd", (player) => {});
manager.on("playerError", (player, error, track) => {});
manager.on("playerPause", (player, track) => {});
manager.on("playerResume", (player, track) => {});
manager.on("volumeChange", (player, oldVolume, newVolume) => {});
manager.on("queueAdd", (player, track) => {});
manager.on("queueAddList", (player, tracks) => {});
manager.on("queueRemove", (player, track, index) => {});
manager.on("playerDestroy", (player) => {});
manager.on("ttsStart", (player, payload) => {});
manager.on("ttsEnd", (player) => {});
manager.on("stats", (PlayerStats) => {});
manager.on("forwardModeStart", (player, leader) => {});
manager.on("forwardModeEnd", (player, leader) => {});
```

---

## 🧠 Advanced Features

### Autoplay

```ts
player.queue.autoPlay(true);
```

### Insert next track

```ts
await player.insert("song", 0); // Insert at position 0 (play next)
await player.insert([track1, track2], 2); // Insert multiple at index 2
```

### Save stream to file

```ts
const stream = await player.save(track);
stream.pipe(fs.createWriteStream("song.mp3"));

// Save with filters
const filteredStream = await player.save(track, {
	filter: ["bassboost"],
	seek: 30000, // Start from 30 seconds
});
```

### Progress Bar

```ts
// Default (compact time format)
console.log(player.getProgressBar());
// Output: "1:22:12 ▬▬▬▬▬▬▬▬▬▬🔘▬▬▬▬▬▬▬▬ 1:45:30"

// Custom options
console.log(
	player.getProgressBar({
		size: 30,
		barChar: "─",
		progressChar: "●",
		timeFormat: "full", // "full" or "compact"
		showPercentage: true,
	}),
);
// Output: "01:22:12 ───────●───────────────────── 01:45:30 (47%)"
```

### Time Formatting

```ts
const time = player.getTime();
console.log(time.formatted.current); // "1:22:12" (compact)
console.log(time.format); // "01:22:12" (full with leading zeros)
```

### Batch Operations

```ts
// Broadcast action to all players
manager.broadcast("setVolume", 50);
manager.broadcast("pause");

// Get players by filter
const activePlayers = manager.getPlayersByFilter((p) => p.isPlaying);

// Delete multiple players
manager.deleteWhere((p) => p.queue.isEmpty && !p.isPlaying);
```

### Multi-room / multi-guild broadcast

`PlayerManager.broadcast(action, ...args)` loops every registered **`Player`** and, if `player[action]` is a function, calls
`player[action](...args)`. It is a **control fan-out**: the same method name runs on all guild players (pause, volume, skip,etc.).
It does **not** multiplex one Discord voice stream to many guilds—each guild still has its own voice connection and decoder.

Use **`broadcastAsync`** when you need to await async methods (for example `play`):

```ts
const results = await manager.broadcastAsync("play", "https://youtu.be/...", botUserId);
```

Use **`broadcastGuilds`** to target a subset of guild ids:

```ts
manager.broadcastGuilds(["guildA", "guildB"], "pause");
```

**“Subscribe” pattern (manual):**

1. Call `await manager.create(guildId, options)` (and `player.connect(voiceChannel)`) for **each** guild that should participate
   so each server has a player instance.
2. Drive playback from your bot logic: mirror API above, or issue the same `play` / queue commands per guild, or use `broadcast`
   for **synchronized controls** only.
3. Plain `broadcast` is **synchronous** and does not `await` async methods. Prefer `broadcastAsync` or a `for` loop with `await`
   when order/errors matter.

```ts
// Same control on every guild that already has a player
manager.broadcast("pause");
manager.broadcast("setVolume", 75);

// Prefer explicit awaits if you need ordered or error-handled play on many guilds
for (const player of manager.getAll()) {
	await player.play(sharedQueueUrl, botUserId).catch(console.error);
}
```

### Playback Mirror / Forward Mode

Ziplayer supports built-in multi-guild playback mirroring using shared audio forwarding. A leader player streams audio normally,
while followers directly subscribe to the leader's internal audioPlayer.

This allows multiple guilds to hear the exact same playback while using only:

- one stream
- one decoder
- one extractor pipeline

Resulting in extremely low CPU and bandwidth usage.

```ts
const stopMirror = manager.subscribeForwardMirror({
	leaderGuildId: "123",
	followerGuildIds: ["456", "789"],
	mirrorUserId: client.user.id,
	syncVolume: true,
	forwardMode: true,
});

// later
stopMirror();
```

**Direct Player Subscription:**

Followers may also subscribe manually:

````ts
const leader = manager.get("123");
const follower = manager.get("456");

follower.subscribeTo(leader);
//Unsubscribe:
//follower.unsubscribeForward();
```

---

## ⚙️ Advanced Configuration

### PlayerManager Options

```ts
const manager = new PlayerManager({
	plugins: [...],
	extensions: [...],
	extractorTimeout: 30000,      // Timeout for stream extraction
	autoCleanup: true,            // Auto cleanup inactive players
	cleanupInterval: 120000,      // Cleanup interval (ms)
	enableSearchCache: true,      // Cache search results
	enableStatsCollection: true,  // Enable stats events
	trackMiddleware: [...],       // Global pre-stream track transforms (before per-player middleware)
	persistence: {...}            // Persistence configuration
});
````

### Player Options

```ts
const player = await manager.create(guildId, {
	volume: 100,
	quality: "high",
	leaveOnEnd: true,
	leaveOnEmpty: true,
	leaveTimeout: 100000,
	selfDeaf: true,
	selfMute: false,
	extractorTimeout: 50000,
	filters: ["bassboost", "nightcore"],
	tts: {
		createPlayer: false,
		interrupt: true,
		volume: 100,
		maxTimeTts: 60000,
	},
	// Runtime profile
	lowPerformance: false,
	preload: {
		enabled: true,
		autoDisableInLowPerformance: true,
	},
	crossfade: {
		enabled: undefined, // omit to let autoEnable decide
		autoEnable: true,
		autoDisableInLowPerformance: true,
		durationMs: 5000,
	},
	smartTransition: {
		enabled: true,
		genreAware: true,
		beatAlign: true,
		baseDurationMs: 5000,
		minDurationMs: 1200,
		maxDurationMs: 8000,
		genreDurations: { chill: 7000, edm: 2200 },
		beatAlignMaxWaitMs: 1200,
	},
	antiStuck: {
		enabled: true,
		maxRetries: 2,
		retryDelayMs: 900,
		reusePreloadFirst: true,
		reduceQualityOnRetry: true,
		controlledSkipThreshold: 3,
	},
	loudnessNormalization: {
		enabled: true,
		targetLUFS: -14,
		maxBoostDb: 8,
		maxCutDb: 10,
		limiterCeiling: 0.95,
	},
	trackMiddleware: [], // Optional per-player chain (after manager trackMiddleware)
	userdata: { customField: "value" },
});
```

### Crossfade + Low Performance

```ts
// Auto mode: crossfade/preload enabled unless lowPerformance is on
const player = await manager.create(guildId, {
	lowPerformance: false,
	preload: { enabled: true, autoDisableInLowPerformance: true },
	crossfade: { autoEnable: true, autoDisableInLowPerformance: true, durationMs: 4000 },
});

// Low performance mode: auto disable preload and crossfade
const litePlayer = await manager.create(guildId, {
	lowPerformance: true,
	preload: { enabled: true, autoDisableInLowPerformance: true }, // resolved: disabled
	crossfade: { autoEnable: true, autoDisableInLowPerformance: true }, // resolved: disabled
});
```

> Crossfade is applied when switching to the next track and when calling `player.skip()`. Smart transition adapts fade by
> `metadata.genre` and can align to beat using `metadata.bpm`. Loudness normalization uses `metadata.lufs` when available and
> applies a limiter ceiling.

---

## 📊 Monitoring & Stats

```ts
// Get manager statistics
const stats = manager.getStats();
console.log({
	totalPlayers: stats.totalPlayers,
	activePlayers: stats.activePlayers,
	pausedPlayers: stats.pausedPlayers,
	connectedPlayers: stats.connectedPlayers,
	totalTracksInQueue: stats.totalTracksInQueue,
});

// Get plugin/extension stats
console.log(manager.getConfig());
console.log(player.pluginManager.getStats());
console.log(player.extensionManager.getStats());

// Clear caches
player.clearSearchCache();
player.extensionManager.clearCache("search");
```

---

## ⚠️ Best Practices

- Use **one PlayerManager** per bot
- Always `await player.connect()` before playing
- Handle `playerError` events
- Do not reuse a destroyed player
- Enable **persistence** for production bots to survive restarts
- Use **autoCleanup** to prevent memory leaks
- Set appropriate **extractorTimeout** based on your network (default: 10-50 seconds)

---

## 🌟 Migration Guide

### From v1.x to v2.x

- `player.getTime()` now returns `{ current, total, format, formatted }`
- `player.getProgressBar()` supports new options
- `player.queue.remove(index)` removed track is now returned
- New `queue.removeMultiple()`, `queue.move()`, `queue.swap()` methods
- Extension hooks now support async properly

---

## 📚 Resources

- Examples: [https://github.com/ZiProject/ZiPlayer/tree/main/examples](https://github.com/ZiProject/ZiPlayer/tree/main/examples)
- GitHub: [https://github.com/ZiProject/ZiPlayer](https://github.com/ZiProject/ZiPlayer)
- npm: [https://www.npmjs.com/package/ziplayer](https://www.npmjs.com/package/ziplayer)
- AI/agent-oriented notes (middleware metadata, broadcast semantics): see `AGENTS.md` in this repo

---

## 📄 License

MIT License
