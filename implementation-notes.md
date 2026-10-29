# ZiPlayer AudioEngine Implementation Notes

## A. Confirmed Findings

### 1. Silent Dropping and Concurrency Race in `TTSController`

- **Component**: `core/src/controller/TTSController.ts`
- **Defect**: When multiple TTS requests were received sequentially or concurrently, the existing implementation did
  `if (state.running) return state.running;`.
- **Reproduction**: When request A started playing, and request B arrived, request B immediately returned request A's Promise.
  Request B was never queued, never resolved, and never spoken.
- **Coverage**: Existing tests in `tests/tts_playback_routing.test.js` only checked that a single TTS track routed to `ttsPlay`
  RPC, but failed to assert queue behavior for concurrent or sequential requests.

### 2. Music Skipping During Active TTS Playback

- **Component**: `core/src/controller/PlaybackSkipController.ts`, `core/src/structures/Player.ts`
- **Defect**: In `PlaybackSkipController.doSkip()`, invoking the public `skip()` API operated unconditionally on the underlying
  music session (`this.currentSession()`). When TTS was actively playing over a ducked/paused music track, calling `player.skip()`
  did not cancel the TTS utterance, but instead skipped and ended the underlying music session.
- **Defect**: In `Player.ts`, `skip()` unconditionally called `this.invalidatePlay()`, aborting `this.playAbortController`. This
  aborted in-flight TTS calls and would cancel queued TTS utterances instead of skipping only the active utterance.
- **Reproduction**: Start music track, invoke `player.play("tts:hello")`, invoke `player.skip()`. The music track advanced in the
  queue while the TTS utterance kept playing.

### 3. Stale Session Resurrection on TTS Finish

- **Component**: `core/src/controller/TTSController.ts`
- **Defect**: `TTSController` blindly unpaused `state.audioPlayer` in its `finally` block if `wasPlaying` was true when TTS
  started, without checking whether the underlying playback session was replaced, ended, or stopped during TTS playback.
- **Reproduction**: Start music track A, play TTS track, replace or stop music track A with track B, wait for TTS to finish. Track
  A was unpaused in `audioPlayer` despite having been replaced.

### 4. Browser Client Autoplay Rejection and Lack of Resume/Unlock

- **Component**: `client/browser/index.js`
- **Defect**: In `createAudioOutput()`, `await context.resume()` unconditionally rejected `connect()` if invoked without prior
  user gesture in environments enforcing browser Autoplay policies (including Electron and Tauri WebViews).
- **Defect**: `WebAudioClient` lacked explicit `resume()` and `unlockAudio()` methods, preventing applications from recovering
  from audio suspension upon user click without tearing down and reconnecting the entire WebSocket connection.
- **Defect**: Unreachable dead code in `receiveOpusFrame()` (dispatch after return).

### 5. `Player.play()` False-Negative Return on Concurrent TTS Requests

- **Component**: `core/src/structures/Player.ts`
- **Defect**: `Player.play()` incremented `this.playGeneration` unconditionally (`const generation = ++this.playGeneration;`) and
  checked `if (generation !== this.playGeneration || combinedSignal.aborted) return false;` after RPC completion.
- **Reproduction**: Calling `player.play("tts:A")` immediately followed by `player.play("tts:B")` caused request B to increment
  `this.playGeneration`. When request A completed playing via the FIFO queue, its `generation` no longer matched
  `this.playGeneration`, causing `player.play("tts:A")` to return `false` despite audio having played successfully.

### 6. `WebAudioClient` TypeScript Declaration Incompatibility with `EventTarget`

- **Component**: `client/index.d.ts`
- **Defect**: `WebAudioClient` declared generic `addEventListener` and `removeEventListener` signatures without overload
  declarations matching base `EventTarget` (`(type: string, callback: EventListenerOrEventListenerObject | null, ...)`).
- **Reproduction**: Compiling TypeScript projects importing `WebAudioClient` with strict types triggered `error TS2416` and
  `error TS2322`.

### 7. `unlockAudio()` Ineffective When Called Prior to `connect()`

- **Component**: `client/browser/index.js`
- **Defect**: `unlockAudio()` only checked `if (this.audioContext)` and was a no-op if called before `connect()`. Furthermore,
  `connect()` unconditionally ran `if (this.socket || this.audioContext) await this.disconnect();`, closing any existing unlocked
  `AudioContext` and creating a new one outside the synchronous user interaction gesture.

---

## B. Implementation Decisions

### 1. Per-Player Sequential FIFO TTS Queue

- Implemented an isolated FIFO queue in `TTSController` (`queue: TTSQueueItem[]`).
- Each queued utterance receives an independent lifecycle token, independent `AbortController`, and dedicated completion Promise
  (`resolve`, `reject`).
