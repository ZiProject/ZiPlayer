# Multi-output implementation status

## Implemented

- Added `MultiAudioOutputBackend`, which fans one per-track processed stream out to multiple output handles; it does not create a second DSP/FFmpeg pipeline for each sink.
- Preserved `player.connect(voiceChannel)` and the `audioOutputBackendFactory` entry point. Added `player.connect(backend, { id?, name?, playerVolume? })`, returning a registration handle with `disconnect()`, plus `player.disconnectOutput(id)` and `player.getAudioOutputs()`.
- Allows sinks to join or leave during a live PCM track. A newly joined sink begins at the current stream position. A PCM-only WebSocket sink rejects an active encoded track because the existing stream cannot be transcoded retroactively.
- For subsequent tracks, an active WebSocket PCM sink selects s16le PCM, 48 kHz, stereo if those settings were not explicitly set. Explicit conflicting settings fail with an explanatory error.
- Selects a live pacing master. A ready Discord voice subscriber is preferred; an unavailable/autopaused Discord sink does not pace the stream ahead of a live secondary output. Secondary queues are bounded, excess whole chunks are dropped, and drop counters are reported by `getAudioOutputs()`.
- Propagates pause/resume/stop to all registered sinks; combines capabilities across sinks. A secondary sink error removes that sink and emits `streamError` rather than `trackError`; a pacing-master failure remains a track failure.
- Player volume defaults to the initial output/Discord sink. Dynamically registered outputs default to `playerVolume: false`, so browser PCM remains unchanged unless explicitly opted in.
- Corrected encoded output metadata to identify Ogg/Opus; fixed FFmpeg executable selection order and separated per-engine limits from the process-wide gate; rejected unsafe direct FFmpeg URL mode and added redirect-by-redirect URL validation with DNS address pinning.

## Design decisions and trade-offs

- **Late joining:** live PCM sinks can join at the current point. They are not backfilled. A sink that joins an encoded-only track and only accepts PCM is rejected; it may join the next track after PCM negotiation.
- **Format negotiation:** while any PCM-only WebSocket sink is registered, subsequent tracks share one s16le 48 kHz stereo DSP stream. Omitted settings are selected automatically; explicitly conflicting settings are rejected rather than silently rewritten.
- **Volume:** `Player.volume` goes to outputs registered with `playerVolume: true`. This is enabled for the initial/Discord output and disabled by default for dynamic outputs.
- **Transitions:** a Discord + WebSocket combination reports `replacement: "stop-before-start"`, not `"atomic"`; seek is unsupported in the combined capability set. Transition logic cannot overlap old and new tracks in this configuration: the old output stops before the new one starts, and the new track may fade in from zero. This is not a true atomic crossfade.
- **Unsafe URL mode:** `allowFfmpegUrlInput` now fails validation; callers should use the safe Node HTTP input path so redirects and resolved addresses are checked.

## Verification performed

All tests below ran in a temporary CommonJS transpile harness because dependencies could not be installed in this environment. `@discordjs/voice` was stubbed for the harness; system FFmpeg was available on `PATH`. This validates targeted behavior but is **not** a substitute for the normal package build or a real Discord voice connection.

| Check | Result | Scope / limitation |
|---|---:|---|
| TypeScript source transpile/parse | 66 files, 0 syntax diagnostics | Syntax-only; not a full type check |
| `tests/multi_audio_output_backend.test.js` | 9/9 passed | Fake output handles; includes late join/removal, pacing handoff, capabilities, controls, error isolation, bounded queue/drop counts |
| `tests/audio_output_safety_regressions.test.js` | 5/5 passed | URL safety, executable priority, concurrency isolation, encoded stream type |
| `tests/playback_output_integration.test.js` | 6/6 passed | Five fixture playback cases used system FFmpeg; fake WebSocket sockets and stubbed `@discordjs/voice` |
| **Targeted total** | **20/20 passed** | Isolated harness only |
| CPU / peak RAM / end-to-end latency benchmark | Not measured | No performance claim is made |

## Not verified yet

- Normal `npm install`, `npm run build` for CJS/ESM, and a complete `tsc` type-check (installation timed out; dependencies such as `@discordjs/voice`, `ffmpeg-static`, and `lru-cache` were unavailable).
- Full existing test suite under the project's real installed dependencies.
- Real Discord Voice/UDP subscription readiness and AutoPaused behavior; real gateway routing to multiple browser subscribers.
- Windows runtime, true crossfade/transition behavior, real YouTube sources, and 100-track replacement stress testing for process leaks and RAM stability.
- CPU, peak RAM, and fixture-based latency comparison between PCM+Raw Discord, WebSocket PCM, and Ogg/Opus passthrough.

Do not treat this implementation as production-verified until the outstanding checks above are run with the project's real dependencies and deployment environment.
