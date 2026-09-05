# ZiPlayer Core Agent Guide

This file applies to work inside `core/`. Keep changes focused on the core package and do not edit generated output in
`core/dist/` or dependencies in `node_modules/`.

## Package scope

`core` is the TypeScript runtime for ZiPlayer. It owns player lifecycle, playback state, queue operations, stream resolution,
plugins, extensions, and the internal player bus.

Related packages live beside it:

- `plugins/`: source and stream providers
- `extension/`: optional player extensions
- `adapters/`: adapter interfaces and implementations
- `infinity/`: Infinity source integration
- `ytbexecplug/`: YouTube executable plugin
- `tests/`: repository-level Node tests

## Source map

Start from the public API in `src/index.ts`, then follow the owning abstraction:

| Area               | Location                                    | Responsibility                                           |
| ------------------ | ------------------------------------------- | -------------------------------------------------------- |
| Public player API  | `src/structures/Player.ts`                  | Per-guild controls and public getters                    |
| Player lifecycle   | `src/structures/PlayerManager.ts`           | Create, find, destroy, and broadcast players             |
| Internal bus       | `src/structures/PlayerBus.ts`               | RPC, synchronous queries, actions, and events            |
| Runtime wiring     | `src/structures/PlayerRuntimeController.ts` | Registers controllers, plugins, extensions, and handlers |
| Playback state     | `src/structures/PlaybackSession.ts`         | Active stream/session state and transitions              |
| Queue behavior     | `src/controller/QueueController.ts`         | Queue, history, loop, autoplay, and queue queries        |
| Search             | `src/controller/SearchController.ts`        | Search RPC, caching, and provider coordination           |
| Plugin behavior    | `src/plugins/`                              | Provider ordering, fallback, cache, and stream lookup    |
| Extension behavior | `src/extensions/`                           | Extension hooks and custom providers                     |
| Shared contracts   | `src/types/`                                | Public and internal TypeScript types                     |

## Control flow

Use the closest owning controller instead of adding behavior to `Player` when possible.

- Synchronous state reads use `player.bus.querySync(...)` and are exposed as getters on `Player`.
- Async operations use `player.bus.requestRpc(...)`; the RPC handler is registered by a controller during runtime initialization.
- Mutating playback actions go through `Player.action(...)` and `PlayerAction` so they remain ordered.
- Search flows through `Player.search()` -> `SearchController` -> extensions/plugins, with cache and fallback layers.
- Playback transitions must preserve the active `PlaybackSession` and its stream ownership. Check neighboring transition tests
  before changing this path.
- Bus events are published asynchronously; do not assume event listeners have completed when an RPC resolves unless the handler
  explicitly awaits them.

## Initialization and usage

Create one `PlayerManager` for the application and provide source plugins and optional extensions at startup. A manager can own
players for multiple guilds.

```ts
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({
	plugins: [new YouTubePlugin(), new SoundCloudPlugin()],
	extensions: [],
	autoCleanup: true,
	cleanupInterval: 60_000,
	extractorTimeout: 10_000,
	enableSearchCache: true,
});

const player = await manager.create(guildId, {
	leaveOnEnd: true,
	leaveOnEmpty: true,
	leaveTimeout: 100_000,
	volume: 100,
	quality: "high",
	selfDeaf: true,
	selfMute: false,
});

await player.connect(voiceChannel);
await player.play(query, userId);

player.pause();
player.resume();
await player.seek(30_000);
player.skip();
player.stop();

player.destroy();
manager.destroy();
```

`PlayerManager.default(options?)` is available for a default/global player. Prefer an explicit manager in application code so
plugins, extensions, cleanup, and event ownership remain clear.

## PlayerManager API

The manager is an `EventEmitter` with typed events. The most common public surface is:

