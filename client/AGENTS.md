# `@ziplayer/client`: agent guide

This package is the browser-only receiver for ZiPlayer's version 1 WebSocket audio protocol. Keep it dependency-free and safe to
serve as an ES module; do not import Node.js APIs into `browser/index.js`.

## Protocol contract

- The publisher configuration is JSON `audio:config`, protocol version 1, 48 kHz, stereo, interleaved s16 little-endian PCM.
- Binary frames begin with a 16-byte little-endian header: sequence (u32), timestamp milliseconds (u32), sample rate (u16),
  channel count (u16), bytes per sample (u16), and reserved bytes (u16). Payload follows as PCM.
- Validate the config and each frame before handing any samples to the AudioWorklet.
- Convert s16 samples to normalized Float32; preserve the original PCM payload in the `pcm` event for recording/capture use.
- Keep the FIFO bounded and reset it when a new `audio:config` arrives. Do not treat network arrival rate as the audio sample
  clock; the AudioWorklet consumes exactly one sample frame per output sample frame.

## API and verification

- Preserve the `WebAudioClient` lifecycle: connect from a user gesture, surface errors via the `error` event, and release the
  WebSocket, AudioWorklet, and AudioContext on disconnect.
- Browser authentication uses the gateway's query-token convention. Explain that this is for browser transport limitations and
  that deployments should use WSS and short-lived tokens.
- Keep the public declarations in `index.d.ts` synchronized with `browser/index.js`.
- Run `npm test --prefix client` for protocol validation tests and `npx prettier --check client` for format validation.
- For end-to-end changes, also run `npm test --prefix examples/backend` and the root ZiPlayer test suite.
