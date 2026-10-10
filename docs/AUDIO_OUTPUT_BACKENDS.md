# Audio output backend boundary

ZiPlayer remains Discord-first. `PlayerManager` creates a Discord `AudioPlayer` when no custom output factory is supplied, and
`ConnectionController` subscribes that player to a Discord voice connection. `PlaybackController` is still the compatibility
boundary for legacy Discord resources and synchronous APIs, but generic playback operations use normalized backend handle state
and lifecycle methods. The extraction does not move queueing, track resolution, recovery, fades, preload, or session policy into
the adapter.

## Current dependency map

```text
Player / PlaybackOrchestrator
  -> Bus RPCs for stream replacement, resource creation, and play/stop
  -> PlaybackSession (currently stores AudioResource)
  -> PlaybackController (normalized handle state; Discord compatibility state, fades, watchdog)
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

The Discord adapter implements this contract and owns Discord resource creation and player start/pause/resume/stop/volume
operations. The old synchronous `PlaybackController.createResource()` and `Player.createResource()` behavior remains a
compatibility path; it returns the original `AudioResource` shape. Playback start and resource refresh pass cancellation to
resource creation. `audioProcessing` only selects DSP options; it does not select or replace the output backend.

## Selecting a backend

Backend selection is per player and has no global mutable default. `PlayerOptions.audioOutputBackendFactory` is optional; when
omitted, ZiPlayer constructs `DiscordVoiceOutputBackend` around the manager-created `AudioPlayer`. A factory is invoked once per
attached player and its backend instance is owned by that player's `PlaybackController` slot. Detaching/replacing the slot aborts
its lifecycle signal, disposes its handles, detaches event listeners, and disposes the backend. A caller should therefore return a
fresh backend instance for each factory invocation unless it explicitly manages safe sharing itself.

```ts
const player = await manager.create(guildId, {
	audioOutputBackendFactory: ({ playerId }) => createMyBackend(playerId),
});
```

The factory is a typed injection seam, not a plugin registry. At this stage its resource type remains
`AudioOutputBackendFactory<AudioResource>` to preserve the Bus, `PlaybackSession`, preload, and public `Player` compatibility
contracts. A custom transport can run without a Discord voice connection (as the fake integration backend does), but a fully
Discord-independent resource type is not yet supported at the public TypeScript boundary. Generalizing that identity without
breaking existing `AudioResource` consumers is follow-up work; do not treat the current seam as a completed Web backend API.

The backend owns each session handle it creates; the slot owns the backend and registered handle-event detachers. A transferred
input stream is destroyed on stop, cancellation, replacement, failure cleanup, or disposal. A borrowed stream must not be
destroyed by the backend. Session readiness and backend initialization must settle before start; failure is reported through the
existing track-error/recovery path. A consumed stream is never replayed after DSP or sink failure. Operations unsupported by the
selected backend reject explicitly, including seek or volume operations when the capability says unsupported. The fake backend
tests cover lifecycle, startup cancellation, replacement, output failure, volume/crossfade capability, and disposal without
opening a Discord voice connection.

Stop is cleanup-safe even when the backend rejects or the caller aborts while stop is pending: the controller disposes the
captured handle independently, reports disposal failure as a separate stream error, and then propagates the original stop failure.
Slot state is cleared only if that same handle is still active, so a late stop cannot erase a replacement. Concurrent stop and
disposal requests share per-handle cleanup. In remote playback mode, stop awaits the remote stop RPC and does not also stop the
local output backend. A remote `false` result means the remote endpoint did not stop; the local session and queue remain unchanged
and no successful `playerStop` event is emitted. Concurrent remote STOP actions share the in-flight RPC and commit the resulting
state transition at most once. The shared remote RPC is not bound to an individual caller's `AbortSignal`: abort rejects only that
caller's wait, while other callers may continue waiting and the eventual remote result is still applied once. The same per-caller
cancellation rule applies to direct `PlaybackController.stop()` calls.

Backend start is transactional: readiness and initial volume must succeed before activation is committed, and failed/unactivated
handles are disposed; adapters should ensure a rejected `start()` does not leave an active output session behind. Related-track
generation failure is reported as `streamError`, then the normal queue-end/autoplay fallback proceeds without treating the lookup
as a successful result. Queue and track-start RPC failures remain observable and restore the queue-wait/transition guards so a
later queue change can retry.

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

## Verification

From the repository root, run:

```sh
npm run build:core
node --test tests/audio_output_backend.test.js tests/audio_processing_engine.test.js
npm test
npm run format:check
```

The Node.js CI workflow runs required package builds without success-shaped fallbacks. It checks formatting but does not rewrite,
commit, or push source files.