| Prototype                                                                   | Purpose                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `new PlayerManager(options?)`                                               | Create the application-level manager                        |
| `create(guildOrId, options?): Promise<Player>`                              | Create or retrieve a player for a guild                     |
| `get(guildOrId): Player \| undefined`                                       | Get an existing player                                      |
| `getPlayer(guildOrId): Player \| undefined`                                 | Alias for `get`                                             |
| `getAll(): Player[]`                                                        | List managed players                                        |
| `has(guildOrId): boolean`                                                   | Check whether a player exists                               |
| `delete(guildOrId): boolean`                                                | Destroy and remove one player                               |
| `deleteWhere(filter): number`                                               | Destroy players matching a filter                           |
| `getStats(): PlayerStats`                                                   | Read manager/player statistics                              |
| `broadcast(action, ...args): void`                                          | Send a synchronous player API call to all players           |
| `broadcastAsync(action, ...args): Promise<PromiseSettledResult<unknown>[]>` | Send and await calls across players                         |
| `search(query, requestedBy): Promise<SearchResult>`                         | Search through the internal search player                   |
| `registerPlugin(plugin): void`                                              | Add a plugin to existing and future players                 |
| `unregisterPlugin(name): boolean`                                           | Remove a registered plugin from manager search state        |
| `getPlugins(): SourcePlugin[]`                                              | List registered plugins                                     |
| `registerExtension(extension): void`                                        | Add an extension to existing players                        |
| `clearSearchCache(): void`                                                  | Clear manager-level search cache                            |
| `getConfig(): object`                                                       | Read effective manager configuration                        |
| `destroy(): void`                                                           | Stop timers, destroy all players, and clear listeners/cache |

Manager options include `plugins`, `extensions`, `extractorTimeout`, `autoCleanup`, `cleanupInterval`, `enableSearchCache`,
`enableStatsCollection`, `trackMiddleware`, and `debugLevel`.

## Player API

`Player` is an `EventEmitter` for one guild. Common getters and operations are:

| Group              | Public prototype                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity/state     | `guildId`, `manager`, `options`, `connection`, `destroyed`, `playbackMode`, `userdata`                                                                                                     |
| State getters      | `currentTrack`, `queueSize`, `isPlaying`, `isPaused`, `isLive`, `isIdle`, `isBuffering`, `volume`, `previousTrack`, `upcomingTracks`, `previousTracks`, `relatedTracks`, `currentResource` |
| Voice/playback     | `connect(channel)`, `disconnect()`, `play(query, requestedBy?)`, `pause()`, `resume()`, `stop()`, `seek(position)`, `skip()`, `playNext()`, `previous()`                                   |
| Queue/volume       | `loop(mode?)`, `autoPlay(enabled?)`, `setVolume(value)`, `shuffle()`, `clearQueue()`, `insert(query, index?, requestedBy?)`, `remove(index)`                                               |
| Search/cache       | `search(query, requestedBy)`, `getCachedSearchResult(query)`, `cacheSearchResult(query, result)`, `clearSearchCache()`, `clearExpiredSearchCache()`, `debugSearchQuery(query)`             |
| Plugins/extensions | `addPlugin(plugin)`, `removePlugin(name)`, `attachExtension(extension)`, `detachExtension(extension)`, `getExtensions()`                                                                   |
| Forward mode       | `subscribeTo(leader, options?)`, `unsubscribeForward(reason?)`, `getForwardHealthStatus()`                                                                                                 |
| Playback helpers   | `getTime()`, `getProgressBar(options?)`, `save(track, options?)`, `saveVideo(track, options?)`, `getStreamManagerStats()`                                                                  |
| Lifecycle          | `scheduleLeave()`, `clearLeaveTimeout()`, `getSerializableState()`, `restoreState(state)`, `destroy()`, `dispose()`                                                                        |

Use `player.action(...)`, `player.query(...)`, and `player.subscribe(...)` when a feature needs the typed bus rather than a
convenience method. Methods such as `startTrack`, `loadFreshStream`, `promotePreloadToCurrent`, and `createResource` are runtime
integration points; do not call them from application code unless the owning controller requires it.

## Events

Listen on the manager for events that include the originating player:

```ts
manager.on("trackStart", (player, track) => {
	console.log(`${player.guildId}: ${track.title}`);
});

manager.on("playerError", (player, error, track) => {
	console.error(player.guildId, track?.title, error);
});

manager.on("queueEnd", (player) => {
	console.log(`Queue ended in ${player.guildId}`);
});

manager.on("playerDestroy", (player) => {
	console.log(`Destroyed ${player.guildId}`);
});
```

