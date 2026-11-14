#!/usr/bin/env node
/**
 * @ziplayer/net cluster test: a REAL Discord bot (discord.js, driven by `messageCreate`) plus provider nodes, all REAL plugins,
 * linked over an MQTT broker (Mosquitto). Everything is configured through `.env` (see .env.example).
 *
 *   node test-cluster.js                 start every node of NODES as its own process (Ctrl+C stops them all)
 *   node test-cluster.js --node=yt-1     start only one node (e.g. on another machine; copy the *.key.pub files first)
 *   node test-cluster.js --keys          create missing node keys, print fingerprints, exit
 *   node test-cluster.js --env=./x.env   use another env file
 *
 * In Discord (prefix from COMMAND_PREFIX), from inside a voice channel:
 *   !help | !nodes | !status
 *   !play <query>            search on the bot's own plugins; if nothing is found, ask the other nodes (e.g. a YouTube URL)
 *   !play yt:<query>         search AND audio on the node that has the youtube plugin, streamed to the bot (also sc: sp: tts:)
 *   !search <query>          only show the search results (and which node found them); nothing is played
 *   !trace [on|off|msg|wire|audio]   print what this node sends to / receives from MQTT (also: NET_DEBUG=1 in .env)
 *   !route yt:<query> [n]    plan relay/handoff for n tracks (default 20), apply it and start playing
 *   !handoff <node> | !reclaim | !stop | !skip | !leave
 *   !selftest [failover]     automated checks of pairing, stream transfer, relay, handoff, reclaim (and failover)
 *   !kill <node>             crash a node (needs ALLOW_REMOTE_KILL=1)
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { fork } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
function load(name, rel) {
	try {
		return require(path.join(ROOT, rel));
	} catch (e) {
		throw new Error(
			`Cannot load ${name}: build it first (npm install --prefix ${rel.split("/")[0]} && npm run build --prefix ${rel.split("/")[0]}).\n${e.message}`,
		);
	}
}

/* ───────────────────────────── configuration ───────────────────────────── */

function parseEnv(text) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, "");
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

function loadConfig(argv = process.argv.slice(2), env = process.env) {
	const args = Object.fromEntries(
		argv.map((a) => {
			const m = a.match(/^--([^=]+)(?:=(.*))?$/);
			return m ? [m[1], m[2] ?? true] : [a, true];
		}),
	);
	const envFile = path.resolve(typeof args.env === "string" ? args.env : path.join(__dirname, ".env"));
	const fileVars = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
	const get = (k, d = "") => (env[k] !== undefined && env[k] !== "" ? env[k] : (fileVars[k] ?? d));
	const flag = (k) => ["1", "true", "yes", "on"].includes(String(get(k, "0")).toLowerCase());

	const nodes = get("NODES", "bot-1:soundcloud,yt-1:youtube,tts-1:tts+attachments")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			const [id, list = ""] = s.split(":");
			return {
				id: id.trim(),
				sources: list
					.split("+")
					.map((x) => x.trim())
					.filter(Boolean),
			};
		});
	if (nodes.length < 2) throw new Error("NODES needs at least two nodes");
	return {
		args,
		envFile,
		envFileFound: fs.existsSync(envFile),
		discordToken: get("DISCORD_TOKEN"),
		prefix: get("COMMAND_PREFIX", "!"),
		allowedGuild: get("ALLOWED_GUILD_ID"),
		allowedUsers: new Set(
			get("ALLOWED_USER_IDS")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
		mqttUrl: get("MQTT_URL", "mqtt://127.0.0.1:1883"),
		mqttUsername: get("MQTT_USERNAME"),
		mqttPassword: get("MQTT_PASSWORD"),
		mqttProtocol: Number(get("MQTT_PROTOCOL", "5")),
		netId: get("NET_ID", "ziplayer-test"),
		nodes,
		discordNode: get("DISCORD_NODE") || nodes[0].id,
		botServes: flag("BOT_SERVES"),
		keyDir: path.resolve(__dirname, get("KEY_DIR", "./.keys")),
		encryptAudio: flag("ENCRYPT_AUDIO"),
		query: get("TEST_QUERY", "lofi hip hop"),
		handoffThreshold: Number(get("HANDOFF_THRESHOLD", "0.5")),
		allowRemoteKill: flag("ALLOW_REMOTE_KILL"),
		debug: flag("DEBUG"),
		// what the net layer prints: 0 | msg | wire | 1/all   (+ NET_DEBUG_AUDIO=1 for every audio frame)
		netDebug: ["1", "true", "yes", "on"].includes(get("NET_DEBUG", "0").toLowerCase()) ? "all" : get("NET_DEBUG", "0").toLowerCase(),
		netDebugAudio: flag("NET_DEBUG_AUDIO"),
	};
}

