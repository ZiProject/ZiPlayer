# ZiPlayer Core: AI Usage Guide

This guide helps AI assistants use the `ziplayer` package correctly and make focused changes in `core/`.

## Start With the Public API

For bot or application code, use the exported `PlayerManager` and `Player` API. Do not build normal user workflows directly on the
Bus or controllers. Read the advanced sections only when a task requires changing `core/src/**` internals.

The main public entry points are exported from [`src/index.ts`](src/index.ts). The API implementation is in
[`src/structures/Player.ts`](src/structures/Player.ts), manager behavior is in
[`src/structures/PlayerManager.ts`](src/structures/PlayerManager.ts), and public types are in [`src/types/`](src/types/).

## Quick Start

ZiPlayer runs on Node.js 20.3 or newer and uses Discord voice. Playback from text queries requires one or more compatible source
plugins. Install the plugin package separately and pass plugin instances to the manager.

```ts
import { PlayerManager } from "ziplayer";
import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin, AttachmentsPlugin } from "@ziplayer/plugin";
import type { VoiceChannel } from "ziplayer";

const manager = new PlayerManager({
	plugins: [
		new TTSPlugin({ defaultLang: "en" }),
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
		new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }), //25mb
	],
	autoCleanup: true,
});

async function playInGuild(guildId: string, voiceChannel: VoiceChannel, query: string, userId: string) {
	const player = await manager.create(guildId, {
		leaveOnEnd: true,
		leaveOnEmpty: true,
		volume: 80,
		userdata: {
			/*User store data*/
		},
	});

	if (!player.connection) await player.connect(voiceChannel);

	const result = await player.play(query, { requestedBy: userId });
	if (!result) {
		console.error("The query could not be played");
	}
	return player;
}

manager.on("trackStart", (player, track) => {
	console.log(`[${player.id}] Now playing: ${track.title}`);
});
```

`VoiceChannel` above represents the guild voice channel object provided by Discord.js; it is not a ZiPlayer class to instantiate.
`manager.create()` is asynchronous and returns the existing player if one is already registered for that guild. `connect()` and
`play()` are asynchronous. Handle rejections at the bot's command boundary.

## Everyday Player API

### Playback

```ts
await player.play("song title", { requestedBy: userId });
await player.play("https://example.com/audio");
await player.play(track); // A Track already resolved by your application
await player.play(searchResult); // A SearchResult
await player.play(null); // Resume playback from the existing queue when supported

await player.pause();
await player.resume();
await player.skip();
await player.skip(2); // Play the queued item at index 2
await player.previous();
await player.seek(45_000); // Position is milliseconds
await player.stop();
player.setVolume(80); // Valid range: 0 to 200
```

Most playback controls resolve to a boolean indicating whether the operation succeeded. `play()` resolves to a `PlayResult` or
`false`. Check the result instead of assuming a search or playback request succeeded.

### Queue

`player.queue` provides synchronous inspection and queue operations. `queue.add()` accepts a resolved `Track`, not a search
string. Use `player.insert()` when a query needs to be searched before insertion.

```ts
console.log(player.queue.size, player.queue.isEmpty);
console.log(player.queue.currentTrack, player.queue.nextTrack);

player.queue.add(track);
player.queue.addMultiple(tracks);
await player.insert("another song", 0, userId); // Search and insert at the front

player.queue.remove(0);
player.queue.move(2, 0);
player.queue.shuffle();
player.queue.clear();
player.queue.loop("queue"); // "off", "track", or "queue"
player.queue.autoPlay(true);
```

`player.insert(query, index, requestedBy)` is asynchronous and returns a boolean. Queue methods operate on the player's shared
queue state; do not replace or shadow that state in application code.

### State and Events

Common state is available directly from the facade:

```ts
player.currentTrack;
player.connection;
player.isPlaying;
player.isPaused;
player.isIdle;
player.volume;
player.queue;
```

These are synchronous reads. Register manager-wide events with the typed `manager.on()` API:

| Event                         | Listener arguments        |
| ----------------------------- | ------------------------- |
| `trackStart`                  | `(player, track)`         |
| `trackEnd`                    | `(player, track)`         |
| `queueEnd`                    | `(player)`                |
| `playerError`                 | `(player, error, track?)` |
| `connectionError`             | `(player, error)`         |
| `queueAdd`                    | `(player, track)`         |
| `queueAddList`                | `(player, tracks)`        |
| `playerPause`, `playerResume` | `(player, track)`         |
| `playerDestroy`               | `(player)`                |

