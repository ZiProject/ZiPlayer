# @ziplayer/net cluster test (real Discord bot + Mosquitto)

A real `discord.js` bot (commands arrive through `messageCreate`) plus provider nodes, each in its own process with its **own real
plugins**, linked over an MQTT broker. Use it to try stream transfer, relay, voice hand-off and failover with real audio.

```
Discord ── messageCreate ──► bot-1 (soundcloud)  ◄──── MQTT (Mosquitto) ────►  yt-1 (youtube)
                              owns the gateway                                  tts-1 (tts, attachments)
```

## 1. Install and build

```bash
npm install --prefix core    && npm run build --prefix core
npm install --prefix plugins && npm run build --prefix plugins
npm install --prefix net     && npm run build --prefix net
npm install --prefix examples/net            # discord.js
```

## 2. Mosquitto

```bash
cd examples/net
mosquitto_passwd -c ./passwd bot-1 && mosquitto_passwd ./passwd yt-1 && mosquitto_passwd ./passwd tts-1
chown mosquitto passwd mosquitto.acl.example && chmod 600 passwd mosquitto.acl.example   # Mosquitto 2.x requirement
mosquitto -c ./mosquitto.conf.example
```

`mosquitto.acl.example` gives every node its own presence topic and inbox. The broker is **not trusted** (payloads are
authenticated and control data is encrypted end to end); the ACL only stops nodes from impersonating each other. For a quick local
try you can skip auth with `listener 1883` + `allow_anonymous true` and leave `MQTT_USERNAME` empty.

## 3. Configure

```bash
cp .env.example .env     # set DISCORD_TOKEN, MQTT_URL, MQTT_PASSWORD, NODES ...
```

Every variable is documented in `.env.example`. Real environment variables override the file; `--env=./other.env` picks another
file. Enable the **Message Content Intent** for the bot in the Discord developer portal (the commands are plain messages).

## 4. Run

```bash
node test-cluster.js              # keys are created on first run, all nodes start as separate processes
node test-cluster.js --keys       # only create keys and print fingerprints
node test-cluster.js --node=yt-1  # one node only (another machine): copy the other nodes' *.key.pub into KEY_DIR first
```

## 5. Try one case at a time

The cluster runner wires the Discord bot and shared helpers together; each user-facing network scenario lives in its own module:

1. **Search and play** — start with `!search yt:<query>`, then `!play yt:<query>` to find a track on a provider and stream it to
   the bot: [`cases/search-and-play.js`](./cases/search-and-play.js).
2. **Relay or route** — use `!route yt:<query> 10` to see the router choose local playback, audio relay, or voice hand-off based
   on track ownership: [`cases/routing.js`](./cases/routing.js).
3. **Voice hand-off** — move a connected voice session with `!handoff <node>` and return it with `!reclaim`:
   [`cases/voice-handoff.js`](./cases/voice-handoff.js).
4. **Full self-test** — run `!selftest` for pairing, stream transfer, routing, hand-off, and reclaim; `!selftest failover`
   additionally crashes the remote executor and checks recovery (requires `ALLOW_REMOTE_KILL=1`):
   [`cases/selftest.js`](./cases/selftest.js).

The `!nodes`, `!status`, `!trace`, `!stop`, `!skip`, `!leave`, and guarded `!kill` commands remain in
[`test-cluster.js`](./test-cluster.js) as cluster controls and diagnostics.

### One-shot voice transfer

To connect a specific voice channel and play a YouTube URL on the YouTube provider automatically after login, set
`VOICE_TEST_CHANNEL_ID` and `VOICE_TEST_QUERY` in the env file. Make sure `NODES` includes a non-Discord node with the `youtube`
plugin. The test searches on that node, transfers the voice connection, starts playback, and reports success only after the
provider emits `trackStart`.

For an isolated extra cluster, copy `.env` to `.env.voice-transfer`, set a unique `NET_ID`, `NODES` (for example
`transfer-client:soundcloud,transfer-yt:youtube`), and `KEY_DIR=./.keys/voice-transfer`, then set the channel and query:

```env
VOICE_TEST_CHANNEL_ID=1563498330582032529
VOICE_TEST_QUERY=https://www.youtube.com/watch?v=oc7FhDaO5c4
NET_DEBUG=1
DEBUG=1
NET_DEBUG_FILE=./voice-transfer-mqtt-debug.log
```

Run the separate processes with `node test-cluster.js --env=./.env.voice-transfer`. The formatted MQTT trace is appended to
`NET_DEBUG_FILE`; player-manager debug messages are printed in the process console. Debug message bodies remain redacted by
default. The log file is ignored by git.

## 6. Discord commands

| Command                              | What it tests                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `!nodes` / `!status`                 | Authenticated request to every node, their plugins, who owns the voice                         |
| `!play <query>`                      | Bot plugins first; if nothing is found (e.g. a YouTube URL) the other nodes are asked          |
| `!play yt:<query>`                   | Search and audio on the node with the youtube plugin, streamed to the bot (`sc:` `sp:` `tts:`) |
| `!search <query>`                    | Only show the results and which node found them                                                |
| `!trace [on\|off\|msg\|wire\|audio]` | Print what this node sends to / receives from MQTT (or `NET_DEBUG=1` in `.env`)                |
| `!route yt:<query> [n]`              | Router: relay a few foreign tracks, or hand the voice off when most tracks are foreign         |
| `!handoff <node>` / `!reclaim`       | Move the Discord voice session to another node and take it back                                |
| `!selftest [failover]`               | Automated: pairing, plugins, stream, relay, handoff, executor playback, reclaim (+ node crash) |
| `!kill <node>`                       | Crash a node (`ALLOW_REMOTE_KILL=1`) and watch the bot take the voice back                     |
| `!stop` `!skip` `!leave`             | Housekeeping                                                                                   |

Change `NODES` to give nodes different plugins and see the router choose differently, for example
`NODES=bot-1:soundcloud+youtube,yt-1:youtube,tts-1:tts` makes YouTube local to the bot.

## Notes

- Voice hand-off needs a real voice session: the bot joins your channel, then `yt-1` takes over through the relay adapter. If the
  executor never gets audio out, check that `yt-1` can reach Discord's voice servers (UDP) from where it runs.
- Search for `yt:`/`sc:` needs internet from the node that owns the plugin; `tts:` uses the TTS plugin.
- Keys live in `KEY_DIR` (default `.keys/`, git-ignored). Never copy a `.key` file, only `.key.pub`.
