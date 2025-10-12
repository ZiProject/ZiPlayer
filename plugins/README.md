<img width="1175" height="305" alt="logo" src="https://github.com/user-attachments/assets/d4db4892-9c3d-4314-9228-701629555380" />

# @ziplayer/plugin

Official plugin bundle for ZiPlayer. It ships a set of ready‑to‑use source plugins you can register on your `PlayerManager`:

- YouTubePlugin: search + stream YouTube videos and playlists
- SoundCloudPlugin: search + stream SoundCloud tracks and sets
- SpotifyPlugin: resolve tracks/albums/playlists, stream via fallbacks
- TTSPlugin: Text‑to‑Speech playback from simple `tts:` queries

ZiPlayer is an audio player built on top of `@discordjs/voice` and `discord.js`. This package provides sources; the core player
lives in `ziplayer`.

## Installation

```bash
npm install @ziplayer/plugin ziplayer @discordjs/voice discord.js
```

The TTS plugin uses a lightweight Google TTS wrapper and HTTP fetches:

```bash
npm install @zibot/zitts axios
```

## Quick Start

```ts
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({
	plugins: [
		// Order matters: put more specific handlers first (e.g., TTS)
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
	],
});

// Create and connect a player (discord.js VoiceChannel instance)
const player = await manager.create(guildId, { userdata: { channel: textChannel } });
await player.connect(voiceChannel);

// Search & play
await player.play("never gonna give you up", requestedBy);

// Play a playlist URL directly
await player.play("https://www.youtube.com/playlist?list=...", requestedBy);

// Speak with TTS
await player.play("tts:en:Hello there!", requestedBy);

// Handle events via the manager
manager.on("trackStart", (plr, track) => {
	plr.userdata?.channel?.send?.(`Now playing: ${track.title}`);
});
```

## Included Plugins

### YouTubePlugin

- Resolves YouTube videos and playlists.
- Uses `youtubei.js` under the hood.

```ts
import { YouTubePlugin } from "@ziplayer/plugin";
const youtube = new YouTubePlugin();
```

### SoundCloudPlugin

- Resolves tracks and sets. You may further tune streaming by combining with other plugins that provide fallbacks.

```ts
import { SoundCloudPlugin } from "@ziplayer/plugin";
const sc = new SoundCloudPlugin();
```

### SpotifyPlugin

- Resolves track/album/playlist metadata from Spotify.
- Streaming typically uses fallback sources (e.g., YouTube) discovered by your plugin set.

```ts
import { SpotifyPlugin } from "@ziplayer/plugin";
const sp = new SpotifyPlugin();
```

### TTSPlugin (Text‑to‑Speech)

- Plays spoken audio from text using a lightweight Google TTS wrapper.
- Supported query formats:
  - `tts: <text>`
  - `tts:<lang>:<text>` (e.g., `tts:vi:xin chao`)
  - `tts:<lang>:1:<text>` (set `slow = true`, `0` = normal)

```ts
import { TTSPlugin } from "@ziplayer/plugin";
const tts = new TTSPlugin({ defaultLang: "en", slow: false });
await player.play("tts:en:1:good morning", requestedBy);
```

Note: Please comply with the service’s terms and provide your own quotas. The wrapper is intended for lightweight usage and may
change without notice.

Advanced: custom TTS provider

You can override audio generation by passing a `createStream` function. It receives the text and context and can return a Node
`Readable`, an HTTP(S) URL string, or a `Buffer`.

```ts
const tts = new TTSPlugin({
	defaultLang: "vi",
	async createStream(text, ctx) {
		// Example: integrate with Azure, CAMB.AI, etc.
		// Return a URL and the plugin will stream it
		const url = await myTTSService(text, { lang: ctx?.lang, slow: ctx?.slow });
		return url; // or Readable / Buffer
	},
});
```

## Writing Your Own Plugin

Plugins implement the `BasePlugin` contract from `ziplayer`:

```ts
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

export class MyPlugin extends BasePlugin {
	name = "myplugin";
	version = "1.0.0";

	canHandle(query: string): boolean {
		// Return true if this plugin can handle a given query/URL
		return query.includes("mysite.com");
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		// Return one or more tracks for the query
		return {
			tracks: [
				{
					id: "abc",
					title: "My Track",
					url: "https://mysite.com/track/abc",
					duration: 180,
					requestedBy,
					source: this.name,
				},
			],
		};
	}

	async getStream(track: Track): Promise<StreamInfo> {
		// Return a Node Readable stream and an input type
		return { stream, type: "arbitrary" };
	}
}
```

Tips

- Keep network calls bounded; ZiPlayer applies timeouts to extractor operations.
- For sources that require indirection (like Spotify), consider a `getFallback` strategy via other plugins.
- Use `track.metadata` for any source‑specific fields you want to carry along.

## Requirements

- Node.js 18+
- `discord.js` 14 and `@discordjs/voice` 0.19+
- For TTS: `@zibot/zitts` and `axios`

## License

MIT