- Sequential queue processor `runWorker()` executes utterances in strict `A -> B -> C` order with a single worker promise per
  player.
- If an utterance fails (e.g. stream resolution error), the rejection settles that utterance's promise while the worker safely
  advances to the next queued utterance.

### 2. Integrated TTS Skip Architecture

- Added `CONTROLLER_RPC.ttsSkip` (`"controller.tts.skip"`) and `PLAYER_QUERY.ttsIsActive` (`"tts.isActive"`).
- In `PlaybackSkipController.doSkip()`:
  - Skip checks whether TTS is active via `CONTROLLER_RPC.ttsSkip`.
  - If TTS is active (in preparation phase, playing audio, or pending in queue), `ttsSkip` aborts the current utterance and
    returns `{ skipped: true }`.
  - If another utterance is queued, playback immediately advances to the next utterance.
  - If no more utterances are queued, TTS terminates cleanly and restores the underlying playback state.
  - Underlying music is untouched (`doSkip` returns `true` without touching the music queue).
  - If TTS is not active, standard music track skipping proceeds unaffected.
- Preparation race condition: If a skip arrives while an utterance is resolving its stream (status `"preparing"`), the utterance's
  `AbortController` triggers, aborting the resolver and rejecting the utterance promise with an `AbortError`, returning
  `{ skipped: true }` so music is never skipped.

### 3. Playback Restoration and Session Ownership

- When the first TTS utterance begins in an empty queue, `TTSController` records:
  - `wasMusicPlaying`: boolean flag from `audioPlayer.state.status === AudioPlayerStatus.Playing`.
  - `interruptedSessionId`: string identifier of the active `PlaybackSession`.
  - It pauses music and redirects the voice connection to `ttsPlayer`.
- During transitions between consecutive queued TTS utterances, music is not unpaused, preventing audio glitching/flicker.
- When the queue drains completely:
  - Voice connection is restored to the player's `audioPlayer`.
  - Only if `wasMusicPlaying` was true, the player is not disposed, AND the current music session's `sessionId` matches
    `interruptedSessionId`, `audioPlayer.unpause()` is called.
  - If the music session ended or was replaced while TTS played, the obsolete track is never resumed.

### 4. Player Facade (`Player.ts`) Concurrency Isolation

- In `Player.play()`:
  - Queries are inspected with `isTTSQuery()`.
  - For music queries, `this.playAbortController` is aborted to cancel superseded track loads, and `this.playGeneration` is
    incremented.
  - For TTS queries:
    - `this.playAbortController` is NOT aborted, allowing sequential and concurrent `player.play("tts:...")` requests to enter the
      `TTSController` queue without mutual cancellation.
    - `this.playGeneration` is NOT incremented (`const generation = isTTS ? 0 : ++this.playGeneration;`), and completion checks
      skip generation matching (`if ((!isTTS && generation !== this.playGeneration) || combinedSignal.aborted) return false;`),
      ensuring that all queued TTS requests return their valid `PlayResult` once spoken.
- In `Player.skip()`:
  - Skip checks `PLAYER_QUERY.ttsIsActive`. If active, `this.invalidatePlay()` is skipped so subsequent queued TTS utterances are
    preserved.

### 5. Desktop Audio Support (Electron & Tauri)

- Added `workletUrl` option to `WebAudioClient` to allow loading AudioWorklet processor files directly in strict CSP environments
  where `blob:` is disallowed.
- Added `resume()` and `unlockAudio()` methods on `WebAudioClient` to recover from `suspended` state following user gesture.
- `unlockAudio()` initializes and resumes the `AudioContext` and plays a silent buffer if called prior to `connect()`.
- `connect()` reuses any existing, active `AudioContext` instead of tearing it down, flushing pending worklet frames and ensuring
  pre-unlocked audio state remains intact.
- In `createAudioOutput()`, catch Autoplay `NotAllowedError` / suspended state during initial connect, dispatching a `"suspended"`
  event rather than terminating `connect()`.
- Implemented socket listener cleanup on `disconnect()` and socket closure to prevent listener accumulation on repeated
  connect/disconnect cycles.
- Added base `EventTarget` overloads to `addEventListener` and `removeEventListener` in `client/index.d.ts` for strict TypeScript
  compilation.

---

## C. Trade-offs

