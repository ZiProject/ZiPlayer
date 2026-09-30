# ZiPlayer Core Architecture & AI Agent Guide

> **Notice for AI Assistants**: This document is an authoritative, in-depth architectural blueprint and behavioral specification
> for the `core/` package of ZiPlayer. Any changes you make to `core/src/**` MUST adhere to the invariants, contracts, and design
> patterns specified herein.

---

## 1. Architectural Philosophy & Hard Invariants

### 1.1 The Global Bus & Distributed Controller Architecture

Prior to refactoring, ZiPlayer had a monolithic `Player_old.ts` (3,300+ lines) where every player instance owned its own queue,
plugins, extensions, voice connection, audio player, and filters.

The new architecture decouples this into three distinct layers:

1. **`PlayerManager` (Process-Wide Coordinator)**:
   - Owns a single global instance of `Bus`.
   - Instantiates process-wide singleton controllers via `ensureSharedControllers()`.
   - Maps `playerId` (guildId) to `Player` facade instances.
   - Coordinates multi-step asynchronous teardown.
2. **`Bus` (Unified Event, Action, RPC, and Query Highway)**:
   - Connects controllers to each other and to the `Player` facade.
   - Handles 5 distinct communication primitives: `BUS_REQUEST/BUS_OUTPUT`, `PLAYER_ACTION`, `PLAYER_RPC`, `CONTROLLER_RPC`, and
     `PLAYER_QUERY`.
3. **Shared Controllers (`core/src/controller/**`)\*\*:
   - **Singleton Pattern**: A controller is created **once** for the entire Node.js process and shared across all guilds.
   - **Per-Player Slots**: Each controller stores per-player state in an internal `Map<playerId, Slot>` (e.g.
     `slots.get(playerId)`).
   - Controllers attach state when a player is created (`attach(playerId, options)`) and release state when destroyed
     (`detach(playerId)`).
4. **`Player` (`core/src/structures/Player.ts`)**:
   - **Lightweight Facade Proxy**: `Player` holds **no internal queue, no audio player, no voice connection, and no filter
     state**.
   - Every getter and method delegates directly to the Bus (`bus.querySync`, `bus.requestRpc`, `bus.action`, `bus.subscribe`).

### 1.2 Non-Negotiable Hard Invariants

1. **NEVER Edit `core/dist/` Directly**:
   - `core/dist/` is generated output. Always edit TypeScript sources in `core/src/**` and compile using
     `npm run build --prefix core`.
2. **NEVER Store Guild State in `Player.ts`**:
   - Any mutable playback, queue, audio, or filter state must belong to its respective controller. `Player.ts` must remain a pure
     facade.
3. **Preserve `querySync` Synchronicity**:
   - `bus.querySync()` and `bus.requestRpcSync()` MUST return immediate, non-Promise values. If a handler returns a Promise,
     `Bus.ts` will throw: `Query "..." is asynchronous; use query() instead`.
4. **Serialize Mutating Playback Commands**:
   - All state-mutating commands (`PLAY`, `PAUSE`, `RESUME`, `SEEK`, `STOP`, `SKIP`, `SET_VOLUME`) MUST be dispatched through
     `PlayerActionExecutor` (`this.action(...)` or `bus.action(...)`) to guarantee sequential FIFO execution and prevent race
     conditions.
5. **Enforce FORWARD Mode Guards**:
   - When a player is subscribed to another player as a follower (`playbackMode === PlaybackMode.FORWARD`), it MUST NOT mutate
     playback. Facade methods (`play`, `playNext`, `pause`, `resume`, `stop`, `seek`, `skip`, `previous`, `insert`, `clearQueue`,
     `setVolume`) MUST return `false` (or return early) and log a debug message.
6. **Controlled Error Recovery**:
   - When a track fails to start, the player must never freeze in an idle limbo. Follow the controlled skip threshold
     (`consecutiveFailures >= controlledSkipThreshold`) to emit `queueEnd` and leave, or skip with `ignoreLoop = true`.

---

## 2. Bus Communication Primitives