The first event argument is the affected `Player`, which is useful when one manager serves multiple guilds. See `ManagerEvents` in
[`src/types/core.ts`](src/types/core.ts) for the complete event list and exact argument types.

### Lifecycle and Configuration

- Create one `PlayerManager` for the process and use `manager.create(guildId, playerOptions)` to get a guild player.
- Connect with `await player.connect(voiceChannel)` before playback unless you pass a `voiceChannel` in `play()` options.
- Call `player.destroy()` when the bot explicitly removes a player. Manager cleanup may also destroy idle players according to its
  options.
- Configure source plugins on `PlayerManagerOptions.plugins`; per-player options such as volume, voice behavior, filters, preload,
  and crossfade belong in `PlayerOptions`.
- The canonical option definitions are `PlayerManagerOptions` and `PlayerOptions` in [`src/types/core.ts`](src/types/core.ts).
  Prefer those definitions over guessing option names or defaults.

## Common Mistakes to Avoid

- Do not treat `play()`, `connect()`, `insert()`, or playback controls as synchronous; await them and handle `false` or rejection.
- Do not pass a raw search string to `player.queue.add()`. Use `player.play()` or `player.insert()` for queries.
- Do not assume a string query works without a compatible search/stream plugin.
- Do not store your own playback state when the corresponding `Player` getter or queue API already exposes it.
- A player in `PlaybackMode.FORWARD` is a follower and cannot control playback. Unsubscribe it before attempting playback
  mutations.
- Avoid low-level exports (`Bus`, controller classes, action/query identifiers) in ordinary bot integration code; they are
  advanced extension points, not the standard Player API.

## Advanced Features: Internal Architecture

Read this section when modifying the core implementation or adding a feature that crosses controller boundaries. For application
integrations, the public API above is the intended contract.

### Architecture and Ownership

ZiPlayer separates the process-wide manager, shared controllers, Bus, and per-guild `Player` facade:

1. **`PlayerManager`** owns one global `Bus`, creates shared controllers, maps player IDs to facades, and coordinates teardown.
2. **`Bus`** connects controllers to each other and to `Player` through requests, outputs, actions, RPCs, queries, and events.
3. **Shared controllers** are process-wide singletons. Per-player mutable state belongs in controller slots keyed by `playerId`;
   controllers attach state on player creation and release it on destruction.
4. **`Player`** is a lightweight facade. Playback, queue, audio, connection, and filter state are owned by controllers, not
   duplicated in `Player.ts`.

The Bus contract is defined in [`src/structures/BusContract.ts`](src/structures/BusContract.ts) and typed in
[`src/types/bus.ts`](src/types/bus.ts).

### Hard Invariants

1. **Never edit generated output.** Edit TypeScript under `core/src/**`; `core/dist/` is generated by the build.
2. **Keep `Player.ts` a facade.** Do not add guild-specific mutable playback, queue, audio, or filter state there.
3. **Preserve synchronous query contracts.** `querySync()` and `requestRpcSync()` must return immediate, non-Promise values. An
   asynchronous handler must use the asynchronous query/RPC path.
4. **Serialize playback mutations.** `PLAY`, `PAUSE`, `RESUME`, `SEEK`, `STOP`, `SKIP`, and `SET_VOLUME` must pass through
   `PlayerActionExecutor` (`this.action()` or `bus.action()`).
5. **Enforce forward-mode guards.** Followers (`playbackMode === PlaybackMode.FORWARD`) must not mutate playback. Existing facade
   methods return `false` or return early and log a debug message.
6. **Recover from failed starts.** A failed track start must not leave playback idle indefinitely. Respect
   `controlledSkipThreshold`; below it skip with `ignoreLoop = true`, and at the threshold emit `queueEnd` and schedule leave as
   currently designed.

### Bus Primitives

| Primitive                    | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `BUS_REQUEST` / `BUS_OUTPUT` | Long-running workflows such as connection changes, preloading, and resource refresh |
| `PLAYER_ACTION`              | Serialized, priority-queued mutations with an `AbortSignal`                         |
| `PLAYER_RPC`                 | Player-facing request/response operations, synchronous or asynchronous              |
| `CONTROLLER_RPC`             | Private controller-to-controller request/response                                   |
| `PLAYER_QUERY`               | Player state inspection, synchronous or asynchronous                                |
| `BUS_EVENT`                  | Typed internal events shared across controllers                                     |

