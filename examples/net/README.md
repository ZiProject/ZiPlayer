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

Join a voice channel and type in a text channel:

| Command                        | What it tests                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `!nodes` / `!status`           | Authenticated request to every node, their plugins, who owns the voice                          |
| `!play <query>`                | Bot plugins first; if nothing is found (e.g. a YouTube URL) the other nodes are asked           |
| `!play yt:<query>`             | Search and audio on the node with the youtube plugin, streamed to the bot (`sc:` `sp:` `tts:`)  |
| `!search <query>`              | Only show the results and which node found them                                                 |
| `!trace [on\|off\|msg\|wire\|audio]` | Print what this node sends to / receives from MQTT (or `NET_DEBUG=1` in `.env`)             |
| `!route yt:<query> [n]`        | Router: relay a few foreign tracks, or hand the voice off when most tracks are foreign          |
| `!handoff <node>` / `!reclaim` | Move the Discord voice session to another node and take it back                                 |
| `!selftest [failover]`         | Automated: pairing, plugins, stream, relay, handoff, executor playback, reclaim (+ node crash)  |
| `!kill <node>`                 | Crash a node (`ALLOW_REMOTE_KILL=1`) and watch the bot take the voice back                      |
| `!stop` `!skip` `!leave`       | Housekeeping                                                                                    |

Change `NODES` to give nodes different plugins and see the router choose differently, for example
`NODES=bot-1:soundcloud+youtube,yt-1:youtube,tts-1:tts` makes YouTube local to the bot.

## Notes

- Voice hand-off needs a real voice session: the bot joins your channel, then `yt-1` takes over through the relay adapter. If the
  executor never gets audio out, check that `yt-1` can reach Discord's voice servers (UDP) from where it runs.
- Search for `yt:`/`sc:` needs internet from the node that owns the plugin; `tts:` uses the TTS plugin.
- Keys live in `KEY_DIR` (default `.keys/`, git-ignored). Never copy a `.key` file, only `.key.pub`.
