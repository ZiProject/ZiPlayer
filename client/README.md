# `@ziplayer/client`

Small browser client for ZiPlayer's WebSocket PCM protocol. It validates the publisher configuration and binary frame headers,
converts little-endian s16 stereo PCM to Float32, and plays it through an AudioWorklet with a bounded jitter buffer.

The package is only the receiving/playback client and event source; it does not expose remote `pause`, `stop`, `seek`, or volume
methods. Your Node.js application still needs an authenticated WebSocket gateway and a ZiPlayer
`WebSocketAudioOutputBackend` publisher. Authentication is determined by your gateway; the `token` connect option is optional
for gateways that do not require it. Add playback controls to your own server API and bind them to the intended ZiPlayer player.
The gateway example in
[`../examples/backend`](https://github.com/ZiProject/ZiPlayer/tree/main/examples/backend) shows a complete local setup with
search, publisher routing, browser playback, queue display, and multi-player controls.

## Install and use

```sh
npm install @ziplayer/client
```

Import it from a browser bundle or serve `browser/index.js` as an ES module:

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

| Event         | `event.detail`                                                                  |
| ------------- | ------------------------------------------------------------------------------- |
| `connected`   | `{ sessionId, nextPublisher }`, emitted when the WebSocket opens                |
| `config`      | Validated 48 kHz stereo s16 LE PCM publisher configuration                      |
| `pcm`         | `{ sequence, timestampMs, samples, peak, payload, sequenceGap }` for each frame |
| `statechange` | `{ state, previousState }`                                                      |
| `sequencegap` | `{ expectedSequence, receivedSequence }` when a frame is lost                   |
| `control`     | An unrecognized, versioned publisher control message                            |
| `error`       | `{ error }`                                                                     |
| `close`       | `{ code, reason }` for a remote WebSocket close                                 |

`payload` is the original s16 PCM frame payload, excluding its 16-byte protocol header. `samples` is interleaved stereo Float32
data normalized to `[-1, 1]`. The client transfers that Float32 buffer to its AudioWorklet after dispatching the event; copy the
samples inside the event callback if they must be retained.

Options default to a 100 ms startup buffer, a two-second maximum AudioWorklet FIFO, and a five-second WebSocket connect timeout.
The AudioContext must support 48 kHz output. Browsers require HTTPS/WSS outside localhost. Because browser WebSocket clients
cannot set authorization headers, the gateway URL carries the listener token in a query parameter; use short-lived credentials.

## TypeScript

Declarations are included. The browser APIs require the TypeScript `DOM` library.
