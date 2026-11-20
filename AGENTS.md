# ZiPlayer repository guide for coding agents

Read the root [`README.md`](README.md) for public setup and player workflows. For core API use and internal architecture, read
[`core/AGENTS.md`](core/AGENTS.md). The core package's agent guide is included in the published `ziplayer` package.

## Repository structure

- `core/src/` contains the player facade, manager, controllers, stream handling, audio subscribers, and public exports. Edit
  source here; `core/dist/` is generated.
- `plugins/`, `extensions/`, `infinity/`, `adapters/`, and `net/` are separate integration packages.
- `client/` is the browser Opus receiver package. Keep its browser entry free of Node.js APIs.
- `examples/backend/` is the runnable ZiPlayer + authenticated WebSocket gateway + browser playback example.
- `docs/` contains player event flow and event debugging references (`PLAYER_EVENT_FLOW.md`, `PLAYER_EVENT_DEBUG.md`).
- `tests/` contains core regression tests; each package can also provide focused tests.

## User-facing behavior

- Normal applications should use `PlayerManager`, `Player`, plugins, and documented player options, not private Bus/controller
  internals.
- Discord Voice and WebAudio outputs subscribe to the shared `@discordjs/voice` `AudioPlayer`; attach browser output with
  `player.connect(webConnection)`. `WebAudioConnection` publishes only Opus packets in Wire Format v1 frames through an
  application gateway. The `@ziplayer/client` browser receiver decodes Opus to PCM locally for AudioWorklet playback.
- `net/` (`@ziplayer/net`) links ZiPlayer processes over MQTT. It is not an output backend: it moves compressed audio (Opus
  containers and `arbitrary`, never raw PCM) between nodes, and hands a Discord voice session to another node through a relay
  `voiceAdapterCreator`, so the real `@discordjs/voice` connection still runs on the node that plays. Control data and voice
  credentials are always end-to-end encrypted; audio is clear by default (`encryptAudio` is opt-in). A node never fetches a URL a
  peer hands it; a provider resolves peer-requested tracks only through its own plugins (use the `allow` hook). Test with
  `tests/net_*.test.js` (`npm install --prefix net` once so `npm test` builds and runs them).
- PCM remains internal to DSP/codec processing and browser decoding, not a WebSocket transport. Do not reintroduce server-side PCM
  output backends or a custom output backend/factory API. Discord Voice and WebAudio connections subscribe directly to the shared
  `AudioPlayer`; attach browser output with `player.connect(webConnection)`.
- The current player stack supports queue orchestration, smart preloading, crossfade/transition flow, loudness normalization,
  anti-stuck recovery, filter chains, and browser/WebSocket publishing in addition to standard voice playback.
- Normal playback feeds the source stream directly to `createAudioResource` (with inline volume enabled) without running FFmpeg.
  When filters are active or seeking on a non-seekable stream is performed, `FilterController` runs FFmpeg as a single-pass filter
  child process emitting Ogg Opus, which is consumed directly by the resource pipeline. PCM remains internal to codec/DSP
  processing and browser decoding, not an intermediate pipeline or WebSocket transport format.
- Keep public documentation and the package `AGENTS.md` guides aligned with changes to exported APIs and expected workflows.

## Validation

- `npm test` builds core and runs the root unit/regression tests.
- `npm test --prefix examples/backend` checks gateway handoff behavior.
- `npm test --prefix client` checks browser protocol validation and frame decoding.
- `npm run test:integration` runs plugin/extension integration tests when relevant.
- Use `npx prettier --check <changed paths>` and `git diff --check` for changed source and documentation.
- Do not edit generated `core/dist/` files directly.
