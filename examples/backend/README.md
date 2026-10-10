# ZiPlayer Web Audio session

This example starts a regular ZiPlayer playback session with its source plugins, then routes the resulting 48 kHz stereo s16 LE
PCM through the WebSocket output backend to browser listeners. `index.js` wires up ZiPlayer; `gateway.js` handles WebSocket
authentication, publisher/listener routing, and serving the browser client.

## Run locally

From the repository root, build the core package and install the example dependencies:

```sh
npm run build:core
npm install --prefix examples/backend
```

Set a local development token and start the session. `TRACK_QUERY` is optional:

```powershell
$env:WEB_AUDIO_TOKEN = "replace-with-a-local-development-token"
npm start --prefix examples/backend
```

You can also provide an initial query through `TRACK_QUERY`:

```powershell
$env:TRACK_QUERY = "lofi hip hop radio"
npm start --prefix examples/backend
```

Or pass a media URL as a command-line argument:

```powershell
npm start --prefix examples/backend -- "https://www.youtube.com/watch?v=..."
```

The example registers YouTube, SoundCloud, Spotify, attachments, and TTS plugins with `PlayerManager`. Enter a search phrase or
media URL on the web page and choose **Search and play**; ZiPlayer resolves it through the registered source plugins, starts it on
the normal player/queue pipeline, and the page subscribes to the next audio publisher before starting playback so the first PCM
frames are not lost. Enter the gateway token in the Listener token field before searching. `audioOutputBackendFactory` sends
processed PCM to the gateway instead of Discord Voice. The browser uses the reusable `@ziplayer/client` package to validate and
play the PCM stream. The backend paces PCM frames at their configured sample rate, and a player-stable session ID lets the gateway
keep listeners attached while the player's publisher socket is replaced for the next track. Open <http://127.0.0.1:8080/> to
search and listen. The session fields remain available for manual connections.

Run the gateway handoff test from the repository root with `npm test --prefix examples/backend`.

While connected, choose **Start WAV recording** to record the exact PCM stream while it continues playing. **Download current
WAV** saves a snapshot without stopping the recording; **Stop & download WAV** ends the capture and downloads it. Recordings are
stereo 48 kHz s16 PCM in a WAV container and are capped at 10 minutes per capture to limit browser memory use. This saves the
audio received by the browser; it does not download the provider's original MP3/FLAC file.

## Troubleshooting

The `/listen` WebSocket request stays pending while connected; that is normal for a live stream. After the JSON `audio:config`
message, binary PCM frames should follow continuously. The page reports the PCM frame count, whether the PCM has a non-zero
signal, and the browser `AudioContext` state. If no PCM arrives within five seconds, check the server terminal for the
`ZiPlayer stream/output error` or `No PCM frames received` diagnostic. If frames arrive but the PCM is silent, try another track
and check the source stream. The search form opens `/listen-next` before sending its playback request, which prevents the
publisher from sending its first frames before the browser is subscribed.

Configuration:

- `WEB_AUDIO_TOKEN` is required by both the gateway and publisher connection.
- `TRACK_QUERY` or a command-line argument optionally starts an initial search query or media URL; otherwise, search from the web
  page.
- `HOST` and `PORT` control the HTTP/WebSocket listener (defaults: `127.0.0.1:8080`).
- `GATEWAY_URL` overrides the WebSocket publisher URL if the public address differs from `HOST`.
- `PLAYER_ID`, `REQUESTED_BY`, `TTS_LANGUAGE`, and `EXTRACTOR_TIMEOUT_MS` are optional.

The page also accepts a session-scoped listener token, allowing a separate browser session to connect to `/listen`.

## Security

The shared token and query-string token handling are for local development only. Browser WebSocket APIs cannot set arbitrary
request headers, so the demo uses a query parameter for listener authentication. Do not expose a long-lived shared secret or run
this example on an untrusted network. Production deployments should use HTTPS/WSS, short-lived per-session credentials, and
session-scoped authorization in place of the demo token comparison.