The Bus contract is defined in [`core/src/structures/BusContract.ts`](file:///e:/GIT/ZiPlayer/core/src/structures/BusContract.ts)
and typed in [`core/src/types/bus.ts`](file:///e:/GIT/ZiPlayer/core/src/types/bus.ts).

### 2.1 Communication Channels

```
┌────────────────────────────────────────────────────────────────────────────┐
│                               Player Bus                                   │
├────────────────────┬───────────────────────────────────────────────────────┤
│ Primitive          │ Semantic & Characteristics                            │
├────────────────────┼───────────────────────────────────────────────────────┤
│ BUS_REQUEST        │ Asynchronous, long-running workflow input             │
│ BUS_OUTPUT         │ Intermediate progress & terminal output events        │
│ PLAYER_ACTION      │ Serialized, priority-queued mutating commands         │
│ PLAYER_RPC         │ Public request-response operations (Sync or Async)    │
│ CONTROLLER_RPC     │ Private controller-to-controller request-response     │
│ PLAYER_QUERY       │ Instantaneous, synchronous state inspection           │
│ BUS_EVENT          │ Typed internal event stream across controllers        │
└────────────────────┴───────────────────────────────────────────────────────┘
```

1. **`BUS_REQUEST` & `BUS_OUTPUT`**:
   - Used for long-running I/O operations: `connectionConnect`, `connectionDisconnect`, `connectionReconnect`, `preloadRequest`,
     `resourceRefresh`.
   - Handled via `bus.request(playerId, request, options)` which returns a Promise resolving on successful output.
2. **`PLAYER_ACTION`**:
   - Enqueued through `PlayerAction.ts` (`actionExecutor.enqueue(action)`).
   - Priority levels: `CRITICAL` (100: STOP, SKIP), `HIGH` (50), `NORMAL` (10), `BACKGROUND` (0).
   - Executed sequentially with an `AbortSignal`.
3. **`PLAYER_QUERY`**:
   - Synchronous lookups executed via `bus.querySync(playerId, query)`.
   - Examples: `currentTrack`, `queue`, `queueSize`, `isPlaying`, `isPaused`, `volume`, `filterState`, `playbackMode`.
4. **`PLAYER_RPC` & `CONTROLLER_RPC`**:
   - Request-response mechanism.
   - Synchronous RPCs: `bus.requestRpcSync(playerId, rpcKey, payload)`.
   - Asynchronous RPCs: `bus.requestRpc(playerId, rpcKey, payload, { signal, timeoutMs })`.

---

## 3. Controller Ownership & Topology Matrix

The following table provides the exhaustive map of controllers, their files, and their exact state ownership:

| Controller Name                     | File Location                                          | Responsibility & State Owned                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ConnectionController`**          | `core/src/controller/ConnectionController.ts`          | Owns Discord `@discordjs/voice` `VoiceConnection`, joins voice channels, manages connection status, reconnects, auto-subscribes `AudioPlayer`, and detects disconnection.                    |
| **`QueueController`**               | `core/src/controller/QueueController.ts`               | Owns the track queue (`tracks[]`), playback history (`history[]`), `currentTrack`, `loopMode`, `autoPlay` flag, and directly emits queue events (`queueAdd`, `queueAddList`, `queueRemove`). |
| **`FilterController`**              | `core/src/controller/FilterController.ts`              | Owns `FilterEngine` instances, real-time FFmpeg child processes, audio filter chains, and executes `applyFiltersAndSeek` with rollback support on failure.                                   |
| **`PlaybackController`**            | `core/src/controller/PlaybackController.ts`            | Owns `@discordjs/voice` `AudioPlayer` instances, creates `AudioResource`, tracks audio buffering/idle/playing states, and executes crossfades and volume fading.                             |
| **`PlaybackPlayController`**        | `core/src/controller/PlaybackPlayController.ts`        | Handles `player.play()`, queries `SearchController`, invokes `beforePlay` and `afterPlay` extension hooks across all 5 branches, and handles TTS queries.                                    |
| **`PlaybackStartController`**       | `core/src/controller/PlaybackStartController.ts`       | Spawns `PlaybackSession`, manages `consecutiveFailures` counter, handles `controlledSkipThreshold` (3) to skip or schedule leave on failure, emits `trackStarted`.                           |
| **`PlaybackSkipController`**        | `core/src/controller/PlaybackSkipController.ts`        | Executes skip with optional target `index`, acquires transition lock, applies fadeout, and triggers autoplay fallback when queue is empty.                                                   |
| **`PlaybackSeekController`**        | `core/src/controller/PlaybackSeekController.ts`        | Validates position, manages seek timeouts (65s outer timeout), and triggers stream recreation or FFmpeg pipe seeking.                                                                        |
| **`PlaybackPreparationController`** | `core/src/controller/PlaybackPreparationController.ts` | Computes autoplay next track, resolves related tracks from `previousTracks.at(-1) ?? session.track`, emits `willPlay` with full arguments.                                                   |
| **`TrackLoader`**                   | `core/src/structures/TrackLoader.ts`                   | Resolves playable streams through plugins, manages stream recovery slots, and immediately skips unrecoverable errors (`UNRECOVERABLE_NO_PLUGIN`, `No stream available`).                     |
| **`TrackResolverController`**       | `core/src/controller/TrackResolverController.ts`       | Routes stream resolution requests to `StreamManager`, `PluginManager`, and `ExtensionManager`.                                                                                               |
| **`PreloadManager`**                | `core/src/structures/PreloadManager.ts`                | Preloads upcoming tracks into memory, promotes preloaded streams to active resources, and cleans up broken streams.                                                                          |
| **`AntiStuckController`**           | `core/src/controller/AntiStuckController.ts`           | Monitors stalled buffering states (`stuckTimeoutMs = 10000ms`), attempts track recovery, and triggers skip if unrecoverable.                                                                 |
| **`TransitionController`**          | `core/src/controller/TransitionController.ts`          | Computes transition plans: base duration (1000ms), genre-aware durations, min/max durations (600ms..8000ms), and beat alignment wait time (700ms).                                           |
| **`VolumeController`**              | `core/src/controller/VolumeController.ts`              | Clamps volume (0%..200%), calculates volume scaling targets, and executes LUFS loudness normalization with soft limiter.                                                                     |
| **`ForwardController`**             | `core/src/controller/ForwardController.ts`             | Coordinates multi-guild stream mirroring: followers subscribe to leader's `AudioPlayer`, mirrors all events (`trackStart`, `pause`, `volume`), and tracks leader health.                     |
| **`LifecycleController`**           | `core/src/controller/LifecycleController.ts`           | Manages voice channel inactivity: `leaveTimeout = 0` (disabled), schedules leave on `queueEnd`, verifies idle state before disconnecting with `"leave-timeout"`.                             |
| **`SearchController`**              | `core/src/controller/SearchController.ts`              | Two-tier search with LRU caching: delegates first to extensions (`provideSearch`), then to plugins (`pluginManager.search`), and stores cached results.                                      |
| **`PluginController`**              | `core/src/controller/PluginController.ts`              | Manages plugin registrations, queries available plugins, and resolves related tracks via `pluginRelatedTracks`.                                                                              |
| **`ExtensionController`**           | `core/src/controller/ExtensionController.ts`           | Manages extension lifecycle, registers `extensionBeforePlay` and `extensionAfterPlay` RPCs.                                                                                                  |
| **`SaveController`**                | `core/src/controller/SaveController.ts`                | Pipes track audio to a stream for file saving, applying filters and seek offsets via dedicated `FilterEngine`.                                                                               |
| **`PlayerEventBridge`**             | `core/src/controller/PlayerEventBridge.ts`             | Subscribes to internal Bus events and maps them directly to public `Player` and `PlayerManager` EventEmitter events.                                                                         |
| **`PlayerEventTrace`**              | `core/src/controller/PlayerEventTrace.ts`              | Provides structured telemetry, event fingerprinting, and latency tracing across Bus operations.                                                                                              |

---

## 4. Key Subsystem Workflows & Edge Cases

### 4.1 Track Playback Lifecycle

1. **`player.play(query, requestedBy)` called**:
   - Checks `playbackMode !== PlaybackMode.FORWARD`.
   - Generates a new `playGeneration` and an `AbortController`.
   - Dispatches `PLAYER_RPC.play` to `PlaybackPlayController`.
2. **Search & Pre-processing**:
   - Executes `extensionBeforePlay` hook. If `handled: true`, terminates search early.
   - If query is a string, checks `SearchController` LRU cache. If missed, queries extensions then plugins.
   - Executes `extensionAfterPlay` hook.
3. **Session Startup (`PlaybackStartController.start`)**:
   - Replaces current session in `PlaybackSessionController`.
   - Emits `BUS_EVENT.trackLoading`.
   - Resolves stream via `TrackLoader`.
   - If audio player is ready, creates `AudioResource` and starts playback.
   - Resets `consecutiveFailures = 0`.
   - Emits `BUS_EVENT.trackStarted`.
   - Calls `prepareTrack()` in `PlaybackPreparationController` to compute related tracks, set `willNext`, and trigger preload.
4. **Error Handling & Controlled Skip**:
   - If `start()` throws:
     - Emits `BUS_EVENT.trackError`.
     - Increments `consecutiveFailures`.
     - If `consecutiveFailures >= controlledSkipThreshold` (3): resets counter, emits `queueEnd`, and calls
       `lifecycleScheduleLeave`.
     - Else: enqueues action `PLAYER_ACTION.skip` with `ignoreLoop = true`.

### 4.2 Autoplay & Related Tracks Workflow

- **Source Track Selection**: Related tracks are computed based on the track that just finished (`previousTracks.at(-1)`). Only on
  the very first track does it fall back to `session.track`.
- **Deduplication**: Filters out the source track and any tracks already in upcoming queue.
- **Autoplay Disabled**:
  - If `queueAutoPlay === false`: `willNext` is set to the next track in the queue (`queueNextTrack`). If the queue is empty,
    `willNext` is set to `null` (never set to a related track).
  - If `queueAutoPlay === true`: If the queue is empty, `willNext` selects randomly from the top 5 related tracks and emits
    `willPlay` with `(track, upcomingTracks, relatedTracks)`.

### 4.3 Forward Mode & Mirroring Invariants

- **Subscription**: When `follower.subscribeTo(leader)` is called:
  - Validates that follower has an active voice connection and audio player.
  - Gracefully stops follower's independent playback.
  - Subscribes follower's Discord voice connection directly to leader's `AudioPlayer`.
  - Sets `playbackMode = PlaybackMode.FORWARD`.
  - Emits `forwardModeStart(follower, leader)`.
- **Event Mirroring**: Leader's events (`trackStart`, `trackEnd`, `playerPause`, `playerResume`, `playerStop`, `volumeChange`) are
  mirrored onto all registered followers.
- **Mutation Guards**: Follower players cannot initiate playback actions. Methods `play`, `playNext`, `pause`, `resume`, `stop`,
  `seek`, `skip`, `previous`, `insert`, `clearQueue`, and `setVolume` are guarded and return `false`.

### 4.4 Teardown Sequence (Idempotent Destruction)

To prevent resource leaks and dangling voice connections, teardown must follow this exact order:

```
1. player.destroy() (Facade Entry)
   └── If managed: calls manager.requestDestroy(player) -> manager.destroy(playerId)
   └── If unmanaged: runs local abortWorkflow() + completeDestroy()

2. manager.destroy(playerId) (Manager Orchestration)
   ├── Step 1: player.abortWorkflow()
   │     ├── Sets player.destroyed = true
   │     ├── Aborts in-flight play generation (playAbortController.abort())
   │     └── Disposes player.actionExecutor
   ├── Step 2: Detach Shared Controllers (Idempotent)
   │     ├── connection.detach(playerId) (destroys voice connection)
   │     ├── playback.detach(playerId) (stops audio player & cancels watchdogs)
   │     ├── filter.detach(playerId) (terminates FFmpeg processes)
   │     ├── queue.detach(playerId) (clears queue & history)
   │     ├── forward.detach(playerId) (cleans follower links)
   │     └── other controllers detach their slots
   └── Step 3: player.completeDestroy()
         ├── Detaches extension back-references
         ├── Emits "playerDestroy" public event
         ├── Publishes BUS_EVENT.destroyed
         └── Disposes player bus subscriptions and slots
```

---

## 5. Development & Testing Reference

### 5.1 Compilation & Build

```powershell
# Build the TypeScript core package (runs tsup producing CJS, ESM, and DTS)
npm run build --prefix core

# Watch mode during active development
npm run dev --prefix core
```

### 5.2 Running Tests

The test suite runs using Node.js built-in test runner (`node:test`):

```powershell
# Run the entire test suite (110+ tests)
npm test

# Run specific test suites
node --test tests/player_facade_migration.test.js
node --test tests/playback_session_transition.test.js
node --test tests/queue.test.js
node --test tests/audio_subscription_lifecycle.test.js
```

### 5.3 Guidelines When Modifying Code

1. **Before Adding a Feature or Bugfix**:
   - Check which controller owns the domain logic. Do not put business logic into `Player.ts`.
   - Check if an existing Bus RPC, Query, or Action already covers the communication need.
2. **When Adding New Bus Contracts**:
   - Register the identifier in `core/src/structures/BusContract.ts` (`PLAYER_RPC`, `CONTROLLER_RPC`, `PLAYER_QUERY`, etc.).
   - Define the request/response types in `core/src/types/bus.ts` (`PlayerRpcMap`, `PlayerQueryMap`).
3. **Strict Validation**:
   - Always run `npm run build --prefix core` to ensure TypeScript strictness passes with zero errors and declaration files
     (`.d.ts`) generate cleanly.
   - Always run `npm test` to verify that no existing or migration tests regress.
