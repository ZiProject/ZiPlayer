<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />

# @ziplayer/infinity

A ZiPlayer source plugin powered by [cobalt](https://cobalt.tools) — stream audio from **YouTube, TikTok, Instagram, Twitter/X,
SoundCloud, Reddit, Twitch, Bilibili, and 1000+ other sites** without API keys or authentication.

Internally it cycles through a live pool of community cobalt instances, validates streams, and falls back gracefully — so playback
keeps working even when individual instances go down.

> Source: [SASCYT9/infinity-downloader](https://github.com/SASCYT9/infinity-downloader) — Premium media downloader for YouTube,
> TikTok, Instagram & 1000+ sites.

ZiPlayer is an audio player built on top of `@discordjs/voice` and `discord.js`. This package provides the `InfinityPlugin`
source; the core player lives in `ziplayer`.

## Installation

```bash
npm install @ziplayer/infinity ziplayer @discordjs/voice discord.js
```

## Quick Start

```ts
import { PlayerManager } from "ziplayer";
import { InfinityPlugin } from "@ziplayer/infinity";

const manager = new PlayerManager({
	plugins: [
		// Combine with your other plugins — Infinity acts as a broad fallback
		new InfinityPlugin(),
	],
});

// Create and connect a player (discord.js VoiceChannel instance)
const player = await manager.create(guildId, { userdata: { channel: textChannel } });
await player.connect(voiceChannel);

// Play any supported URL directly
await player.play("https://www.youtube.com/watch?v=dQw4w9WgXcQ", requestedBy);
await player.play("https://www.tiktok.com/@user/video/123", requestedBy);
await player.play("https://soundcloud.com/artist/track", requestedBy);
await player.play("https://twitter.com/user/status/123", requestedBy);

// Handle events via the manager
manager.on("trackStart", (plr, track) => {
	plr.userdata?.channel?.send?.(`Now playing: **${track.title}**`);
});
```

## Supported Platforms

`InfinityPlugin` accepts direct URLs from any platform cobalt supports, including:

| Category  | Platforms                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Video** | YouTube, TikTok, Instagram, Twitter/X, Reddit, Twitch, Vimeo, Dailymotion, Bilibili, Niconico, Facebook, Snapchat, OK.ru, Rutube, Streamable, Pinterest, Tumblr, Tenor, Giphy |
| **Audio** | SoundCloud, Bandcamp                                                                                                                                                          |

> Plain text search queries are not supported — provide a direct URL. Pair with `YouTubePlugin` or `SoundCloudPlugin` for text
> search.

## Usage

### Basic setup

```ts
import { InfinityPlugin } from "@ziplayer/infinity";

const infinity = new InfinityPlugin();
```

### Registering alongside other plugins

`InfinityPlugin` has a `priority` of `10`, so more specific plugins (YouTube, SoundCloud, etc.) are tried first. Place it last in
your plugin list as a wide-net fallback:

```ts
const manager = new PlayerManager({
	plugins: [
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
		new InfinityPlugin(), // catch-all fallback for everything else
	],
});
```

### Resolving a track manually

```ts
const { tracks } = await infinity.search("https://www.tiktok.com/@user/video/123456", "user123");

const streamInfo = await infinity.getStream(tracks[0]);
streamInfo.stream.pipe(audioOutput);
```

### Picker / multi-media posts

For posts that contain multiple videos (e.g. a Twitter/X post with a gallery), use `extractPlaylist`:

```ts
const tracks = await infinity.extractPlaylist("https://twitter.com/user/status/123", "user123");
// Returns one Track per video in the post
```

## How It Works

1. **Instance discovery** — On each request, the plugin fetches a live list of working cobalt API instances from
   `cobalt.directory`. If that fails, it falls back to a hardcoded list of reliable community instances.

2. **Instance cycling** — It tries up to 10 instances in order. Instance-level errors (auth required, rate limit, capacity,
   decipher failures) are silently skipped. Content-level errors (bad URL, unavailable content) stop the loop immediately and
   surface the error.

3. **Tunnel validation** — When an instance returns a tunnel URL, the plugin reads the first chunk to confirm the stream isn't a
   corrupted 0-byte response before returning it.

4. **Fallback** — If all 10 standard attempts fail, `getFallback` retries with up to 16 instances, giving maximum resilience for
   flaky networks or busy instances.

## API

### `canHandle(query: string): boolean`

Returns `true` for URLs whose hostname matches a cobalt-supported platform. Returns `false` for plain text queries.

### `search(query: string, requestedBy: string): Promise<SearchResult>`

Accepts a direct platform URL and returns a single `Track` with lightweight metadata derived from the URL (YouTube thumbnail
included when detectable). Throws if a plain text query is passed.

### `getStream(track: Track, signal?: AbortSignal): Promise<StreamInfo>`

Resolves the track URL through the cobalt instance pool and returns a Node.js `Readable` stream. The `type` field is `"webm/opus"`
or `"ogg/opus"` when the `Content-Type` allows it, otherwise `"arbitrary"`.

### `getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo>`

Same as `getStream` but uses a wider instance sweep (up to 16 attempts). Called automatically by ZiPlayer when `getStream` fails.

### `extractPlaylist(url: string, requestedBy: string): Promise<Track[]>`

Maps cobalt's `picker` response (multi-video posts) into a `Track[]`. Falls back to a single-track result for regular URLs.

## Requirements

- Node.js 18+
- `discord.js` 14 and `@discordjs/voice` 0.19+

No API keys or authentication required.

## License

MIT
