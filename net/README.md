<img width="2172" height="724" alt="ZiPlayer NET" src="https://github.com/user-attachments/assets/5247fd4b-dbe0-4702-beb9-ef6eecdca569" />

Connect several ZiPlayer processes ("nodes") over MQTT.

- **Stream transfer** – the node whose plugins resolve a track (the _owner streamInfo_) sends the compressed audio (Opus, or the
  `arbitrary` containers official plugins return) to the node that plays it.
- **Voice hand-off** – the node that called `player.connect()` (the _owner connection_) can hand the Discord voice session to
  another node, which plays instead. The owner keeps the gateway and the queue; the gateway adapter replays the latest cached
  voice-server update when a hand-off starts after the initial join.
- **Auto routing** – `routeTracks()` decides per batch of tracks: keep the voice and pull a few foreign tracks (_relay_), or move
  the voice to the node that can play most of them (_handoff_).

## Quick start

`@ziplayer/net` connects separate ZiPlayer processes. Each process needs a unique `nodeId`, the same `networkId`, an MQTT
connection, and a pinned public key for every peer it trusts. Use Node.js 20.3 or newer.

Install the packages used by the examples:

```bash
npm install ziplayer @ziplayer/net @ziplayer/plugin @discordjs/voice discord.js mqtt
```

On the provider node, create a manager with the source plugin and opt in to search, stream, and voice requests:

```js
import { PlayerManager } from "ziplayer";
import { YouTubePlugin } from "@ziplayer/plugin";
import { MqttTransport, ZiNet } from "@ziplayer/net";

const manager = new PlayerManager({ plugins: [new YouTubePlugin()] });
const net = new ZiNet({
	nodeId: "yt-1",
	networkId: "music-prod",
	keyFile: "./keys/yt-1.key",
	trust: [{ nodeId: "bot-1", publicKey: botPublicKey }],
	transport: new MqttTransport({
		url: process.env.MQTT_URL, // Prefer mqtts://
		username: process.env.MQTT_USERNAME,
		password: process.env.MQTT_PASSWORD,
	}),
	manager,
});

await net.start();
net.provideStreams({ allow: (track) => track.source === "youtube" });
net.provideSearch();
net.acceptVoice({ allow: (_guildId, peerId) => peerId === "bot-1" });
```

On the Discord owner node, pass `discordJsGateway(client)` and the pinned provider key when constructing `ZiNet`. Attach the
network extension to players. Search results from another node are marked with their owner automatically:

```js
import { PlayerManager } from "ziplayer";
import { discordJsGateway, MqttTransport, ZiNet } from "@ziplayer/net";

const manager = new PlayerManager();
const net = new ZiNet({
	nodeId: "bot-1",
	networkId: "music-prod",
	keyFile: "./keys/bot-1.key",
	trust: [{ nodeId: "yt-1", publicKey: ytPublicKey }],
	transport: new MqttTransport({ url: process.env.MQTT_URL }),
	manager,
	gateway: discordJsGateway(client),
});

await net.start();
const player = await manager.create(guildId, { extensions: [net.extensionClass()] });
await player.connect(voiceChannel);

const { tracks } = await net.search("yt:lofi hip hop");
const route = await net.routeTracks(player, tracks);
if (!route.applied) throw route.error ?? new Error(`Routing failed: ${route.mode}`);
await player.play(tracks[0]);
```