const keyFile = (cfg, id) => path.join(cfg.keyDir, `${id}.key`);
const pubFile = (cfg, id) => `${keyFile(cfg, id)}.pub`;

function ensureKeys(cfg, ids) {
	const net = load("@ziplayer/net", "net/dist");
	fs.mkdirSync(cfg.keyDir, { recursive: true });
	for (const id of ids) {
		const r = net.loadOrCreateIdentity(keyFile(cfg, id));
		console.log(
			`key ${id}: ${r.created ? "created" : "exists "}  fingerprint ${net.fingerprint(r.identity.publicKey).slice(0, 32)}…`,
		);
	}
}

function trustFor(cfg, id) {
	const trust = [];
	for (const n of cfg.nodes) {
		if (n.id === id) continue;
		if (!fs.existsSync(pubFile(cfg, n.id))) {
			console.warn(`[${id}] missing ${pubFile(cfg, n.id)}: node "${n.id}" will not be trusted (copy its .pub file here)`);
			continue;
		}
		trust.push({ nodeId: n.id, publicKey: fs.readFileSync(pubFile(cfg, n.id), "utf8") });
	}
	return trust;
}

/* ───────────────────────────── a node ───────────────────────────── */

const SEARCHABLE = ["youtube", "soundcloud", "spotify", "tts"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Prints the net layer's `debug` events. `mode`: "all" (wire + message + info), "msg" (decoded messages + info),
 * "wire" (raw MQTT only), anything else = off. Returns a function to change the mode at runtime.
 */
function makeTracer(node, formatNetDebug, initial, out = console.log) {
	let mode = initial;
	const layers = () => (mode === "all" ? ["wire", "message", "info"] : mode === "msg" ? ["message", "info"] : mode === "wire" ? ["wire"] : []);
	const listener = (e) => layers().includes(e.layer) && out(formatNetDebug(e));
	const apply = (next) => {
		mode = next;
		node.off("debug", listener);
		if (layers().length) node.on("debug", listener);
		return mode;
	};
	apply(initial);
	return apply;
}

/**
 * Starts one node. `hooks` exists for automated tests of this file (inject discord.js, plugins, simulated voice); normal runs
 * pass nothing and get the real discord.js client and the real plugins.
 */
async function startNode(id, cfg, hooks = {}) {
	const spec = cfg.nodes.find((n) => n.id === id);
	if (!spec) throw new Error(`"${id}" is not in NODES`);
	const isBot = id === cfg.discordNode;
	const { PlayerManager } = load("ziplayer", "core/dist");
	const net = load("@ziplayer/net", "net/dist");

	const log = (...a) => console.log(`[${id}]`, ...a);
	const st = { resolved: 0, bytesIn: 0 };
	const events = [];
	process.on("uncaughtException", (e) => log("uncaughtException:", e.message));
	process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

	// real plugins
	let plugins = hooks.plugins;
	if (!plugins) {
		const p = load("@ziplayer/plugin", "plugins/dist");
		const classes = {
			youtube: p.YouTubePlugin,
			soundcloud: p.SoundCloudPlugin,
			spotify: p.SpotifyPlugin,
			tts: p.TTSPlugin,
			attachments: p.AttachmentsPlugin,
		};
		plugins = spec.sources.map((s) => {
			if (!classes[s]) throw new Error(`Unknown plugin "${s}" for ${id}`);
			return new classes[s]();
		});
	}
	const manager = new PlayerManager({ autoCleanup: false, plugins });
	const origResolve = manager.resolveStream.bind(manager);
	manager.resolveStream = async (...a) => (st.resolved++, origResolve(...a));
	const origCreate = manager.create.bind(manager);
	manager.create = async (...a) => {
		const p = await origCreate(...a);
		hooks.onPlayerCreated?.(p);
		return p;
	};
	manager.on("trackStart", (player, track) =>
		events.push({ at: Date.now(), type: "trackStart", guildId: player.guildId, title: track?.title, source: track?.source }),
	);
	manager.on("playerError", (player, err) =>
		events.push({ at: Date.now(), type: "error", guildId: player.guildId, message: err?.message }),
	);

	// real Discord client (bot node only)
	let client = null;
	if (isBot) {
		let discord = hooks.discord;
		if (!discord) {
			try {
				discord = require(require.resolve("discord.js", { paths: [__dirname, ROOT] }));
			} catch {
				throw new Error("discord.js is not installed: run `npm install --prefix examples/net`");
			}
		}
		client = new discord.Client({
			intents: [
				discord.GatewayIntentBits.Guilds,
				discord.GatewayIntentBits.GuildVoiceStates,
				discord.GatewayIntentBits.GuildMessages,
				discord.GatewayIntentBits.MessageContent,
			],
		});
	}

	const subst = (s) => s.replace(/\{node\}/g, id);
	const zi = new net.ZiNet({
		nodeId: id,
		networkId: cfg.netId,
		identity: hooks.identity ?? net.loadOrCreateIdentity(keyFile(cfg, id)).privateKeyPem,
		trust: hooks.trust ?? trustFor(cfg, id),
		transport:
			hooks.transport ??
			new net.MqttTransport({
				url: cfg.mqttUrl,
				clientId: `zi-${id}-${process.pid}`,
				username: cfg.mqttUsername ? subst(cfg.mqttUsername) : undefined,
				password: cfg.mqttPassword ? subst(cfg.mqttPassword) : undefined,
				protocolVersion: cfg.mqttProtocol,
			}),
		manager,
		gateway: client ? net.discordJsGateway(client) : undefined,
		encryptAudio: cfg.encryptAudio,
		debugAudio: cfg.netDebugAudio,
		requestTimeoutMs: 30_000,
		debug: cfg.debug ? (m, ...a) => console.log(m, ...a) : undefined,
	});
	const origFrame = zi.importer.onFrame.bind(zi.importer);
	zi.importer.onFrame = (peer, frame) => ((st.bytesIn += frame.payload.length), origFrame(peer, frame));

	const status = () => ({
		id,
		sources: zi.localSources(),
		online: zi.node.onlinePeers(),
		resolved: st.resolved,
		bytesIn: st.bytesIn,
		executing: [...zi.executions.keys()],
		delegated: [...zi.delegations.keys()],
		events: events.slice(-20),
	});
	zi.node.handle("test.status", status);
	const setTrace = makeTracer(zi.node, net.formatNetDebug, cfg.netDebug, (line) => log(line));
	if (cfg.allowRemoteKill) {
		zi.node.handle("test.kill", () => {
			log("test.kill received: crashing on purpose");
			setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
			return "killing";
		});
	}

	await zi.start();
	zi.acceptVoice();
	if (!isBot || cfg.botServes) {
		zi.provideStreams({ allow: (track) => spec.sources.includes(track.source) });
		zi.provideSearch();
	}
	log(
		`ready · plugins: ${spec.sources.join(", ") || "-"} · mqtt ${cfg.mqttUrl} · net ${cfg.netId}${isBot ? " · discord bot" : ""}`,
	);

	if (isBot) attachDiscordCommands({ id, cfg, zi, manager, net, client, events, st, log, hooks, setTrace });
	if (isBot && !hooks.noLogin) {
		if (!cfg.discordToken) throw new Error("DISCORD_TOKEN is empty (set it in .env)");
		await client.login(cfg.discordToken);
		log(`logged in as ${client.user?.tag}`);
	}
	return { id, zi, manager, client, status, stop: () => zi.stop() };
}

/* ───────────────────────── Discord command handling ───────────────────────── */

function attachDiscordCommands({ id, cfg, zi, manager, net, client, events, st, log, setTrace = () => "off" }) {
	const peers = cfg.nodes.filter((n) => n.id !== id);
	const ask = (peer, type, body, timeoutMs = 30_000) => zi.node.request(peer, type, body, { timeoutMs });
	const specFor = (source) => (source === "tts" ? "tts:Hello from the ZiPlayer net test" : cfg.query);

	/**
	 * Cluster-wide search. `yt:lofi` goes to the node that has the youtube plugin; a plain query or a URL is tried on this
	 * bot's plugins first and then on every node that serves search. Tracks come back marked with the node that found them.
	 */
	async function findTracks(text, limit = 5) {
		const result = await zi.search(text, { limit, requestedBy: "net-test" });
		return { tracks: result.tracks, node: result.node, result };
	}

	async function getPlayer(message, { connect = true } = {}) {
		const guildId = message.guildId;
		let p = manager.get(guildId);
		if (!p) p = await manager.create(guildId, { extensions: [zi.extensionClass()] });
		if (connect && !p.connection && !zi.delegationFor(guildId)) {
			const vc = message.member?.voice?.channel;
			if (!vc) throw new Error("Join a voice channel first");
			await p.connect(vc);
		}
		return p;
	}

	async function waitStart(guildId, since, ms = 25_000) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (events.some((e) => e.at >= since && e.guildId === guildId && e.type === "trackStart")) return true;
			const err = events.find((e) => e.at >= since && e.guildId === guildId && e.type === "error");
			if (err) throw new Error(`player error: ${err.message}`);
			await sleep(150);
		}
		return false;
	}

	const peerStatus = (peer) => ask(peer, "test.status", undefined, 8000);
	const fmtOwners = (owners) =>
		Object.entries(owners.reduce((a, o) => ((a[o ?? id] = (a[o ?? id] || 0) + 1), a), {}))
			.map(([k, v]) => `${k}×${v}`)
			.join(", ");

	const commands = {
		async help(m) {
			await m.reply(
				[
					"**ZiPlayer net test**",
					"`play <q>` bot plugins first, then the other nodes · `play yt:<q>` / `sc:` / `sp:` / `tts:` search + audio on the node with that plugin",
					"`search <q>` show results and which node found them · `trace [on|off|msg|wire|audio]` print MQTT traffic of this node",
					"`route yt:<q> [n]` plan relay/handoff for n tracks and play · `handoff <node>` · `reclaim` · `stop` · `skip` · `leave`",
					"`nodes` · `status` · `selftest [failover]` · `kill <node>` (ALLOW_REMOTE_KILL=1)",
				].join("\n"),
			);
		},

		async nodes(m) {
			const lines = [];
			for (const p of peers) {
				try {
					const s = await peerStatus(p.id);
					lines.push(
						`✅ **${p.id}** plugins: ${s.sources.join(", ") || "-"} · resolved ${s.resolved} · executing ${s.executing.join(",") || "-"}`,
					);
				} catch (e) {
					lines.push(`❌ **${p.id}** ${zi.node.isOnline(p.id) ? "online but " : "offline: "}${e.message}`);
				}
			}
			await m.reply(`**${id}** (bot) plugins: ${zi.localSources().join(", ") || "-"}\n${lines.join("\n")}`);
		},

		async status(m) {
			const p = manager.get(m.guildId);
			const d = zi.delegationFor(m.guildId);
			await m.reply(
				[
					`voice: ${
						d ? `delegated to **${d.executor}**`
						: p?.connection ? "on this bot"
						: "not connected"
					}`,
					`playing: ${p?.isPlaying ? `**${p.currentTrack?.title}**` : "no"} · queue ${p?.queueSize ?? 0}`,
					`bytes pulled from other nodes so far: ${st.bytesIn}`,
				].join("\n"),
			);
		},

		async search(m, arg) {
			if (!arg) return void (await m.reply("Usage: `search <query>` or `search yt:<query>`"));
			const { tracks, node, result } = await findTracks(arg, 5);
			const lines = tracks.map(
				(t, i) => `${i + 1}. **${t.title}** (${t.source}) · found on **${t.metadata?.net?.owner ?? id}**${t.duration ? ` · ${t.duration}s` : ""}`,
			);
			await m.reply(`${result.playlist ? `📃 playlist **${result.playlist.name}**\n` : ""}${lines.join("\n")}\n_(answered by ${node === id ? "this bot" : node})_`.slice(0, 1990));
		},

		async trace(m, arg) {
			const a = (arg || "").trim().toLowerCase();
			if (a === "audio") {
				zi.node.options.debugAudio = !zi.node.options.debugAudio;
				return void (await m.reply(`audio frames in trace: ${zi.node.options.debugAudio ? "on" : "off"}`));
			}
			const mode = a === "off" || a === "0" ? "off" : a === "msg" || a === "wire" ? a : "all";
			await m.reply(`net trace: **${setTrace(mode)}** (printed in the console of ${id})`);
		},

		async play(m, arg) {
			if (!arg) return void (await m.reply("Usage: `play <query>` or `play yt:<query>`"));
			const player = await getPlayer(m);
			const { tracks, node } = await findTracks(arg, 1);
			const track = tracks[0];
			if (node !== id) net.markTrack(track, node);
			const since = Date.now();
			const bytes0 = st.bytesIn;
			await player.play(track, { requestedBy: m.author.id });
			const d = zi.delegationFor(m.guildId);
			const started = await waitStart(m.guildId, since).catch((e) => e.message);
			const where = d ? `played by **${d.executor}**` : "played here";
			const from =
				node === id ? "found and resolved locally" : (
					`audio streamed from **${node}**${st.bytesIn > bytes0 ? ` (${st.bytesIn - bytes0} bytes)` : ""}`
				);
			await m.reply(
				`${started === true ? "▶️" : "⚠️"} **${track.title}** (${track.source}) · ${from} · ${where}${started === true ? "" : ` · not confirmed: ${started === false ? "no trackStart in 25s" : started}`}`,
			);
		},

		async route(m, arg) {
			const parts = arg.split(/\s+/);
			const count = /^\d+$/.test(parts[parts.length - 1] ?? "") ? Number(parts.pop()) : 20;
			const text = parts.join(" ");
			if (!text) return void (await m.reply("Usage: `route yt:<query> [count]`"));
			const player = await getPlayer(m);
			const { tracks: found, node } = await findTracks(text, Math.min(count, 25));
			const tracks = Array.from({ length: count }, (_, i) => ({
				...found[i % found.length],
				id: `${found[i % found.length].id}#${i}`,
			}));
			const plan = await zi.routeTracks(player, tracks, { handoffThreshold: cfg.handoffThreshold });
			let reply = `**${plan.mode}**${plan.executor ? ` → ${plan.executor}` : ""} · tracks resolved on: ${fmtOwners(plan.owners)} · applied: ${plan.applied}${plan.error ? ` (${plan.error.message})` : ""}`;
			if (plan.applied || plan.mode === "local") {
				const since = Date.now();
				await player.play(tracks[0], { requestedBy: m.author.id });
				player.queue.addMultiple(tracks.slice(1));
				const ok = await waitStart(m.guildId, since).catch((e) => e.message);
				reply += ` · ${ok === true ? "▶️ started" : `⚠️ ${ok === false ? "no trackStart" : ok}`} (source node: ${node})`;
			}
			await m.reply(reply);
		},

		async handoff(m, arg) {
			if (!arg) return void (await m.reply("Usage: `handoff <node>`"));
			const player = await getPlayer(m);
			if (player.isPlaying) await player.stop();
			await zi.delegateVoice(player, arg.trim());
			await m.reply(`🔀 voice handed to **${arg.trim()}** (this bot keeps the gateway and the queue)`);
		},

		async reclaim(m) {
			const player = await getPlayer(m, { connect: false });
			if (!zi.delegationFor(m.guildId)) return void (await m.reply("Voice is not delegated."));
			await zi.reclaimVoice(player);
			await m.reply("🔙 voice is back on this bot");
		},

		async stop(m) {
			await (await getPlayer(m, { connect: false })).stop();
			await m.reply("⏹️ stopped");
		},
		async skip(m) {
			await (await getPlayer(m, { connect: false })).playNext();
			await m.reply("⏭️ skipped");
		},
		async leave(m) {
			const player = manager.get(m.guildId);
			if (player && zi.delegationFor(m.guildId)) await zi.reclaimVoice(player).catch(() => {});
			await manager.destroy(m.guildId);
			await m.reply("👋 left");
		},

		async kill(m, arg) {
			if (!cfg.allowRemoteKill) return void (await m.reply("Set ALLOW_REMOTE_KILL=1 to use this."));
			await ask(arg.trim(), "test.kill", undefined, 5000);
			await m.reply(`💥 ${arg.trim()} is crashing; watch the failover with \`status\``);
		},

		async selftest(m, arg) {
			const player = await getPlayer(m);
			// start from a clean slate: a track that is still playing (or queued) would hide new stream pulls
			await player.stop().catch(() => {});
			player.queue.clear?.();
			await sleep(1500);
			const lines = [];
			let fails = 0;
			const msg = await m.reply("🧪 selftest running…");
			const flush = () => msg.edit(lines.join("\n").slice(0, 1990) || "…").catch(() => {});
			const check = (name, ok, detail = "") => {
				if (!ok) fails++;
				lines.push(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
				return flush();
			};
			const searchable = (n) => n.sources.filter((s) => SEARCHABLE.includes(s));
			const localSource = searchable({ sources: zi.localSources() })[0];
			const foreignNode = peers.find((p) => searchable(p).some((s) => !zi.localSources().includes(s)));
			const foreignSource = foreignNode && searchable(foreignNode).find((s) => !zi.localSources().includes(s));

			try {
				// 1. pairing + plugins
				for (const p of peers) {
					const s = await peerStatus(p.id).catch((e) => ({ error: e.message }));
					const want = p.sources.slice().sort().join(",");
					await check(
						`${p.id} authenticated, plugins [${want}]`,
						!s.error && s.sources.slice().sort().join(",") === want,
						s.error || `got [${s.sources?.join(",")}]`,
					);
				}
				if (!foreignNode || !localSource) {
					await check("needs a searchable plugin on the bot and a different one on a provider", false, "adjust NODES");
				} else {
					// 2. stream transfer
					const found = (await findTracks(`${foreignSource}:${specFor(foreignSource)}`, 3)).tracks;
					const foreign = found[0];
					const before = (await peerStatus(foreignNode.id)).resolved;
					const bytes0 = st.bytesIn;
					const since = Date.now();
					await player.play(net.markTrack({ ...foreign }, foreignNode.id), { requestedBy: m.author.id });
					const started = await waitStart(m.guildId, since).catch(() => false);
					await sleep(500);
					await check(`stream: audio pulled from ${foreignNode.id}`, st.bytesIn > bytes0, `${st.bytesIn - bytes0} bytes`);
					await check(
						`stream: ${foreignNode.id} resolved it with its own ${foreignSource} plugin`,
						(await peerStatus(foreignNode.id)).resolved === before + 1,
					);
					await check("stream: trackStart on the bot", started === true);
					await player.stop();

					// 3. routing + handoff + reclaim
					const local = (await findTracks(`${localSource}:${specFor(localSource)}`, 1)).tracks[0];
					const list = (t, n, tag) => Array.from({ length: n }, (_, i) => ({ ...t, id: `${t.id}#${tag}${i}` }));
					let plan = await zi.routeTracks(player, list(local, 6, "a"), { handoffThreshold: cfg.handoffThreshold });
					await check("route: all local → local", plan.mode === "local", plan.mode);
					const mixed = [...list(local, 9, "b"), ...list(foreign, 1, "bf")];
					plan = await zi.routeTracks(player, mixed, { handoffThreshold: cfg.handoffThreshold });
					await check(
						"route: 1 foreign of 10 → relay",
						plan.mode === "relay" && mixed[9].metadata?.net?.owner === foreignNode.id,
						`${plan.mode}, owner ${mixed[9].metadata?.net?.owner}`,
					);
					plan = await zi.routeTracks(player, [...list(foreign, 20, "c"), ...list(local, 1, "cl")], {
						handoffThreshold: cfg.handoffThreshold,
					});
					await check(
						`route: 20 foreign of 21 → handoff to ${foreignNode.id}`,
						plan.mode === "handoff" && plan.applied,
						plan.error?.message || plan.mode,
					);
					if (plan.applied) {
						const es = await peerStatus(foreignNode.id);
						await check(`${foreignNode.id} executes this guild's voice`, es.executing.includes(m.guildId));
						const t0 = Date.now();
						await player.play({ ...foreign }, { requestedBy: m.author.id });
						const execStarted = await (async () => {
							const end = Date.now() + 25_000;
							while (Date.now() < end) {
								if (
									(await peerStatus(foreignNode.id)).events.some(
										(e) => e.at >= t0 && e.type === "trackStart" && e.guildId === m.guildId,
									)
								)
									return true;
								await sleep(500);
							}
							return false;
						})();
						await check(`track started on the executor ${foreignNode.id}, driven by the bot`, execStarted);
						await player.stop().catch(() => {});
						await zi.reclaimVoice(player);
						await check("reclaim: voice is back on the bot", Boolean(player.connection) && !zi.delegationFor(m.guildId));
					}

					// 4. failover
					if (arg === "failover") {
						if (!cfg.allowRemoteKill) await check("failover needs ALLOW_REMOTE_KILL=1", false);
						else {
							await player.stop().catch(() => {});
							const p2 = await zi.routeTracks(player, [...list(foreign, 20, "f"), ...list(local, 1, "fl")], {
								handoffThreshold: cfg.handoffThreshold,
							});
							if (!p2.applied) await check("failover: handoff established", false, p2.error?.message);
							else {
								await ask(foreignNode.id, "test.kill", undefined, 5000).catch(() => {});
								const end = Date.now() + 20_000;
								while (Date.now() < end && (zi.delegationFor(m.guildId) || !player.connection)) await sleep(250);
								await check(
									`failover: bot reclaimed the voice after ${foreignNode.id} crashed`,
									!zi.delegationFor(m.guildId) && Boolean(player.connection),
									`restart ${foreignNode.id} afterwards`,
								);
							}
						}
					}
				}
			} catch (e) {
				await check("selftest aborted", false, e.message);
			}
			lines.push(fails ? `\n**${fails} check(s) failed**` : "\n**all checks passed**");
			await flush();
		},
	};

	client.on("messageCreate", async (message) => {
		if (message.author?.bot || !message.guild || !message.content?.startsWith(cfg.prefix)) return;
		if (cfg.allowedGuild && message.guildId !== cfg.allowedGuild) return;
		if (cfg.allowedUsers.size && !cfg.allowedUsers.has(message.author.id)) return;
		const [name, ...rest] = message.content.slice(cfg.prefix.length).trim().split(/\s+/);
		const handler = commands[(name || "").toLowerCase()];
		if (!handler) return;
		log(`messageCreate ${message.author.tag ?? message.author.id}: ${message.content}`);
		try {
			await handler(message, rest.join(" "));
		} catch (e) {
			log("command failed:", e.stack || e.message);
			await message.reply(`❌ ${e.message}`).catch(() => {});
		}
	});
	return commands;
}

