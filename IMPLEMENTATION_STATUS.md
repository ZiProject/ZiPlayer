# Multi-output implementation status

## Implemented

- Native Opus playback is the preferred path for discrete Opus packets: a single `AudioResource` feeds the shared Discord `AudioPlayer`, and WebSocket listeners receive the same packets through `WebAudioConnection` subscriptions. The subscriber does not add a second stream reader or DSP/FFmpeg process.
- `Player.connect(webConnection)` registers and removes that subscription; stopping one track updates speaking state without disconnecting the reusable connection. A new track can reuse the same connection.
- `MultiAudioOutputBackend` remains available for stream-consuming outputs and processing workflows. It fans one per-track processed stream to registered handles with bounded secondary queues, pacing selection, drop metrics, and coordinated controls.
- Preserved `player.connect(voiceChannel)`, dynamic `player.connect(backend, { id?, name? })`, `player.disconnectOutput(id)`, and `player.getAudioOutputs()`. The removed initial-output factory is not part of `PlayerOptions`.
- Browser WebSocket output is Opus-only through `WebAudioConnection`. PCM remains available internally to DSP and audio codecs but is not a browser wire format.
- Native Opus resource creation and Ogg/WebM demuxing validate packet framing and duration without spawning FFmpeg. Source ownership is explicit (`transfer` by default, or `borrow`); closing either side of a validator/demuxer pipe releases the opposite side appropriately.
- Legacy browser frames remain supported only for an explicitly negotiated `protocolVersion: 0`; missing versions normalize to v1. Opus framing validation enforces the 1,275-byte per-frame maximum for all framing codes.
- Player volume defaults to the initial output/Discord sink. Dynamically registered stream outputs default to `playerVolume: false`.
- The wider stream-processing implementation also retains its FFmpeg input protections: executable selection, per-engine concurrency limits, redirect-by-redirect URL validation with DNS address pinning, and rejection of unsafe direct FFmpeg URL input.

## Design decisions and trade-offs

- **Native subscriber vs. custom stream sink:** `WebAudioConnection` uses the shared `AudioPlayer` subscriber path for Opus. Custom stream-consuming outputs remain dynamically attachable through `player.connect(backend)`; there is no built-in PCM-over-WebSocket backend.
- **Late joining and format negotiation:** stream-consuming custom sinks begin at the current position and are not backfilled. Their accepted formats determine whether they can join an active session.
- **Volume:** `Player.volume` goes to outputs registered with `playerVolume: true`. This is enabled for the initial/Discord output and disabled by default for dynamic outputs.
- **Transitions:** a Discord + WebSocket combination reports `replacement: "stop-before-start"`, not `"atomic"`; seek is unsupported in the combined capability set. Transition logic cannot overlap old and new tracks in this configuration: the old output stops before the new one starts, and the new track may fade in from zero. This is not a true atomic crossfade.
- **Unsafe URL mode:** `allowFfmpegUrlInput` now fails validation; callers should use the safe Node HTTP input path so redirects and resolved addresses are checked.

## Verification performed

The repository's available native core build and targeted tests were run with installed dependencies. Browser protocol tests were also run directly. These validate local behavior but are **not** a substitute for a real Discord voice connection or deployment environment.

| Check | Result | Scope / limitation |
|---|---:|---|
| `npm run build:core` | Passed | CJS, ESM, and declaration build |
| `npm test` | 279 passed, 3 failed, 2 skipped | Latest run; two output-timing assertions failed in existing stress/integration tests, and partial-metadata normalization currently fails because its implementation edit is blocked by an editor-mapped file |
| `node --test client/test/protocol.test.js` | 14/14 passed | Browser protocol negotiation and frame parsing |
| `node --test --test-name-pattern="validator and demuxer close" tests/stream_and_metadata_regressions.test.js` | 1/1 passed | Upstream source close propagates to validator and Ogg/WebM demuxer |
| WebSocket stop/replay, source ownership, replacement, and Opus frame-size regressions | Passed in the preceding full run | Resource and query playback; transfer/borrow lifecycle |
| Partial `AudioResource` metadata normalization | Regression test added; implementation pending | Current `Player.ts` is open with a Windows user-mapped section, so the OS rejects writes to that file. The test reproduces missing `Track.id`; close the editor's mapped file to allow the surgical fix and rerun. |
| CPU / peak RAM / end-to-end latency benchmark | Not measured | No performance claim is made |

## Not verified yet

- Real Discord Voice/UDP subscription readiness and AutoPaused behavior; real gateway routing to multiple browser subscribers.
- Windows runtime, true crossfade/transition behavior, real YouTube sources, and 100-track replacement stress testing for process leaks and RAM stability.

Do not treat this implementation as production-verified until the outstanding checks above are run with the project's real dependencies and deployment environment.