1. **Internal RPC vs Direct Controller State Access**:
   - _Choice_: Used `CONTROLLER_RPC.ttsSkip` and `PLAYER_QUERY.ttsIsActive` on the `Bus`.
   - _Rationale_: Preserves controller isolation and complies with ZiPlayer architecture rules ("sibling controllers talk only
     through Bus queries/RPCs — never by holding a direct reference").
   - _Alternative Considered_: Directly referencing `TTSController` inside `PlaybackSkipController` was rejected because it
     violates repository conventions and tightly couples controllers.

2. **FIFO Worker vs Pipeline Buffering**:
   - _Choice_: Sequential single-worker execution with stream resolution right before playback.
   - _Rationale_: Guarantees that cancelled or skipped pending utterances do not leak active audio streams or decode resources.

3. **Autoplay Handling in Desktop WebViews**:
   - _Choice_: Establish the WebSocket and Web Audio graph on `connect()`, dispatching `"suspended"` if the platform requires a
     user gesture.
   - _Rationale_: Allows applications to connect early (e.g. at app launch) and unlock audio on the first user click via
     `client.unlockAudio()`.

---

## D. Compatibility

### 1. Browser Requirements

- Web Audio API (`AudioContext`, `AudioWorkletNode`).
- WebAssembly (`WebAssembly.instantiate` / `WebAssembly.compile`).
- Sample rate: 48 kHz.

### 2. Electron Requirements

- Runs directly inside Chromium Renderer process.
- Compatible with `contextIsolation: true` and `nodeIntegration: false`.
- Preload script does not need to expose private audio internals.

### 3. Tauri Requirements

- Compatible with Wry (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS).
- Required CSP directives in `tauri.conf.json`:
  - `connect-src 'self' ws: wss:;`
  - `script-src 'self' 'wasm-unsafe-eval' blob:;` (or supply custom `workletUrl` if `blob:` is omitted).
  - `worker-src 'self' blob:;`

---

## E. Validation

### 1. Commands Executed

- `npm run build:core:fast`: Built core TypeScript into `dist/` (passed, 180ms).
- `node --test tests/tts_queue_skip_lifecycle.test.js`: Ran all 9 new TTS queue, skip, and lifecycle regression tests (passed,
  10.8s).
- `npm test --prefix client`: Ran all 29 browser and desktop compatibility tests in client package (passed, 241ms).
- `npm run test:integration`: Ran all 13 plugin and extension integration tests (passed, 4.3s).
- `node --test tests/*.test.js`: Ran all root test suites (236 passed, 0 failed, 2 skipped across 44 test files).
- `git diff --check`: Verified no whitespace errors or leftover markers.

### 2. Real-Runtime Desktop Checks Not Performed

- Unit and integration tests validate the browser client using mock Web Audio and WebSocket environments.
- Real-runtime end-to-end testing with a live GUI window in Electron binary packaging or compiled `cargo tauri dev` was not
  executed in this headless CLI environment; verification procedures are documented in `examples/desktop/README.md`.

---

## F. Removal of FFmpegAudioProcessingEngine and Architectural Simplification

### 1. Reason for Removal

`FFmpegAudioProcessingEngine` previously introduced an intermediate child-process FFmpeg pipeline in `PlaybackController` for
every track played when enabled. This had several architectural issues:

- **Redundant transcoding**: Even when tracks were already encoded Opus or were already processed by `FilterController`, they were
  piped through a second FFmpeg child process before reaching `createAudioResource`.
- **Process overhead and latency**: Normal playback required spawning child processes, setting up IPC pipes, and managing process
  concurrency limits.
- **Architectural duplication**: `FilterController` already owns the FFmpeg-based audio filtering capabilities and real-time
  filter chains, making a second general-purpose FFmpeg processing engine redundant.
- **Complexity and failure modes**: Stalled stdin/stdout pipes, orphan process tracking, and generator abort races added
  significant operational fragility.

### 2. Ownership of Filtering and Resource Creation

- **Normal Playback (No Filter)**: `Track / StreamInfo` → `TrackLoader / Plugin` → `PlaybackStartController` → `StreamController`
  → `PlaybackController.createResource()` → `@discordjs/voice` `createAudioResource()` → `AudioPlayer` → Subscribers (Discord
  Voice, `WebAudioConnection`).
  - No FFmpeg process is spawned solely for audio playback.
  - The original stream feeds directly into the resource pipeline.
  - Inline volume handling is managed by `@discordjs/voice` via its native Opus / PCM transformation.
- **Filtered Playback (Filter Active or Non-Seekable Stream Seek)**: `PlaybackStartController` detects active filters
  (`filterString` query) and routes the stream through `FilterController` (`FilterEngine.applyFiltersAndSeek()`).
  - `FilterController` spawns a single FFmpeg process executing the requested filter graph (`-af <graph>`).
  - Output is encoded to Opus in an Ogg container (`-c:a libopus -f opus -ar 48000 -ac 2`) with `inputType: StreamType.OggOpus`.
  - When seeking on a stream providing `streamInfo.recreate(position)`:
    - If no filters are active, the recreated stream is passed directly without spawning FFmpeg (`wasRecreated: true`).
    - If filters are active, the recreated stream is processed through FFmpeg with `-af <graph>` but omitting redundant `-ss`
      (since `recreate` already starts at the target offset).
  - Initial filters (`PlayerOptions.filters`) are registered synchronously at player creation without requiring an active audio
    resource, ensuring filters persist before the first track plays.
  - The filtered stream enters `StreamController` and is handed to `PlaybackController.createResource()`, which creates an
    `AudioResource` without any second FFmpeg stage.
- **Save / Export Operations**:
  - `SaveController` maintains its own isolated `FilterEngine` instance for offline stream filtering and export, completely
    independent of the live playback resource path.

### 3. Removed Public Configuration Options and APIs

- **Removed Public APIs**:
  - `createAudioProcessingEngine`
  - `defaultAudioProcessingEngine`
  - `FFmpegAudioProcessingEngine`
  - `resolveAudioProcessingOptions`
  - `getFfmpegProcessStats`
  - `configureFfmpegConcurrency`
  - `AudioFrameFormat`
  - Types: `AudioProcessingEngine`, `AudioProcessingPipeline`, `AudioProcessingOptions`, `AudioProcessingContext`,
    `AudioProcessingFormat`, `AudioProcessingInputFormat`, `AudioProcessingOutputFormat`, `AudioProcessingHint`
- **Removed Configuration Options**:
  - `PlayerOptions.audioProcessing` (and `PlaybackControllerOptions.audioProcessing`)
  - Sub-options: `audioProcessing.enabled`, `audioProcessing.inputFormat`, `audioProcessing.outputFormat`,
    `audioProcessing.sampleRate`, `audioProcessing.channels`, `audioProcessing.gainDb`, `audioProcessing.gainLinear`,
    `audioProcessing.highpassHz`, `audioProcessing.lowpassHz`, `audioProcessing.normalize`, `audioProcessing.resampleRate`,
    `audioProcessing.maxBufferBytes`, `audioProcessing.ffmpegInputFormats`, `audioProcessing.encodedBitrate`,
    `audioProcessing.encodedApplication`, `audioProcessing.maxInputBytes`, `audioProcessing.maxDurationMs`,
    `audioProcessing.stallTimeoutMs`, `audioProcessing.ffmpegThreads`, `audioProcessing.maxConcurrentProcesses`.
- **Preserved Options**:
  - `PlayerOptions.ffmpegPath`: Shared setting used by `FilterController` and `SaveController` to locate the FFmpeg executable.
  - `PlayerOptions.loudnessNormalization`: High-level volume leveling managed entirely in software by `VolumeController` (inline
    volume target scaling), independent of FFmpeg.
  - `PlayerOptions.volume`: Shared player volume.

### 4. DSP Features and Behavior Changes

- Static DSP flags on the removed engine (`gainDb`, `gainLinear`, `highpassHz`, `lowpassHz`, `normalize`) are no longer configured
  via `audioProcessing`.
- Equivalent filtering is available dynamically through `player.filter.applyFilter()` / `player.filter.applyFilters()` (e.g.
  `bassboost`, `loudnorm`, `highpass`, `equalizer`, custom filter graphs validated by `isSafeCustomFilter`).

### 5. When FFmpeg Starts

FFmpeg processes are started **only** in the following circumstances:

1. When active filters are applied to a player (`player.filter.applyFilter()` or initial filters specified in
   `PlayerOptions.filters`).
2. When seeking on a non-seekable Readable stream where the plugin does not provide `recreate(position)`.
3. When saving/exporting audio with active filters via `SaveController`.
4. When `@discordjs/voice` internally transcodes an arbitrary non-Opus stream (e.g. raw MP3) to PCM via `prism-media` during
   inline-volume resource creation.

FFmpeg is **never** started for standard playback of Opus streams without filters.

### 6. Format Compatibility and Resource Contract

- Direct encoded streams (`StreamType.Opus`, `StreamType.WebmOpus`, `StreamType.OggOpus`, `StreamType.Arbitrary`) retain their
  source type.
- Raw audio inputs (`StreamType.Raw`) are explicitly rejected before resource creation with
  `TypeError("Raw audio input is unsupported; provide encoded audio")`, destroying the input stream.
- Filter output is consistently formatted as `StreamType.OggOpus` (48 kHz, stereo) via FFmpeg `libopus`, allowing downstream
  `@discordjs/voice` demuxing and inline volume transformation without further conversion.
- Both Discord Voice and `WebAudioConnection` subscribe directly to `@discordjs/voice` `AudioPlayer` and receive Opus packets.
