<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />

# ZiPlayer

ZiPlayer is a Discord audio engine built on top of `@discordjs/voice` and designed for real-time playback, queue orchestration,
advanced filter pipelines, custom output backends, and resilient player lifecycle management.

The public API is intentionally centered on `PlayerManager` and `Player`; the internal bus/controllers are operational details
used by the runtime, not the normal application integration surface.

---

## Highlights

- Robust per-guild `PlayerManager` + `Player` facade
- Source plugins for search, extraction, and playback fallback
- Queue management with loop, autoplay, insert, swap, move, and history operations
- FFmpeg filter pipeline with safe filter validation and early failure handling
- Preload, crossfade, smart transition, and anti-stuck recovery flow
- Loudness normalization and volume shaping for smoother transitions
- Custom and browser audio output through `audioOutputBackendFactory`
- WebSocket PCM publishing for browser clients using a strict 48 kHz stereo s16 LE contract
- Explicitly encoded-input-only DSP pipeline: raw PCM input is rejected by design

---

## Installation

```bash
npm install ziplayer @discordjs/voice discord.js
npm install --prefix core
```

Optional extras:

```bash
npm install @ziplayer/plugin @ziplayer/extension @ziplayer/infinity
npm install @discordjs/opus ffmpeg-static
```

---

## Quick start

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin, AttachmentsPlugin } from "@ziplayer/plugin";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const manager = new PlayerManager({
	plugins: [
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
		new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }),
	],
	autoCleanup: true,
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.guildId) return;
	if (!message.content.startsWith("!play ")) return;

	const voiceChannel = message.member?.voice?.channel;
	if (!voiceChannel) return message.reply("Join a voice channel first!");

	const player = await manager.create(message.guildId, {
		leaveOnEnd: true,
		leaveOnEmpty: true,
		volume: 80,
		userdata: { channelId: message.channelId },
	});

	if (!player.connection) await player.connect(voiceChannel);
	await player.play(message.content.slice(6).trim(), message.author.id);
});

manager.on("trackStart", (player, track) => console.log(`[${player.id}] now playing: ${track.title}`));
client.login(process.env.DISCORD_TOKEN);
```

---

## Public API overview

### Playback control

```ts
await player.play("Never Gonna Give You Up", userId);
await player.play("https://example.com/audio");
await player.play(track);
await player.play(searchResult);
await player.play(null); // resume from queue when supported

await player.pause();
await player.resume();
await player.skip();
await player.skip(2);
await player.previous();
await player.seek(45_000);
await player.stop();
player.setVolume(80);
```

### Queue operations

```ts
player.queue.add(track);
player.queue.addMultiple([track1, track2]);
player.queue.remove(0);
player.queue.removeMultiple([0, 2, 5]);
player.queue.move(2, 0);
player.queue.swap(1, 3);
player.queue.shuffle();
player.queue.clear();
player.queue.loop("queue");
player.queue.autoPlay(true);

console.log(player.queue.size, player.queue.isEmpty);
console.log(player.queue.currentTrack, player.queue.nextTrack);
```

### State and events

```ts
player.currentTrack;
player.connection;
player.isPlaying;
player.isPaused;
player.isIdle;
player.volume;
player.queue;
```

Manager-level events:

```ts
manager.on("trackStart", (player, track) => {});
manager.on("trackEnd", (player, track) => {});
manager.on("queueEnd", (player) => {});
manager.on("playerError", (player, error, track) => {});
manager.on("playerPause", (player, track) => {});
manager.on("playerResume", (player, track) => {});
manager.on("queueAdd", (player, track) => {});
manager.on("playerDestroy", (player) => {});
```

---

## Browser and custom audio outputs

ZiPlayer supports both the default Discord Voice backend and custom output backends. For browser playback, use a gateway-owned
WebSocket and route PCM to the browser client. The browser package is `@ziplayer/client` and validates the protocol on the client
side.

The runtime audio DSP is intentionally encoded-input-only and emits PCM. In other words, `audioProcessing.inputFormat` must be
`"encoded"`; raw PCM input is rejected by design. The downstream raw PCM output contract is:

- 48 kHz
- stereo
- interleaved
- little-endian
- signed 16-bit samples (`pcm16le`) or float32 PCM when explicitly configured

```ts
import { PlayerManager, WebSocketAudioOutputBackend } from "ziplayer";

const manager = new PlayerManager({ autoCleanup: true });

const player = await manager.create("web-player", {
	audioProcessing: {
		enabled: true,
		inputFormat: "encoded",
		outputFormat: "pcm16le",
		sampleRate: 48_000,
		channels: 2,
		maxBufferBytes: 64 * 1024,
	},
	audioOutputBackendFactory: ({ playerId }) =>
		new WebSocketAudioOutputBackend({
			sessionId: playerId,
			socketFactory: ({ sessionId, signal }) => connectPublisherSocket({ sessionId, signal, gatewayUrl, token }),
		}),
});

await player.play("https://example.com/audio.mp3", "user-1");
```

For a full runnable example, see the backend sample in `examples/backend` and the client receiver package in `client`.

---

## Player configuration

```ts
const player = await manager.create(guildId, {
	volume: 80,
	leaveOnEnd: true,
	leaveOnEmpty: true,
	lowPerformance: false,
	preload: { enabled: true, autoDisableInLowPerformance: true },
	crossfade: { enabled: true, durationMs: 4000 },
	smartTransition: {
		enabled: true,
		genreAware: true,
		beatAlign: true,
		baseDurationMs: 4000,
	},
	antiStuck: {
		enabled: true,
		maxRetries: 2,
		retryDelayMs: 800,
	},
	audioProcessing: {
		enabled: true,
		inputFormat: "encoded",
		outputFormat: "pcm16le",
		sampleRate: 48_000,
		channels: 2,
		normalize: "streaming",
		maxBufferBytes: 64 * 1024,
	},
	userdata: { customField: "value" },
});
```

---

## Filters, transitions, and recovery

- `player.filter.applyFilter()` / `player.filter.applyFilters()` for incremental FFmpeg chain updates
- `player.queue.loop("off" | "track" | "queue")`
- `preload` and `crossfade` can be enabled or auto-disabled in low-performance mode
- `antiStuck` retries stalled streams and falls back to safer recovery paths before skipping
- `smartTransition` can align fade timing across track transitions
- `loudnessNormalization` smooths volume jumps between tracks

---

## Recommended usage notes

- Create one `PlayerManager` per bot process; reuse it across commands.
- Call `await player.connect(voiceChannel)` before playback unless the voice channel is passed as part of the play call.
- Keep `audioOutputBackendFactory` custom backends explicit and return a connected output backend instance.
- Prefer `PlayerManager`/`Player` exports over bus/controller internals for application code.
- Treat raw PCM as a transport/output contract, not an input format for the DSP engine.

---

## Further reading

- [core/AGENTS.md](core/AGENTS.md)
- [core/README.md](core/README.md)
- [client/AGENTS.md](client/AGENTS.md)
- [examples/backend](examples/backend)

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
manager.on("stats", (PlayerStats) => {});
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
	pauseOnEmpty: false,
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

---

## 📄 License

MIT License
