<img width="1175" height="305" alt="logo" src="https://raw.githubusercontent.com/ZiProject/ZiPlayer/refs/heads/main/publish/logo.png" />

# @ziplayer/adapters

Bridge package that lets you register **any third-party extractor** in ZiPlayer without rewriting it.

Supported ecosystems out of the box:

| Source                                        | Accepted shapes            | Detection                                           |
| --------------------------------------------- | -------------------------- | --------------------------------------------------- |
| **ZiPlayer** `BasePlugin`                     | instance or class          | `canHandle` + `search` + `getStream` → pass-through |
| **discord-player** single extractor           | instance or class          | `handle` / `activate` / `stream`                    |
| **discord-player** `DefaultExtractors`        | array of extractor classes | every element is a DP extractor constructor         |
| **discord-player** extractor container        | object with `.extractors`  | `.extractors` is a non-empty `Map` or `Array`       |
| **DisTube** plugin                            | instance or class          | `resolve` / `searchSong` / `getStreamURL`           |
| **Generic** (youtube-dl-exec, yt-dlp-wrap, …) | plain object               | `getInfo` / `download`                              |
| **Array** of any of the above                 | mixed array                | fan-out `MultiAdapter`                              |

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
import { DefaultExtractors, SoundCloudExtractor } from "@discord-player/extractor";

// ── DisTube ─────────────────────────────────────────────────────
import { SoundCloudPlugin } from "@distube/soundcloud";
import { SpotifyPlugin } from "@distube/spotify";

// ── Generic (youtube-dl-exec) ────────────────────────────────────
import youtubeDl from "youtube-dl-exec";

const manager = new PlayerManager({
	plugins: [
		// Native ZiPlayer plugin instance – returned as-is
		new YouTubePlugin({}),

		// discord-player DefaultExtractors (array of extractor classes)
		provide(DefaultExtractors),

		// Single discord-player extractor instance with priority override
		provide(new SoundCloudExtractor(), { priority: 8 }),

		// DisTube plugin instances
		provide(new SoundCloudPlugin()),
		provide(new SpotifyPlugin({ api: { clientId: "...", clientSecret: "..." } })),

		// Generic extractor – needs getInfo() and/or download()
		provide({
			name: "yt-dlp",
			getInfo: (url) => youtubeDl(url, { dumpSingleJson: true, noWarnings: true }),
			download: (url) => youtubeDl.raw(url, { output: "-" }),
		}),

		// Array shorthand – each item wrapped individually, bundled as MultiAdapter
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
import { provide } from "@ziplayer/adapters";
import type { ProvideOptions } from "@ziplayer/adapters";

const adapted = provide(thirdPartyPlugin, {
	priority: 10, // override ZiPlayer priority (higher = tried first)
	name: "my-ext", // override plugin name (has no effect on native ZiPlayer plugins)
});
```

**All accepted `plugin` shapes:**

```ts
// ZiPlayer plugin instance → pass-through
provide(new YouTubePlugin({}));

// ZiPlayer plugin class → auto-instantiated, then pass-through
provide(YouTubePlugin);

// discord-player DefaultExtractors (array of extractor classes)
provide(DefaultExtractors);

// discord-player extractor container (object with .extractors Map or Array)
provide(myExtractorContainer);

// discord-player single extractor class → auto-instantiated
provide(SoundCloudExtractor);

// discord-player single extractor instance
provide(new SoundCloudExtractor());

// DisTube plugin class → auto-instantiated
provide(SoundCloudPlugin);

// DisTube plugin instance
provide(new SoundCloudPlugin());

// Generic object with getInfo() and/or download()
provide({
	name: "custom",
	getInfo: async (url) => ({/* ... */}),
});

// Array of any of the above → MultiAdapter
// (single-element array returns the wrapped item directly)
provide([new SoundCloudPlugin(), new SpotifyPlugin()]);
```

---

## Adapter Classes (advanced)

You can import the individual adapters for fine-grained control:

```ts
import {
	DiscordPlayerExtractorAdapter, // single discord-player extractor
	DiscordPlayerContainerAdapter, // DefaultExtractors / .extractors container
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

Then use it directly — no `provide()` needed:

```ts
new PlayerManager({
	plugins: [new MyLibAdapter()],
});
```

---

## How detection works

`provide()` evaluates the input in this exact order, stopping at the first match:

```
 1. Array where every element is a discord-player extractor class
      → DiscordPlayerContainerAdapter

 2. Any other non-empty array
      → each element wrapped recursively; single-element array returns
        the wrapper directly, otherwise bundled as MultiAdapter

 3. Class whose prototype has canHandle + search + getStream   (ZiPlayer)
      → auto-instantiated → pass-through

 4. Class whose prototype has resolve / searchSong / getStreamURL  (DisTube)
      → auto-instantiated → DistubePluginAdapter

 5. Class whose prototype has handle / activate / stream  (discord-player)
      → auto-instantiated → DiscordPlayerExtractorAdapter

 6. Any other constructor function
      → auto-instantiated → re-evaluated from step 1

 7. Object whose .extractors property is a non-empty Map or Array
      → DiscordPlayerContainerAdapter

 8. Object with canHandle + search + getStream   (ZiPlayer instance)
      → pass-through

 9. Object with resolve / searchSong / getStreamURL  (DisTube instance)
      → DistubePluginAdapter

10. Object with handle / activate / stream  (discord-player extractor instance)
      → DiscordPlayerExtractorAdapter

11. Object with getInfo() or download()   (generic)
      → GenericExtractorAdapter

12. else → throws a descriptive error
```

> **Why DisTube is checked before discord-player at the instance level (steps 9–10):** Both ecosystems can expose a `validate()`
> method. Checking DisTube's distinct shape (`resolve` / `searchSong` / `getStreamURL`) first prevents mis-routing DisTube plugins
> into the discord-player extractor adapter.
