# ZiPlayer Web Audio quick start

Hear a ZiPlayer stream in your browser without setting up a Discord bot. This runnable local demo starts ZiPlayer and its source
plugins, routes processed 48 kHz stereo PCM through a loopback-only WebSocket gateway, and serves the browser player.

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

The root install does not install the core package's build tools, so install its dependencies separately before building. You may
copy `examples/backend/.env.example` to `.env` for optional settings such as `TRACK_QUERY`.

The example does not require a token and always binds to loopback. Do not configure `HOST` to a LAN or public address. If you
adapt this example for network access, implement your own authentication and authorization, HTTPS/WSS, and other deployment
protections in your Node.js application; session IDs are not credentials.

Start the gateway and player from the repository root:

```sh
npm start --prefix examples/backend
```

Open <http://127.0.0.1:8080/>. Enter a track search or media URL, then click **Search and play**. The page connects to the next
audio stream before playback starts, so its first frames are not missed. Click
**Disconnect** to stop listening and release browser audio resources. Press **Ctrl+C** in the terminal to stop the server.

The browser's first play/search click also unlocks audio playback in browsers that require a user gesture. If the browser reports
that it connected but PCM is silent, check the terminal for source/plugin errors and try a different query.

The example starts a default ZiPlayer whose ID is `PLAYER_ID` (default `web-audio-demo`). To add another independent player, enter
a different player ID in the browser and use **Search and play**. The gateway creates or reuses exactly one `PlayerManager` player
for that ID; valid IDs contain 1-128 letters, numbers, underscores, or hyphens (ZiPlayer's reserved ID is not allowed). The ID
is also the audio `sessionId`. Reuse that same ID to hear or control the player. The Gateway waits for the publisher for the
requested ID, not for whichever player publishes first. A session-scoped `/listen-next?sessionId=...` listener waits for that
player; omitting `sessionId` explicitly opts into whichever publisher connects next.

Pause, resume, stop, skip, seek, volume, loop mode, autoplay, and filter requests include the selected player ID and are routed
to the matching `PlayerManager` instance. The `/player-state` endpoint supplies the current track, queue, related tracks, active
filters, and player settings displayed by the page. The reusable `@ziplayer/client` package remains an audio receiver and event
source, not a remote player-control API. Volume is applied to outgoing PCM; seeking requires a current track and a position
within its duration. A control that cannot be applied returns an error rather than a successful-looking response. When the last
browser listener disconnects, that player's instance is destroyed after 100 seconds; reconnecting a listener during that grace
period cancels cleanup.

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
Voice. The gateway forwards audio to browser listeners; the browser's reusable
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

- `TRACK_QUERY` or a command-line argument optionally starts an initial search query or media URL; otherwise, use the web page.
- `HOST` and `PORT` control the HTTP/WebSocket listener (defaults: `127.0.0.1:8080`).
- `GATEWAY_URL` overrides the WebSocket publisher URL if the public address differs from `HOST`.
- `PLAYER_ID`, `REQUESTED_BY`, `TTS_LANGUAGE`, and `EXTRACTOR_TIMEOUT_MS` are optional.
- `PLAYER_ID` selects the default player ID created at startup; additional IDs are created on demand through the browser's
  **Search and play** form.

## Security

This is an unauthenticated local example. The gateway rejects non-loopback bind addresses, but any local process or browser able
to reach it can control its players. Do not remove the loopback restriction or forward the port to an untrusted network without
adding application-appropriate authentication and authorization.
