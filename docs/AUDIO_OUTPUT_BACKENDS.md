# Audio output backend boundary

ZiPlayer remains Discord-first. `PlayerManager` creates a Discord `AudioPlayer`, `ConnectionController` subscribes it to a Discord
voice connection, and `PlaybackController` remains the compatibility-facing owner of its Discord playback state. The first
extracted seam is deliberately limited to resource construction and output operations; it does not move queueing, track
resolution, recovery, fades, preload, or session policy into the adapter.

## Current dependency map

```text
Player / PlaybackOrchestrator
  -> Bus RPCs for stream replacement, resource creation, and play/stop
  -> PlaybackSession (currently stores AudioResource)
  -> PlaybackController (Discord player state, resource state, fades, watchdog)
       -> DiscordVoiceOutputBackend
            -> createAudioResource / StreamType / AudioPlayer start-pause-resume-stop
            -> Discord inline volume and PCM conversion

AudioProcessingEngine
  -> audio DSP (encoded stream decode -> DSP -> interleaved PCM)
  -> AudioFrameFormat (no Discord runtime or Discord types)

Still Discord-specific outside that seam:
  ConnectionController, PlayerManager's player factory, FilterController's legacy
  stream typing, TTSController, ForwardController, LifecycleController, and compatibility
  resource/player types in Player, PlaybackSession, and types/bus.ts.
```

The last group is intentionally not hidden by the new contract. In particular, `PlaybackSessionSnapshot`, preload and Bus RPCs
still expose `AudioResource`, and the public `Player` surface exposes Discord connection/player concepts. Removing those leaks
requires a follow-up migration of session identity, event state, preload promotion, forwarding, TTS and public compatibility
types; doing that in this extraction would make it a broad, risky rewrite.

## Output contract

`AudioOutputBackend`, `AudioOutputInput`, `AudioOutputHandle`, and `AudioFrameFormat` live in
`core/src/output/AudioOutputBackend.ts` and are exported from the core package. The contract includes:

- An `initialize(signal)` promise and a session handle with start, pause, resume, stop, seek, replacement, volume, event, and
  disposal operations. Backend initialization and per-session readiness can both reject.
- Capability declarations for unsupported operations, replacement behavior, volume ownership, backpressure, and any known
  buffering bound. Unsupported methods reject with `AudioOutputUnsupportedOperationError` instead of silently doing nothing.
- An `AbortSignal` at session creation and on operations. `ownership: "transfer"` means the backend must stop consuming and
  dispose the stream when the session is stopped, aborted, replaced, or disposed. `"borrow"` forbids the backend from destroying
  it. The ownership capability says which modes an adapter accepts; Discord accepts transfer only because its installed
  `AudioPlayer` destroys the previous resource's stream during replacement.
- Encoded format metadata, or explicit PCM sample type, little-endian byte order, sample rate, channel count, interleaved layout,
  and optional frame/chunk alignment. PCM frame payloads may be split across stream chunks unless the format states a stricter
  boundary; backends must honor backpressure and not assume each read is a complete frame.
- Volume is identified as backend-, upstream-, or unsupported. Discord advertises backend volume because its adapter creates an
  inline-volume resource.

The Discord adapter implements this contract and owns the Discord resource factory and the controller's
start/pause/resume/stop/volume operations. The old synchronous `PlaybackController.createResource()` and `Player.createResource()`
behavior remains as a compatibility path; it returns the original `AudioResource` shape. Playback start and resource refresh now
pass cancellation to resource creation. `audioProcessing` only selects DSP options; it does not select or replace the output
backend.

## Processed audio format and failure behavior

`AudioProcessingEngine` only transforms audio and does not import `@discordjs/voice`. Its output format is explicit. PCM output is
little-endian, interleaved, and declares sample type, channel count, sample rate, and per-chunk alignment. The engine now applies
configured resampling and remixing rather than merely labeling output with those requested values.

The installed `@discordjs/voice` 0.19.2 declarations describe `StreamType.Raw` as s16le PCM. Its installed transformer graph
configures raw Discord PCM as 48,000 Hz, 2 channels, signed 16-bit little-endian. The Discord adapter enforces that raw format.
Float32 PCM is converted sample-by-sample to s16le at this explicit boundary, including when a sample is split between input
chunks; it is never passed to the raw PCM decoder as though it were s16le.

The current audio engine cannot create encoded output, so requesting `outputFormat: "encoded"` while processing is enabled is an
explicit error. Pipeline initialization, DSP, decode, and output failures do not switch to the original encoded stream: the source
may already have been consumed. The stream error flows through the Discord player error/recovery path, and cancellation destroys
owned streams rather than trying to replay them. Raw PCM from non-DSP sources must also be explicitly described as 48 kHz stereo
s16le before it can be sent down Discord's raw path.

## Adding a Web backend later

A `WebOutputBackend` can implement the generic session contract and consume the same encoded or explicit PCM input without
inheriting Discord behavior. It will additionally need:

- A transport frame envelope with codec/configuration and sequence/timestamp data; PCM frames need sample boundaries and format
  negotiation.
- Per-client buffering limits, backpressure/drop policy, reconnect behavior, and a bounded queue so slow clients cannot stall or
  exhaust shared playback.
- Client join/leave lifecycle, ownership, and synchronization policy (shared live edge versus independently seekable sessions).
- Authentication, authorization, origin policy, TLS/deployment requirements, rate limits, and protection against a client
  selecting another user's session.
- A latency budget and clock/drift strategy, especially for synchronized multi-client playback. Decoder and browser buffering
  behavior also needs measurement.

For a first one-way browser listener with ordinary internet reachability and moderate latency tolerance, a WebSocket stream is the
simpler transport to deploy and observe; it handles framing/application messages over a common browser transport but generally has
more jitter/buffering than a media-native transport. WebRTC is a better candidate when interactive controls, low latency, or
synchronized listening dominate, at the cost of signaling, NAT traversal, congestion-control and more involved client lifecycle.
These are transport choices only: neither transport, server, authentication, nor browser protocol is implemented here.
