# Audio playback architecture

## Current design

- Each managed player owns one `@discordjs/voice` `AudioPlayer`.
- Playback wraps a source `Readable` in an inline-volume `AudioResource` and starts it with `AudioPlayer.play(resource)`.
- Discord Voice and `WebAudioConnection` subscribe directly to the same player and receive the same Opus packets. WebAudio wraps
  those packets in ZI v1 frames for the application gateway.
- Player controls, volume, resource replacement, and lifecycle are handled directly by the shared `AudioPlayer` and
  `AudioResource`.
- There is no server-side PCM output path, `AudioOutputBackend`, `DiscordVoiceOutputBackend`, `MultiAudioOutputBackend`, or
  output-backend factory. Generic stream-output backends are not accepted by `Player.connect()`.
- PCM remains an internal DSP/codec representation and is produced locally by browser Opus decoding for AudioWorklet playback; PCM
  is not sent over the WebSocket protocol.
- FFmpeg protections remain in place, including executable selection, concurrency limits, redirect-by-redirect URL validation with
  DNS address pinning, and rejection of unsafe direct FFmpeg URL input.

## Validation

Core build and regression tests are run from the repository root:

```sh
npm run build:core
npm test
npm test --prefix examples/backend
npm test --prefix client
```

Real Discord Voice/UDP readiness and end-to-end gateway delivery still require a live deployment environment.