Manager event names include `debug`, `willPlay`, `trackStart`, `trackEnd`, `queueEnd`, `playerError`, `connectionError`,
`volumeChange`, `queueAdd`, `queueAddList`, `queueRemove`, `playerPause`, `playerResume`, `playerStop`, `playerDestroy`,
`ttsStart`, `ttsEnd`, `filterApplied`, `filterRemoved`, `filtersCleared`, `lyricsCreate`, `lyricsChange`, `voiceCreate`, `stats`,
`streamError`, `forwardModeStart`, `forwardModeEnd`, `seek`, and `trackStuck`.

Player events use the same names but omit the leading `player` argument. For example:

```ts
player.on("trackStart", (track) => console.log(track.title));
player.on("playerError", (error, track) => console.error(track?.title, error));
player.on("volumeChange", (oldVolume, newVolume) => console.log(oldVolume, newVolume));
player.once("playerDestroy", () => console.log("player destroyed"));
```

For internal typed bus events, use the unsubscribe function returned by `player.subscribe(...)`:

```ts
const unsubscribe = player.subscribe("playbackStateChanged", (event) => {
	console.log(event.session);
});

unsubscribe();
```

Typed bus event names include `initialized`, `ready`, `destroyed`, `TRACK_LOADING`, `TRACK_LOADED`, `TRACK_STARTED`,
`TRACK_ERROR`, `TRACK_END`, `STREAM_ABORTED`, `playbackStateChanged`, `playbackSessionCreated`, `trackRequested`, `stateChanged`,
`STUCK_DETECTED`, `RECOVERY_STARTED`, `RECOVERY_FAILED`, `preloadStateChanged`, `preloadPromoted`, `preloadCancelled`,
`queueChanged`, and `volumeRequested`.

## Development commands

Run commands from the repository root unless noted otherwise:

```powershell
# Build the core package
npm run build --prefix core

# Run the complete repository test suite after building core
npm test

# Run focused playback tests
node --test tests/playback_session_transition.test.js

# Run focused plugin tests
node --test tests/plugin_manager.test.js
```

The core package also supports `npm run build` and `npm run dev` when the working directory is `core/`. Tests import build
artifacts, so rebuild `core` after changing TypeScript source.

## Implementation rules

- Keep TypeScript strictness intact; do not weaken `core/tsconfig.json` to silence an error.
- Preserve the public API and existing return types unless the task explicitly requires a breaking change.
- Prefer an existing controller, manager, bus registration, cache, or utility over a new parallel abstraction.
- Keep state ownership explicit. Queue state belongs to queue controllers; active stream/session state belongs to
  `PlaybackSession` and its controllers.
- Use `requestRpcSync` only for handlers that are synchronous. Use `requestRpc` for async work and preserve abort/timeout
  behavior.
- Treat plugin and extension calls as untrusted boundaries: handle failures according to the existing fallback and error
  conventions.
- Avoid network, Discord, FFmpeg, and plugin side effects in unit tests; use small fakes or stubs.
- Do not edit `dist/`, source maps, package-lock metadata, or copied package files unless the task specifically concerns generated
  artifacts.

## Testing expectations

For a narrow change, run the nearest focused test first, then the core build. For changes involving shared bus contracts, playback
transitions, plugin ordering, or public API types, run the full repository suite after the focused check.

When adding behavior, cover at least the relevant success path and one failure, cancellation, or cleanup path. For lifecycle
changes, verify that sessions, streams, timers, listeners, and bus registrations are disposed exactly once.

## Common pitfalls

- `Player` mostly forwards calls. If it only exposes a method or getter, locate the registered bus handler before changing
  behavior.
- `querySync` selects synchronous state; putting async work behind it creates invalid return values and race conditions.
- `requestRpc` timeout does not automatically cancel work already running in a plugin or extension. Preserve the existing
  `AbortSignal` flow.
- Search and stream caching exist at multiple layers. Check cache ownership and invalidation before adding another cache.
- A passing TypeScript build does not prove playback correctness. Run the relevant transition or manager tests.
- Root tests depend on generated `core/dist` files. A missing dist submodule or stale build is a setup issue, not necessarily a
  source regression.

## Change checklist

1. Identify the public entry point and the controller that owns the behavior.
2. Read the nearest test and the relevant type contract before editing.
3. Make the smallest source change that preserves bus and lifecycle semantics.
4. Run the focused test or build immediately, then broaden validation as needed.
5. Report any unrelated baseline test or generated-artifact failure separately.
