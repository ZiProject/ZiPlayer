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
- 💿 **Persistence** — Auto-save and restore player state across restarts
- ⚡ **Smart caching** — Search and stream caching for better performance
- 🎯 **Queue management** — Advanced queue operations (move, swap, batch remove)

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
  ├── PersistenceManager (auto-save/load)
  └── Player (per guild)
        ├── Queue (advanced operations)
        ├── PluginManager (with caching & fallback)
        ├── ExtensionManager (with priority & caching)
        └── FilterManager (FFmpeg filters)
```

### Flow

```
create → connect → play → stream → events → destroy
         ↓
    auto-save (periodic)
         ↓
    restore on restart
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

## 💾 Persistence (Auto-save & Restore)

Automatically save and restore player state across bot restarts.

### Setup

```ts
const manager = new PlayerManager({
	plugins: [new YouTubePlugin()],
	persistence: {
		enabled: true,
		filePath: "./player_data",

		// Backup management
		maxBackups: 3, // Keep only 3 backups per player
		maxTotalBackups: 20, // Keep max 20 total backup files
		autoCleanupBackupsOnStart: true, // Clean old backups on startup
		backupRetentionDays: 3, // Delete backups older than 3 days

		// Auto restore
		autoRestoreOnRestart: true,
		restoreDelay: 3000,

		compress: true,
	},
});

// Listen to persistence events
manager.on("playerSaved", (guildId) => console.log(`Saved ${guildId}`));
manager.on("playerLoaded", (guildId, data) => console.log(`Loaded ${guildId} from ${new Date(data.lastUpdate)}`));
```

### Manual Persistence

```ts
// Save specific player
await manager.savePlayer(guildId);
await player.save(); // From player instance

// Save all players
await manager.saveAllPlayers();

// Load players
await manager.loadPlayer(guildId, true); // Restore playback position
await manager.loadAllPlayers();

// Delete saved data
const persistence = manager.getPersistence();
await persistence?.deletePlayer(guildId);
await persistence?.restoreBackup(guildId); // Restore from backup
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

// Persistence events
manager.on("playerSaved", (guildId) => {});
manager.on("playerLoaded", (guildId, data) => {});
manager.on("savedAll", (results) => {});
manager.on("loadedAll", (results) => {});
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
	persistence: {...}            // Persistence configuration
});
```

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
	userdata: { customField: "value" },
});
```

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

---

## 📄 License

MIT License

```

```
