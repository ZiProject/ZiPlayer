# `@ziplayer/client`

Small browser client for ZiPlayer's Opus-only WebSocket audio protocol. It validates the publisher configuration and binary frame
headers, decodes Opus packets with `opus-decoder` WebAssembly into Float32 samples, and plays them through an AudioWorklet with a
bounded jitter buffer.

The package is a receiving/playback client; it does not expose remote `pause`, `stop`, `seek`, or volume methods. To control
playback volume, send a volume command through your server API to the ZiPlayer player, which applies it before audio is sent to
its subscribers. Your Node.js application still needs an authenticated WebSocket gateway and a `WebAudioConnection` publisher.
Authentication is determined by your gateway; the `token` connect option is optional for gateways that do not require it. Add
playback controls to your own server API and bind them to the intended ZiPlayer player. The gateway example in
[`../examples/backend`](https://github.com/ZiProject/ZiPlayer/tree/main/examples/backend) shows a complete local setup with
search, publisher routing, browser playback, queue display, and multi-player controls.

## Install and use

```sh
npm install @ziplayer/client
```

Import it from a browser bundle or serve `browser/index.js` as an ES module. When serving the file directly without a bundler,
provide an import map for the `opus-decoder` package and its dependencies; the gateway example includes the required mappings and
serves those modules from the installed client dependencies:

```js
import { WebAudioClient } from "@ziplayer/client";

const client = new WebAudioClient();
client.addEventListener("config", ({ detail }) => {
	console.log(`Listening to player ${detail.sessionId}`);
});
client.addEventListener("pcm", ({ detail }) => {
	console.log(`Frame ${detail.sequence}, peak ${detail.peak.toFixed(3)}`);
});
client.addEventListener("error", ({ detail }) => {
	console.error("Audio client error:", detail.error);
});

// Call from a user gesture so the browser permits AudioContext playback.
await client.connect({
	gatewayUrl: "ws://127.0.0.1:8080",
	token: tokenFromYourApplication,
	sessionId: "my-player",
});

// Stop the browser listener and release its AudioContext.
await client.disconnect();
```

For a UI that starts a new player session after the click, connect first with `nextPublisher: true`, then ask the server to start
playback:

```js
await client.connect({
	gatewayUrl: "ws://127.0.0.1:8080",
	token: tokenFromYourApplication,
	nextPublisher: true,
});
await fetch("/play", { method: "POST", body: JSON.stringify({ query }) });
```

The `token` option is optional for gateways that do not require authentication; provide it when your server uses token-based
authentication. The browser fills in `client.sessionId` when the next publisher sends `audio:config`. If a publisher is already
active and you want to join that live stream, pass its `sessionId` instead. Call `disconnect()` to release browser resources.

## Events

`WebAudioClient` is an `EventTarget`:

| Event         | `event.detail`                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `connected`   | `{ sessionId, nextPublisher }`, emitted when the WebSocket opens                       |
| `config`      | Validated publisher audio configuration (`codec: "opus"`)                              |
| `pcm`         | `{ sequence, timestampMs, samples, peak, payload, sequenceGap, codec }` for each frame |
| `statechange` | `{ state, previousState }`                                                             |
| `sequencegap` | `{ expectedSequence, receivedSequence }` when a frame is lost                          |
| `control`     | An unrecognized, versioned publisher control message                                   |
| `error`       | `{ error }`                                                                            |
| `close`       | `{ code, reason }` for a remote WebSocket close                                        |

`payload` is the original Opus packet, excluding its 16-byte protocol header. `samples` is the locally decoded, interleaved stereo
Float32 data normalized to `[-1, 1]`. The client transfers that Float32 buffer to its AudioWorklet after dispatching the event;
copy the samples inside the event callback if they must be retained.

### Audio Spectrum and Audio React (Visualizers)

`WebAudioClient` automatically creates an [`AnalyserNode`](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)
connected directly in the Web Audio output graph (`workletNode -> analyserNode -> context.destination`), providing
hardware-accelerated FFT frequency analysis synchronized with speaker output.

#### Using `getFrequencyBands` and `getBassEnergy` Helpers

The package exports studio-grade visualizer helpers implementing:

- **Logarithmic musical frequency mapping** ($f_{min} \to f_{max}$) with perceptual octave bands.
- **Continuous sub-bin linear interpolation** for low bass (eliminates flat staircase duplicate bands).
- **Equal-loudness curve** ($W(t)$) preventing dense mid-range saturation while keeping bass and highs lively.
- **5-point Gaussian spatial smoothing** (like After Effects Audio Spectrum) to produce fluid, organic peak curves.
- **Soft-knee tanh limiter** eliminating ugly flat-ceiling clipping.

```js
import { WebAudioClient, getFrequencyBands, getBassEnergy } from "@ziplayer/client";

const client = new WebAudioClient();
await client.connect({ gatewayUrl: "ws://127.0.0.1:8080", sessionId: "my-player" });

// Pre-allocate output buffer once to achieve 0-allocation 60fps/120fps render loops:
const bandCount = 36;
const bands = new Float32Array(bandCount);

function renderLoop() {
	// 1. Get smoothed frequency bars [0.0 to 1.0]:
	client.getFrequencyBands({
		bands: bandCount,
		minHz: 28,
		maxHz: 16000,
		outputBuffer: bands, // Reuses buffer to avoid GC pauses
	});

	// 2. Get normalized sub-bass & kick drum energy [0.0 to 1.0] for beat pulsing:
	const kick = client.getBassEnergy({ minHz: 45, maxHz: 120 });
	// Pulse album art scale or glow: scale(1 + kick * 0.05)

	// Draw bars onto <canvas>...
	requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
```

You can also call the standalone functions with any `AnalyserNode` or `Uint8Array`:

```js
const bands = getFrequencyBands(analyserNode, { bands: 48 });
const kickEnergy = getBassEnergy(analyserNode);
```

#### Configuring `analyserOptions`

To configure the internal analyser, pass `analyserOptions` to the constructor:

```js
const client = new WebAudioClient({
	analyserOptions: {
		fftSize: 2048, // 1024 frequency bins (default: 2048)
		smoothingTimeConstant: 0.65, // 0 to 1 (default: 0.65)
		minDecibels: -85, // dB floor (default: -85)
		maxDecibels: -10, // dB ceiling (default: -10, provides 20dB dynamic headroom)
	},
});
```

Pass `analyserOptions: false` if you want to bypass the `AnalyserNode` and connect the worklet directly to `context.destination`.

### In-Browser Opus Decoding

When the gateway publisher streams Opus (`codec: "opus"`), the default decoder uses `opus-decoder` (or supply an asynchronous
`opusDecoderFactory` returning a compatible decoder adapter):

```js
import { WebAudioClient, OpusDecoderAdapter } from "@ziplayer/client";
import { OpusDecoder } from "opus-decoder";

const client = new WebAudioClient({
	opusDecoderFactory: async () => {
		const decoder = new OpusDecoder({ channels: 2, sampleRate: 48000 });
		await decoder.ready;
		return new OpusDecoderAdapter({ decoder, channels: 2, sampleRate: 48000 });
	},
});
```

Options default to a 100 ms startup buffer, a two-second maximum AudioWorklet FIFO, and a five-second WebSocket connect timeout.
The AudioContext must support 48 kHz output. Browsers require HTTPS/WSS outside localhost. Because browser WebSocket clients
cannot set authorization headers, the gateway URL carries the listener token in a query parameter; use short-lived credentials.

## TypeScript

Declarations are included. The browser APIs require the TypeScript `DOM` library.