Use an existing contract before adding another. When adding a contract, update `BusContract.ts`, the corresponding types in
[`src/types/bus.ts`](src/types/bus.ts), its registration/handler, and focused tests.

### Controller Ownership

| Controller                                 | Owns or coordinates                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ConnectionController`                     | Discord voice connections, joining, reconnecting, and connection status            |
| `QueueController`                          | Queue, history, current track, loop mode, autoplay, and queue events               |
| `FilterController`                         | Filter engines, FFmpeg processes, and filter rollback                              |
| `PlaybackController`                       | Audio players, audio resources, buffering/idle/playing state, fades and crossfades |
| `PlaybackPlayController`                   | `play()` workflow, search, play hooks, and TTS query handling                      |
| `PlaybackStartController`                  | Playback session startup, failure count, controlled skip, and `trackStarted`       |
| `PlaybackSkipController`                   | Skip, transition lock, fadeout, and autoplay fallback                              |
| `PlaybackSeekController`                   | Seek validation, timeouts, stream recreation, and pipe seeking                     |
| `PlaybackPreparationController`            | Related-track selection, `willNext`, `willPlay`, and preload preparation           |
| `TrackLoader` / `TrackResolverController`  | Stream resolution and recovery through plugins, extensions, and stream managers    |
| `PreloadManager`                           | Upcoming-track preloads, promotion, and broken-stream cleanup                      |
| `AntiStuckController`                      | Stalled buffering detection, recovery, and skip fallback                           |
| `TransitionController`                     | Transition timing, genre-aware duration, and beat alignment                        |
| `VolumeController`                         | Volume range/scaling and loudness normalization                                    |
| `ForwardController`                        | Leader/follower stream mirroring and follower health                               |
| `LifecycleController`                      | Inactivity timers and leave scheduling                                             |
| `SearchController`                         | Extension/plugin search and LRU cache                                              |
| `PluginController` / `ExtensionController` | Plugin registration and extension lifecycle hooks                                  |
| `SaveController`                           | Track audio saving with filter and seek options                                    |
| `PlayerEventBridge`                        | Mapping internal Bus events to public player/manager events                        |
| `PlayerEventTrace`                         | Structured event telemetry and latency tracing                                     |

### Playback and Recovery Flow

1. `player.play()` rejects mutations in forward mode, creates a play generation and abort signal, then dispatches the play RPC.
2. The play controller invokes extension hooks, searches through the search controller when given a string, and resolves a track.
3. The start controller replaces the active session, emits loading, resolves a stream, starts the audio resource, emits
   `trackStarted`, then asks preparation to compute the next track and preload.
4. If startup fails, emit `trackError` and increment the consecutive-failure count. Below the configured threshold, skip with loop
   ignored. At the threshold, reset the count, emit `queueEnd`, and schedule leave.

Autoplay preparation uses the last played track as the related-track source when available, otherwise the active session track.
Exclude the source track and tracks already queued. When autoplay is disabled, an empty queue means `willNext` is `null`; do not
substitute a related track. When autoplay is enabled and the queue is empty, select from related tracks and emit `willPlay`.

### Forward Mode

- Subscription validates the follower's voice connection/player, stops independent follower playback, subscribes its voice
  connection to the leader audio player, then sets `PlaybackMode.FORWARD` and emits `forwardModeStart`.
- The leader's track and playback events are mirrored to followers.
- Followers cannot call mutating playback methods (`play`, `playNext`, `pause`, `resume`, `stop`, `seek`, `skip`, `previous`,
  `insert`, `clearQueue`, `setVolume`). Preserve this guard in facade and controller paths where needed.

### Teardown Order

Managed teardown must be idempotent and follow this order:

1. `player.destroy()` delegates to `PlayerManager` when managed.
2. The manager calls `player.abortWorkflow()` to prevent new work, abort pending play, and dispose the action executor.
3. The manager detaches shared controller slots, including connection, playback, filters, queue, and forwarding state.
4. `player.completeDestroy()` releases extension references, publishes the destroyed event, emits `playerDestroy`, and disposes
   Bus subscriptions.

Do not bypass manager teardown or dispose Bus subscriptions before controller detach.

## Core Development Checks

Follow the owning controller when changing behavior. Keep changes local, update relevant types/contracts when the public or Bus
API changes, and add focused tests for the affected behavior.

```powershell
npm run build --prefix core
node --test tests/player_facade_migration.test.js
npm test
```

The Node.js built-in test runner is used. Run the focused test for the changed slice first; run the full suite for broader
changes. Build output in `core/dist/` is generated and must not be edited by hand.