See [Detailed guide](#detailed-guide) for peer-key setup, role permissions, relay vs hand-off, and lifecycle details. For a
complete runnable cluster, see [`examples/net`](../examples/net).

## Detailed guide

### How the nodes work together

Each process owns its own `PlayerManager`, plugins, and `ZiNet` instance. The Discord owner has the Discord client and gateway;
provider nodes run the plugins that supply search results or streams; a voice executor accepts a delegated connection. These roles
can be combined in one process. Run each node in a separate process because `PlayerManager` is process-scoped.

- **Relay:** the Discord owner stays connected and imports a provider's compressed stream over MQTT. The player's net extension is
  required on the owner.
- **Hand-off:** the owner releases the voice connection and a selected executor joins voice and plays there. The owner keeps the
  gateway and queue; `discordJsGateway(client)` is required on the owner and `acceptVoice()` on the executor.

### Install and configure MQTT

`@ziplayer/net` has peer dependencies on `ziplayer` and `@discordjs/voice`; `mqtt` is optional unless using `MqttTransport`.
Install `mqtt` explicitly for MQTT transport. `MqttTransport` defaults to MQTT protocol version 5; set `protocolVersion: 4` for a
broker that only supports MQTT 3.1.1.

```js
const transport = new MqttTransport({
	url: process.env.MQTT_URL, // mqtts://broker.example.com:8883
	username: process.env.MQTT_USERNAME,
	password: process.env.MQTT_PASSWORD,
	clientId: `ziplayer-${nodeId}`,
	protocolVersion: 5,
});
```

Use the same `networkId` on nodes in one cluster and a different value for independent clusters sharing the broker. Every `nodeId`
must be unique and must not contain `/`, `+`, or `#`. Use TLS (`mqtts://`) and broker authentication; the broker is not a trust
authority for peers.

### Create a node and pin peers

Create one `ZiNet` instance per process. `keyFile` loads an existing Ed25519 private key or creates one, along with a
`<keyFile>.pub` public-key file. Keep the private `.key` file private and distribute only `.key.pub`.

```js
const net = new ZiNet({
	nodeId,
	networkId,
	keyFile: `./keys/${nodeId}.key`,
	trust: [{ nodeId: peerId, publicKey: fs.readFileSync(peerPublicKeyPath, "utf8"), roles: ["*"] }],
	transport,
	manager, // Required to serve streams/search or accept voice
	gateway: isDiscordOwner ? discordJsGateway(client) : undefined,
});

await net.start();
```

For manual pairing, listen for `peerDiscovered`, compare its fingerprint with the peer over a trusted channel, then call
`net.node.acceptPeer(peerId, verifiedFingerprint, roles)` on **both** nodes. This adds the peer to the in-memory trust store;
persist approved keys in configuration if they must survive a restart. Static `trust` entries pin public keys at startup and are
preferable for production.

```js
net.node.on("peerDiscovered", ({ nodeId, fingerprint }) => {
	console.log(`Verify ${nodeId} out of band: ${fingerprint}`);
});

// On the provider, after verifying the bot's fingerprint:
net.node.acceptPeer("bot-1", verifiedBotFingerprint, ["provide-search", "provide-stream", "delegate-voice"]);

// On the bot, after verifying the provider's fingerprint:
net.node.acceptPeer("yt-1", verifiedYtFingerprint, ["accept-voice"]);
```

`roles` describe what the peer is allowed to ask **this node** to do. The default `["*"]` is convenient for a trusted private
cluster; use only the needed roles for least privilege:

| Role             | Grants the peer permission to ask this node to…                |
| ---------------- | -------------------------------------------------------------- |
| `provide-search` | Search this node's plugins                                     |
| `provide-stream` | Open streams resolved by this node                             |
| `delegate-voice` | Ask this node to accept/execute a voice hand-off               |
| `accept-voice`   | Send delegated voice gateway events/player events to this node |

For example, the provider's trust entry for the bot should include `provide-search`, `provide-stream`, and `delegate-voice`. The
bot's trust entry for the provider should include `accept-voice` when using hand-off.

### Provide search and streams

Only enable capabilities a node should expose. Search and stream requests are independently opt-in:

```js
net.provideSearch({
	allow: (query, peerId) => peerId === "bot-1" && query.length <= 200,
	maxResults: 25,
});

net.provideStreams({
	allow: (track, peerId) => peerId === "bot-1" && track.source === "youtube",
});
```

`provideSearch()` uses the node's `PlayerManager` plugins. `provideStreams()` resolves each requested track through the local
manager/plugins; an `allow` callback can enforce source or peer allowlists. A remote node never fetches a URL supplied by a peer.
Only compressed audio is transferable: Opus streams/containers and supported `arbitrary` containers, never raw PCM.

On the Discord owner, attach the network extension to every player that may relay or hand off playback:

```js
const player = await manager.create(guildId, { extensions: [net.extensionClass()] });
```

`net.extensionClass()` handles remote stream resolution for relay and remote playback commands for hand-off. Without it, a player
will not use `@ziplayer/net` for playback.

### Search the cluster

```js
const result = await net.search("yt:lofi hip hop", { requestedBy: userId });
console.log(result.node, result.nodes, result.tracks);
await player.play(result.tracks[0]);
```

`yt:`, `sc:`, `sp:`, and `tts:` target the corresponding plugin source. Unknown prefixes are treated as part of the query. Without
a source prefix, `search()` tries local plugins first, then trusted online nodes that opted into `provideSearch()`. Tracks
returned by a peer are stamped with that peer as `metadata.net.owner`; applications should not set a peer owner from untrusted
input. If your application already has a trusted `Track` from a specific node, `markTrack()` sets its stream owner:

```js
import { markTrack } from "@ziplayer/net";

await player.play(markTrack(track, "yt-1"));
```

Useful options:

```js
await net.search("lofi", { local: "last", merge: true, limit: 20 });
await net.searchOn("yt-1", "lofi", { timeoutMs: 10_000 });
```

`NetSearchOptions` supports `source`, `peers`, `local` (`first`, `last`, `only`, or `never`), `merge`, `limit`, `timeoutMs`,
`signal`, and `requestedBy`. `net.search()` returns the first successful result by default. With `merge: true`, it asks all
eligible nodes and de-duplicates the combined tracks. `searchOn()` targets one specific peer.

Use `searchAliases` in `ZiNetOptions` to add or override prefixes, for example `{ ytm: "youtube" }`.

### Relay streams or hand off voice

To keep playback on the connected Discord owner, play a marked track from `net.search()`; the extension pulls its stream from the
provider. To let the router choose relay or hand-off for a batch:

```js
const route = await net.routeTracks(player, tracks, {
	handoffThreshold: 0.5,
	apply: true, // Default; marks owners and applies voice hand-off/reclaim when needed
});
if (!route.applied) throw route.error ?? new Error(`Could not apply route: ${route.mode}`);

for (const track of tracks) await player.play(track);
```

`routeTracks()` returns a plan with `mode`, `executor`, per-track `owners`, and `applied`. With `apply: false`, it only plans. In
`relay` mode, the Discord connection stays on this node and foreign tracks are streamed from their owners. In `handoff` mode, the
router delegates voice to the best executor and marks tracks the executor cannot resolve for stream transfer.

For explicit voice control, first connect the owner player and make sure it is idle:

```js
await net.delegateVoice(player, "yt-1"); // Requires gateway on this node; voice must not be playing
await player.play(track);

await net.reclaimVoice(player); // Return voice to the owner
```

Reclaim stops the remote current track, preserves queued tracks, and refreshes the gateway voice state before reconnecting the
owner to the channel. This avoids leaving a stale remote playback session behind or reusing an unchanged Discord voice session.

The executor must call `net.acceptVoice()` and pass an authorization check if configured. By default, the executor resolves the
track with its own plugins. Set `{ streamFrom: "owner" }` in `delegateVoice()` when the owner should provide the audio stream. The
owner reconnects locally if delegation fails or the executor goes offline, provided its gateway adapter can resolve the original
channel.

### Lifecycle and errors

- Call `await net.start()` once before making network requests or accepting traffic.
- Use `await net.stop()` during shutdown. It closes provided/imported streams, ends delegations, and closes the transport.
- Catch rejected `search()`, `player.play()`, and delegation operations at the application boundary. `NetError.code` can be used
  to distinguish cases such as `NO_RESULTS`, `NOT_CONNECTED`, `NO_GATEWAY`, `FORBIDDEN`, and `TIMEOUT`.
- If a peer disappears, presence/last-will detection closes sessions. A delegated owner attempts to reclaim voice locally.

## Security model

| What                                | Protection                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control messages, voice credentials | Always encrypted end-to-end (ChaCha20-Poly1305), authenticated, replay-protected                                                                                                                                                                                                                            |
| Audio (Opus)                        | Clear by default, `encryptAudio: true` to encrypt                                                                                                                                                                                                                                                           |
| Node identity                       | Ed25519 keys, **pinned per node**; unknown nodes are rejected                                                                                                                                                                                                                                               |
| Broker                              | Untrusted: it only sees ciphertext, audio, node ids and sizes (use TLS to hide those)                                                                                                                                                                                                                       |
| Peer input                          | Only compressed audio is accepted (raw PCM is refused; `allowedStreamTypes` can narrow it to Opus containers); a node never fetches a URL a peer gives it (a provider resolves requested tracks through its own plugins: use `allow`); relayed gateway payloads are limited to op 4 for the delegated guild |

The 3-message handshake (`hs1` → `hs2` → `hs3`) is a SIGMA-style exchange built from `node:crypto` (ephemeral X25519 + Ed25519
signatures over the transcript + HKDF). It is a small custom protocol: **get it reviewed before protecting anything valuable.**

## Debugging what goes over MQTT

Every `NetNode` (also `net.node`) emits a `debug` event. Without listeners it costs nothing.

```js
const { formatNetDebug } = require("@ziplayer/net");
net.node.on("debug", (e) => console.log(formatNetDebug(e)));
```

```
[net:bot-1] → MQTT PUBLISH zi/v1/ziplayer-test/node/yt-1/in qos1 188B control(encrypted) [02a1b2c3…]
[net:bot-1] → control to yt-1 net.search #3 188B {"query":"https://www.youtube.com/watch?v=PqpCRSOUuIE","limit":1}
[net:bot-1] ← control from yt-1 reply re#3 3120B {"tracks":[{"id":"PqpCRSOUuIE","title":"…"}],…}
```

- `layer: "wire"`: the exact MQTT message the broker sees (topic, qos, retain, size, first bytes). Control frames are ciphertext.
- `layer: "message"`: the same traffic decoded: `type`, request `id` / `re`, `body`, `peer`. Handshakes, requests, notifications
  and replies.
- `layer: "info"`: routing notes such as `search "lofi" → yt-1`.
- Audio frames are only reported with `debugAudio: true` (very chatty). Bodies are redacted (`token`, `session_id`, `password`, …)
  unless `debugRedact: false`; treat logs with raw bodies as secrets because voice tokens pass through here.

## Try it for real

[`examples/net`](../examples/net) runs a real Discord bot (commands via `messageCreate`) with provider nodes that have different
real plugins, over Mosquitto, including an automated `!selftest` for stream transfer, relay, hand-off and failover.

## Notes and limits

- `PlayerManager` is a process singleton, so one process = one node (test with several processes).
- Delegate voice while nothing is playing; the next `play()` is driven on the executor.
- MQTT is fine for control; for audio it adds broker hops and has no back-pressure, so streaming uses credit-based flow control
  and QoS 1. The `Transport` interface lets other carriers (WebSocket, TCP, ...) replace it later.
- Web/WebAudio voice and multi-output fan-out (mirroring one queue to several remote outputs) are not implemented yet.
- Core changes this package relies on: `manager.resolveStream()` and `player.disconnect({ silent: true })`.