/* ───────────────────────────── launcher / entry ───────────────────────────── */

async function main() {
	const cfg = loadConfig();
	if (!cfg.envFileFound) console.warn(`(no env file at ${cfg.envFile}; copy .env.example to .env)`);

	if (cfg.args.keys)
		return void ensureKeys(
			cfg,
			cfg.nodes.map((n) => n.id),
		);

	if (typeof cfg.args.node === "string") {
		ensureKeys(cfg, [cfg.args.node]);
		const node = await startNode(cfg.args.node, cfg);
		const bye = async () => (await node.stop().catch(() => {}), process.exit(0));
		process.on("SIGINT", bye);
		process.on("SIGTERM", bye);
		return;
	}

	// launcher: all nodes as separate processes
	if (!cfg.discordToken) {
		console.error(
			`DISCORD_TOKEN is empty. Put it in ${cfg.envFile} (or run the provider nodes only: node test-cluster.js --node=yt-1).`,
		);
		process.exit(2);
	}
	ensureKeys(
		cfg,
		cfg.nodes.map((n) => n.id),
	);
	const order = [...cfg.nodes.filter((n) => n.id !== cfg.discordNode), ...cfg.nodes.filter((n) => n.id === cfg.discordNode)];
	const children = [];
	const passEnv = typeof cfg.args.env === "string" ? [`--env=${cfg.args.env}`] : [];
	for (const n of order) {
		const child = fork(__filename, [`--node=${n.id}`, ...passEnv], { silent: true });
		const pipe = (stream, out) => {
			let buf = "";
			stream.on("data", (d) => {
				buf += d;
				let i;
				while ((i = buf.indexOf("\n")) >= 0) (out.write(`${buf.slice(0, i)}\n`), (buf = buf.slice(i + 1)));
			});
		};
		pipe(child.stdout, process.stdout);
		pipe(child.stderr, process.stderr);
		child.on("exit", (code, sig) => console.log(`[launcher] ${n.id} exited (${sig || code})`));
		children.push(child);
		await sleep(n.id === cfg.discordNode ? 0 : 1200);
	}
	const stopAll = () => {
		for (const c of children) c.kill("SIGTERM");
		setTimeout(() => process.exit(0), 1500).unref();
	};
	process.on("SIGINT", stopAll);
	process.on("SIGTERM", stopAll);
	console.log(`[launcher] ${children.length} nodes started. Use the commands in Discord (${cfg.prefix}help). Ctrl+C to stop.`);
}

module.exports = { parseEnv, loadConfig, startNode, attachDiscordCommands };
if (require.main === module) main().catch((e) => (console.error(e.message), process.exit(1)));
