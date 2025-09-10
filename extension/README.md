<img width="1244" height="305" alt="logo" src="https://github.com/user-attachments/assets/c8181e90-fdc9-4e08-8fe4-b4419cb8a25b" />

# @ziplayer/extension

A collection of extensions for ZiPlayer. Currently ships with `voiceExt` — listens to voice in a Discord voice channel, performs
Speech‑to‑Text, and emits results directly on the `PlayerManager` for your app to consume. More extensions can be built in the
future (TTS, audio effects/filters, AutoDJ, lyrics, moderation, …).

• This package assumes you’re using ZiPlayer core (`ziplayer`) and a Discord bot with voice permissions.

## Installation

```bash
npm install @ziplayer/extension
# Recommended peer deps:
npm install ziplayer @ziplayer/plugin @discordjs/voice discord.js
```

## Current Features

### voiceExt (Speech‑to‑Text)

- Auto‑hooks into `player.connection.receiver` after you `connect()` to a voice channel.
- Buffers audio frames, decodes Opus → PCM 48kHz, converts stereo → mono, applies a simple RMS‑based level check.
- Waits ~2s after the user stops speaking before sending audio to Google Speech (configurable).
- Calls Google Speech API v2 with options for `lang`, `profanityFilter`, and API `key`.
- Emits `voiceCreate` DIRECTLY via the `PlayerManager` (payload includes transcript, userId, channelId, guildId, …).
- Falls back to emitting on the `player` if a manager is not available.

> Note: Provide your own API key via `GSPEECH_V2_KEY` env or the `key` option and respect the service’s terms.

## Quick Start

TypeScript / ESM

```ts
import { PlayerManager } from "ziplayer";
import { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } from "@ziplayer/plugin";
import { voiceExt } from "@ziplayer/extension";

const manager = new PlayerManager({
	plugins: [new SoundCloudPlugin(), new YouTubePlugin(), new SpotifyPlugin()],
	extensions: [
		new voiceExt(null, {
			// Options (see below)
			lang: "vi-VN",
			minimalVoiceMessageDuration: 1,
			postSilenceDelayMs: 2000,
		}),
	],
});

// Receive transcripts
manager.on("voiceCreate", (player, evt) => {
	console.log(`User ${evt.userId} said: ${evt.content}`);
});
```

CommonJS

```js
const { PlayerManager } = require("ziplayer");
const { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } = require("@ziplayer/plugin");
const { voiceExt } = require("@ziplayer/extension");

const manager = new PlayerManager({
	plugins: [new SoundCloudPlugin(), new YouTubePlugin(), new SpotifyPlugin()],
	extensions: [new voiceExt()],
});

manager.on("voiceCreate", (player, evt) => {
	console.log(`User ${evt.userId}: ${evt.content}`);
});
```

When you create a player and `connect()` to a voice channel, the extension automatically attaches to the receiver and starts
listening. After the user stops speaking, the extension waits briefly, then sends audio to Google Speech and emits a `voiceCreate`
event with this payload:

```ts
type VoiceCreatePayload = {
	content: string; // transcript
	userId: string; // speaker ID
	channelId: string; // voice channel ID
	guildId: string; // server ID
	user?: any; // Discord user object if a client is provided
	channel?: any; // Discord channel object if a client is provided
};
```

## Options (SpeechOptions)

- ignoreBots: boolean – Ignore bot users (default: true)
- focusUser?: string – Only listen to a specific user (default: undefined)
- minimalVoiceMessageDuration: number – Minimum duration in seconds to accept (default: 1)
- postSilenceDelayMs?: number – Delay after silence before STT (default: 2000)
- lang: string – Google Speech language code (default: "vi-VN")
- key?: string – Google Speech v2 API key (default: from `process.env.GSPEECH_V2_KEY`)
- profanityFilter?: boolean – Enable profanity filtering (default: false)
- onVoiceChange?: (ctx) => Partial<SpeechOptions> | void | Promise<Partial<SpeechOptions> | void> – Hook called on every
  `speaking.start`; return overrides like `{ lang: "en-US" }` to apply per session.

Initialize with options:

```ts
new voiceExt(null, { client, lang: "vi-VN", postSilenceDelayMs: 2500 });
```

Or update after attaching:

```ts
ext.attach(client, { focusUser: "123456789012345678" });
```

Per‑session overrides via `onVoiceChange` (e.g., switch language by user or guild):

```ts
new voiceExt(null, {
	onVoiceChange: async ({ userId, guildId, current }) => {
		// Example: force English for a specific guild, else keep current
		if (guildId === "123456789012345678") return { lang: "en-US" };
		// Example: user-specific override
		if (userId === "999999999999999999") return { lang: "ja-JP" };
		return; // no change
	},
});
```

If you pass a Discord.js `client`, the payload will include resolved `user` and `channel` objects when possible.

## Requirements & Tips

- Your bot needs the `GuildVoiceStates` intent.
- Consider `selfDeaf: true` when joining to avoid echo.
- Provide your own Google key (`GSPEECH_V2_KEY`) to control quota.
- Subscribe to the `debug` event on Player/Manager to inspect logs.

## Roadmap (future ideas)

- Text‑to‑Speech (TTS) and voice responses in voice channels.
- Voice Commands ("pause", "skip", "next", …) without prefixes.
- Local STT (e.g., Whisper/Vosk) to avoid external services.
- Audio FX/Filters (bass boost, 8D, nightcore, karaoke, …).
- AutoDJ/Recommendations based on listening history.
- Lyrics fetcher + auto‑caption.
- Moderation (banned word detection, voice logs).
- Analytics/metrics for listening sessions.
- Queue persistence/restore on bot restarts.

Contributions and ideas are welcome!

## License

MIT
