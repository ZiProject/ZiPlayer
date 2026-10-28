# ZiPlayer repository guide for coding agents

Read the root [`README.md`](README.md) for public setup and player workflows. For core API use and internal architecture, read
[`core/AGENTS.md`](core/AGENTS.md). The core package's agent guide is included in the published `ziplayer` package.

## Repository structure

- `core/src/` contains the player facade, manager, controllers, stream handling, audio subscribers, and public exports. Edit
  source here; `core/dist/` is generated.
- `plugins/`, `extension/`, `infinity/`, and `adapters/` are separate integration packages.
- `client/` is the browser Opus receiver package. Keep its browser entry free of Node.js APIs.
- `examples/backend/` is the runnable ZiPlayer + authenticated WebSocket gateway + browser playback example.
- `docs/` contains implementation/API references, including the audio output contract.
- `tests/` contains core regression tests; each package can also provide focused tests.

## User-facing behavior

- Normal applications should use `PlayerManager`, `Player`, plugins, and documented player options, not private Bus/controller
  internals.
- Discord Voice and WebAudio outputs subscribe to the shared `@discordjs/voice` `AudioPlayer`; attach browser output with
  `player.connect(webConnection)`. `WebAudioConnection` publishes only Opus packets in Wire Format v1 frames through an
  application gateway. The `@ziplayer/client` browser receiver decodes Opus to PCM locally for AudioWorklet playback.
- PCM remains internal to DSP/codec processing and browser decoding, not a WebSocket transport. Do not reintroduce server-side PCM
  output backends or a custom output backend/factory API. Discord Voice and WebAudio connections subscribe directly to the shared
  `AudioPlayer`; attach browser output with `player.connect(webConnection)`.
- The current player stack supports queue orchestration, smart preloading, crossfade/transition flow, loudness normalization,
  anti-stuck recovery, filter chains, and browser/WebSocket publishing in addition to standard voice playback.
- The DSP pipeline (`FFmpegAudioProcessingEngine`) runs FFmpeg as a child process and emits PCM. `audioProcessing.inputFormat`
  stays `"encoded"`; a PCM stream (for example the output of a seek) is declared per stream through
  `AudioProcessingContext.inputFormat` because FFmpeg cannot probe raw PCM and would guess it as noise. Downstream output must
  follow the registered output's format contract.
- Keep public documentation and the package `AGENTS.md` guides aligned with changes to exported APIs and expected workflows.

## Validation

- `npm test` builds core and runs the root unit/regression tests.
- `npm test --prefix examples/backend` checks gateway handoff behavior.
- `npm test --prefix client` checks browser protocol validation and frame decoding.
- `npm run test:integration` runs plugin/extension integration tests when relevant.
- Use `npx prettier --check <changed paths>` and `git diff --check` for changed source and documentation.
- Do not edit generated `core/dist/` files directly.
