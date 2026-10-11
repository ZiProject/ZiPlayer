# Audio engine review: removing `audio` (JS/wasm) in favour of FFmpeg

All numbers below were measured in a sandbox (Node 22.22, FFmpeg 6.1, **1 vCPU**), so use them for ratios and for pass/fail
behaviour, not as absolute figures for your hardware. Every claim has a test in `tests/` unless marked "not tested".

## Why `audio` was removed

Measured on 5-minute stereo fixtures, gain + highpass, output s16le 48 kHz stereo:

| | `audio` (patched) | FFmpeg child process |
|---|---|---|
| Total CPU, webm/opus | 3.62 s | 1.52 s |
| Total CPU, m4a (faststart) | 5.60 s | 0.98 s |
| Peak RAM, 1 stream | 383-495 MB | 63 MB node + 51 MB child |
| Peak RAM, 8 concurrent streams | 2234 MB | 495 MB |
| Longest event-loop stall | 160-229 ms (webm), **4692 ms** (m4a) | 4-7 ms |
| Backpressure | none: whole source read before the consumer read 0.8 MB | source stalls with the consumer (21% read at 9.3 MB out) |
| Upstream error / destroyed source | pipeline hangs forever | error is thrown |

`audio` decodes inside the Node.js process: a 230 ms stall breaks Discord's 20 ms voice frame cadence for every guild in the
process, running it in a `worker_thread` fixed the stall but not the RAM or the missing backpressure. The repo already shipped
`ffmpeg-static` and `FilterController`, so no dependency was added.

Correction to an earlier statement: the legacy (no-DSP) path is **not** free. `DiscordVoiceOutputBackend` always creates resources
with `inlineVolume: true`, and `@discordjs/voice` then builds `ffmpeg -> volume -> opus encoder` even for WebM/Opus input
(verified). The DSP path replaces that decode step rather than adding a new one.

## Changes

- `core/src/audio/FFmpegAudioProcessingEngine.ts` (new): the only engine. Backpressure through stdin/stdout, `SIGKILL` on
  abort/early exit/`dispose()`, errors for upstream failure, non-zero exit and "exit 0 but no audio", chunks split to
  `maxBufferBytes` on frame boundaries, loudness presets via `loudnorm`.
- `core/src/audio/AudioProcessingEngine.ts`: types and factory only; no `audio` import. `AudioJsAudioProcessingEngine` export
  became `FFmpegAudioProcessingEngine`. `normalize` no longer accepts numbers (throws `TypeError`).
- `core/package.json`: dependency `audio` removed.
- `tests/`: engine tests rewritten without `audio`; new `helpers/wav.js`, `audio_processing_engine.robustness.test.js`,
  `playback_processing_lifecycle.test.js`, `playback_output_integration.test.js`; `audio_engine_benchmark.js` now compares the engine
  with direct FFmpeg on identical fixtures. Suite: 233 tests, all passing.
- Docs: `README.md`, `AGENTS.md`, `docs/AUDIO_OUTPUT_BACKENDS.md` updated (including a new FFmpeg engine section).

## Bugs found while reviewing the output side, and fixed

1. **Raw PCM after a seek played as loud noise.** `FilterController` returns `StreamType.Raw` after a seek, but the DSP branch ignored
   the input type. FFmpeg cannot probe raw PCM and guessed ADPCM: 1 s of 440 Hz became 3.5 s of full-scale noise (peak 1.0, ~10.7 kHz).
   Fix: `AudioProcessingContext.inputFormat` declares PCM streams (`PlaybackController` sets it for `StreamType.Raw`); encoded input is
   restricted to a demuxer whitelist (`ffmpegInputFormats`, `null` disables) so unknown bytes fail instead of being guessed.
2. **FFmpeg and the source leaked when the player destroyed a stalled stream.** `Readable.from()` only finishes teardown when the
   generator's pending `await` settles, so `AudioPlayer.stop()/replace` left FFmpeg running until the whole player was detached
   (one leaked process per skipped stalled track). Fix: abort the pipeline from `processedStream._destroy`. The new test fails without it.
3. **The source stream leaked when the backend rejected the format** right after `createResource` (the generator never started, so
   nothing closed the plugin's socket). Fixed in the same `_destroy` hook.
4. `audioProcessing` now receives the player's `ffmpegPath`.
5. `docs/AUDIO_OUTPUT_BACKENDS.md` claimed the web backend has no volume support; the code implements `volume: "backend"`.
6. The web backend's "only supports PCM" error now says to enable `audioProcessing`.

Checked and found fine: Discord backend float32 conversion and stop (no spurious `failed` event, no uncaught errors); web backend
pacing (100 frames over 1980 ms for 2 s of audio), stop, track replacement (per-track publisher sockets are by design), sequence
numbers and content (440 Hz, peak 0.500).

## Behaviour differences you should know about

- Mono sources are up-mixed to stereo with FFmpeg's equal-power law (-3 dB); `audio` kept unity gain. Stereo is unaffected.
- `normalize` is single-pass `loudnorm` (`streaming` -14, `podcast` -16, `broadcast` -23 LUFS); numeric targets are rejected. Loudness
  accuracy against the old normalizer was not compared.
- MP4/M4A with the `moov` atom at the end cannot be decoded from a pipe: the engine now throws (it used to be a silent empty result
  in a first prototype). Give FFmpeg a seekable URL for such files. `audio` handled them by buffering the whole file.
- Real-time sources start playing after 0.2-1.4 s of input (FFmpeg probing); not changed.
- Engine overhead over running FFmpeg directly: about 1.4-1.8x wall time (`npm run bench:audio`).
- `inlineVolume: true` forces a decode/encode even when volume is never changed. Creating the resource without it when volume is 1
  would restore WebM/Opus passthrough for non-DSP playback. Not changed (behaviour change for volume control).

## Not done / not verified

- Windows (FFmpeg pipes, `SIGKILL`) and real YouTube DASH/Opus streams were not tested; fixtures were produced by FFmpeg.
- `examples/backend/test/gateway.test.js` needs a built `plugins` package and was not run; `websocket_output.test.js` and the
  client tests pass.
- `Opus` (raw packets without a container) input is not decodable by FFmpeg and now fails with an explicit error; no bundled
  plugin produces it.
