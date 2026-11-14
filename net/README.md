# @ziplayer/net

Connect several ZiPlayer processes ("nodes") over MQTT.

- **Stream transfer** – the node whose plugins resolve a track (the _owner streamInfo_) sends the compressed audio (Opus, or the
  `arbitrary` containers official plugins return) to the node that plays it.
- **Voice hand-off** – the node that called `player.connect()` (the _owner connection_) can hand the Discord voice session to
  another node, which plays instead. The owner keeps the gateway and the queue.
- **Auto routing** – `routeTracks()` decides per batch of tracks: keep the voice and pull a few foreign tracks (_relay_), or move
  the voice to the node that can play most of them (_handoff_).

```
npm install @ziplayer/net mqtt
```

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

## Pairing nodes

Every node needs a key and has to trust the others. Easiest flow:

```js
const node = new NetNode({ nodeId: "eu-1", keyFile: "./eu-1.key", transport, networkId: "prod" }); // key created if missing
node.on("peerDiscovered", ({ nodeId, fingerprint }) => console.log(nodeId, fingerprint)); // compare out-of-band
node.acceptPeer("eu-2", fingerprintYouVerified, ["provide-stream"]); // both sides must accept each other
```

Or pin keys up front: `trust: [{ nodeId, publicKey: pem, roles: ["provide-stream", "accept-voice", "delegate-voice"] }]`. Roles
default to `*`; narrow them for least privilege.

## Usage

```js
const { ZiNet, MqttTransport, discordJsGateway, markTrack } = require("@ziplayer/net");

const net = new ZiNet({
	nodeId: "eu-1",
	networkId: "prod",
	keyFile: "./eu-1.key",
	trust: [{ nodeId: "us-1", publicKey: fs.readFileSync("us-1.pub", "utf8") }],
	transport: new MqttTransport({ url: "mqtts://broker:8883", username, password }),
	manager, // local PlayerManager
	gateway: discordJsGateway(client), // only on the node that owns the Discord gateway
});
await net.start();

// Node that can resolve YouTube: serve streams
net.provideStreams({ allow: (track) => track.source === "youtube" });

// Node that plays on behalf of others
net.acceptVoice();

// Owner: players get the extension so remote streams and delegated playback work
const player = await manager.create(guildId, { extensions: [net.extensionClass()] });
await player.connect(voiceChannel);

// Pull one track from another node
await player.play(markTrack(track, "us-1"));

// Or let the router decide (relay vs handoff), then play as usual
await net.routeTracks(player, tracks);

// Manual hand-off / take-back (call while idle)
await net.delegateVoice(player, "us-1");
await net.reclaimVoice(player);
```

If an executor disappears (MQTT last-will), the owner reconnects the voice locally.

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
