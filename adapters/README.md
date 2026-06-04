<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />
# @ziplayer/adapters

Bridge package that lets you register **any third-party extractor** in ZiPlayer without rewriting it.

Supported ecosystems out of the box:

| Source                                        | Detection                        |
| --------------------------------------------- | -------------------------------- |
| **ZiPlayer** `BasePlugin`                     | pass-through (no wrapping)       |
| **discord-player** single extractor           | `validate` + `handle` + `stream` |
| **discord-player** `DefaultExtractors`        | `.extractors` Map                |
| **DisTube** plugin                            | `resolve` + `getStreamURL`       |
| **Generic** (youtube-dl-exec, yt-dlp-wrap, …) | `getInfo` / `download`           |
| **Array** of any of the above                 | fan-out `MultiAdapter`           |

---

## Installation

```bash
npm install @ziplayer/adapters ziplayer
```

---

## Quick Start

```ts
import { PlayerManager } from "ziplayer";
import { YouTubePlugin } from "@ziplayer/plugin";
import { provide } from "@ziplayer/adapters";

// ── discord-player ──────────────────────────────────────────────
import { DefaultExtractors } from "@discord-player/extractor";
import { SoundCloudExtractor } from "@discord-player/extractor";

// ── DisTube ─────────────────────────────────────────────────────
import SoundCloudPlugin from "@distube/soundcloud";
import SpotifyPlugin from "@distube/spotify";

// ── Generic (youtube-dl-exec) ────────────────────────────────────
import youtubeDl from "youtube-dl-exec";

const manager = new PlayerManager({
	plugins: [
		// Native ZiPlayer plugin – returned as-is
		new YouTubePlugin({}),

		// All discord-player extractors in one call
		provide(new DefaultExtractors()),

		// A single discord-player extractor
		provide(new SoundCloudExtractor(), { priority: 8 }),

		// DisTube plugin
		provide(new SoundCloudPlugin()),
		provide(new SpotifyPlugin({ api: { clientId: "...", clientSecret: "..." } })),

		// Generic extractor – needs getInfo() and/or download()
		provide({
			name: "yt-dlp",
			getInfo: (url) => youtubeDl(url, { dumpSingleJson: true, noWarnings: true }),
			download: (url) => youtubeDl.raw(url, { output: "-" }),
		}),

		// Array shorthand – wraps each item and bundles as MultiAdapter
		provide([new SoundCloudPlugin(), new SpotifyPlugin()]),
	],
	enableStatsCollection: true,
});
```

---

## API

### `provide(plugin, options?)`

The only function you need. Auto-detects the plugin type and returns a `BasePlugin` compatible with ZiPlayer.

```ts
import { provide, ProvideOptions } from "@ziplayer/adapters";

const adapted = provide(thirdPartyPlugin, {
	priority: 10, // override ZiPlayer priority (higher = tried first)
	name: "my-ext", // override plugin name
});
```

**Accepted `plugin` shapes:**

```ts
// Already a ZiPlayer plugin → pass-through
provide(new YouTubePlugin({}));

// discord-player DefaultExtractors container
provide(new DefaultExtractors());

// discord-player single extractor
provide(new SoundCloudExtractor());

// DisTube plugin
provide(new SoundCloudPlugin());

// Generic object with getInfo() / download()
provide({ name: "custom", getInfo: async (url) => ({ ... }) });

// Array → wrapped in a MultiAdapter
provide([new SoundCloudPlugin(), new SpotifyPlugin()]);
```

---

## Adapter Classes (advanced)

You can import the individual adapters if you want fine-grained control:

```ts
import {
	DiscordPlayerExtractorAdapter, // single discord-player extractor
	DiscordPlayerContainerAdapter, // DefaultExtractors container
	DistubePluginAdapter, // DisTube plugin
	GenericExtractorAdapter, // youtube-dl-exec / yt-dlp-wrap / custom
	MultiAdapter, // fan-out across multiple adapters
} from "@ziplayer/adapters";

const adapter = new DistubePluginAdapter(new SoundCloudPlugin());
adapter.priority = 15;

const manager = new PlayerManager({
	plugins: [adapter],
});
```

---

## Writing a custom adapter

If `provide()` doesn't recognise your extractor, implement `BasePlugin` directly:

```ts
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";
import MyLib from "my-audio-lib";

export class MyLibAdapter extends BasePlugin {
	name = "mylib";
	version = "1.0.0";
	priority = 5;

	canHandle(query: string): boolean {
		return MyLib.supports(query);
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		const results = await MyLib.search(query);
		return {
			tracks: results.map((r) => ({
				id: r.id,
				title: r.name,
				url: r.url,
				duration: r.duration * 1000,
				thumbnail: r.image,
				requestedBy,
				source: this.name,
				metadata: { original: r },
			})),
		};
	}

	async getStream(track: Track): Promise<StreamInfo> {
		const stream = await MyLib.stream(track.url);
		return { stream, type: "arbitrary" };
	}
}
```

Then use it directly:

```ts
new PlayerManager({
	plugins: [new MyLibAdapter()],
});
```

---

## How detection works

`provide()` checks shapes in this order:

```
1. Array?                    → MultiAdapter (wraps each item)
2. has canHandle+search+getStream? → ZiPlayer BasePlugin, pass-through
3. has .extractors Map?      → DiscordPlayerContainerAdapter
4. has validate|handle|stream? → DiscordPlayerExtractorAdapter
5. has resolve|getStreamURL? → DistubePluginAdapter
6. has getInfo|download?     → GenericExtractorAdapter
7. else                      → throws descriptive error
```
