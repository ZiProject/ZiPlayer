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
        ├── Queue
        ├── PluginManager
        ├── ExtensionManager
        └── FilterManager
```

### Flow

```
create → connect → play → stream → events → destroy
```

---

## 🎵 Core Usage

### Play music

```ts
await player.play("Never Gonna Give You Up", userId);
await player.play("https://youtube.com/watch?v=...", userId);
await player.play("tts: Hello world", userId);
```

### Controls

```ts
player.pause();
player.resume();
player.skip();
player.stop();
player.setVolume(100);
player.loop("track");
player.shuffle();
```

### Queue

```ts
player.queue.add(track);
player.queue.remove(0);
player.queue.shuffle();
player.queue.clear();
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

---

## 🎛️ Audio Filters

Apply FFmpeg filters in real-time:

```ts
await player.filter.applyFilter("bassboost");
await player.filter.applyFilter("nightcore");
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
	},
});

await player.play("tts: Hello everyone", userId);
```

---

## 📡 Events

Listen globally via manager:

```ts
manager.on("trackStart", (player, track) => {});
manager.on("queueEnd", (player) => {});
manager.on("playerError", (player, error) => {});
```

---

## 🧠 Advanced Features

### Autoplay

```ts
player.queue.autoPlay(true);
```

### Insert next track

```ts
await player.insert("song", 0);
```

### Save stream

```ts
const stream = await player.save(track);
stream.pipe(fs.createWriteStream("song.mp3"));
```

---

## ⚠️ Best Practices

- Use **one PlayerManager** per bot
- Always `await player.connect()` before playing
- Handle `playerError` events
- Do not reuse a destroyed player

---

## 📚 Resources

- Examples: [https://github.com/ZiProject/ZiPlayer/tree/main/examples](https://github.com/ZiProject/ZiPlayer/tree/main/examples)
- GitHub: [https://github.com/ZiProject/ZiPlayer](https://github.com/ZiProject/ZiPlayer)
- npm: [https://www.npmjs.com/package/ziplayer](https://www.npmjs.com/package/ziplayer)

---

## 📄 License

MIT License
