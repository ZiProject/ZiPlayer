# ZiPlayer Web Audio quick start

Hear a ZiPlayer stream in your browser without setting up a Discord bot. This runnable local demo starts ZiPlayer and its source
plugins, routes processed 48 kHz stereo PCM through an authenticated WebSocket gateway, and serves the browser player.

## Requirements

- Node.js 20.3 or newer and npm.
- Internet access to install packages and resolve online media.
- A modern browser with AudioWorklet support (for example, current Chrome, Edge, Firefox, or Safari).

No Discord bot or Discord token is required for this browser example.

## Start from a fresh clone

Run these commands from the repository root. If you have not cloned the project yet:

```sh
git clone https://github.com/ZiProject/ZiPlayer.git
cd ZiPlayer
npm install
npm install --prefix core
npm run build:core
npm install --prefix examples/backend
```

The root install does not install the core package's build tools, so install its dependencies separately before building.

Create `examples/backend/.env` by copying `examples/backend/.env.example`, then open the new file and set `WEB_AUDIO_TOKEN` to a
non-empty local development value. The checked-in token is only a loopback placeholder: the gateway refuses to start with it
when `HOST` is not a loopback address. Before exposing the gateway to a network, set a unique secret; keep `.env` private (it is
ignored by Git). Network exposure still requires HTTPS/WSS and a production authentication design; a strong shared token alone
does not make this demo production-ready.

Start the gateway and player from the repository root:

```sh
npm start --prefix examples/backend
```

Open <http://127.0.0.1:8080/>. Enter the same token in the **Listener token** field, enter a track search or media URL, then click
**Search and play**. The page connects to the next audio stream before playback starts, so its first frames are not missed. Click
**Disconnect** to stop listening and release browser audio resources. Press **Ctrl+C** in the terminal to stop the server.

The browser's first play/search click also unlocks audio playback in browsers that require a user gesture. If the browser reports
that it connected but PCM is silent, check the terminal for source/plugin errors and try a different query.

The page fetches the configured playback session ID from the gateway and uses it both for `/listen-next` and `/play`. These
session-scoped listeners wait for that exact publisher. A listener that manually connects to `/listen-next` without a
`sessionId` explicitly means “attach to whichever publisher connects next”; use a session ID whenever a specific player is
intended.

You can optionally start a query automatically by adding `TRACK_QUERY` to `examples/backend/.env`:

```dotenv
TRACK_QUERY=lofi hip hop radio
```

Alternatively, pass a search phrase or URL after `--`:

```sh
npm start --prefix examples/backend -- "https://www.youtube.com/watch?v=..."
```

## What is running?

The example registers YouTube, SoundCloud, Spotify, attachments, and TTS source plugins with `PlayerManager`. It uses the regular
ZiPlayer playback pipeline, but sends processed PCM through `WebSocketAudioOutputBackend` to the local gateway instead of Discord
Voice. The gateway authenticates the publisher and browser listener and forwards audio; the browser's reusable
`@ziplayer/client` validates and plays it through an AudioWorklet. The page's session fields are available for manual connections
if you want to listen to an already-running player.

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
- `TRACK_QUERY` or a command-line argument optionally starts an initial search query or media URL; otherwise, use the web page.
- `HOST` and `PORT` control the HTTP/WebSocket listener (defaults: `127.0.0.1:8080`).
- `GATEWAY_URL` overrides the WebSocket publisher URL if the public address differs from `HOST`.
- `PLAYER_ID`, `REQUESTED_BY`, `TTS_LANGUAGE`, and `EXTRACTOR_TIMEOUT_MS` are optional.

The page also accepts a session-scoped listener token, allowing a separate browser session to connect to `/listen`.

## Security

The shared token and query-string token handling are for local development only. Browser WebSocket APIs cannot set arbitrary
request headers, so the demo uses a query parameter for listener authentication. Do not expose a long-lived shared secret or run
this example on an untrusted network. Production deployments should use HTTPS/WSS, short-lived per-session credentials, and
session-scoped authorization in place of the demo token comparison.
