const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { net, makeCluster, tick } = require("./helpers/net");

// ── router ────────────────────────────────────────────────────────────────
test("planRoute: everything resolvable here stays local", () => {
	const plan = net.planRoute({
		selfId: "a",
		selfSources: ["soundcloud"],
		peers: [{ id: "b", sources: ["youtube"] }],
		tracks: [{ source: "soundcloud" }, {}],
	});
	assert.equal(plan.mode, "local");
});

test("planRoute: a few foreign tracks are relayed, voice stays", () => {
	const tracks = [...Array(9).fill({ source: "soundcloud" }), { source: "youtube" }];
	const plan = net.planRoute({ selfId: "a", selfSources: ["soundcloud"], peers: [{ id: "b", sources: ["youtube"] }], tracks });
	assert.equal(plan.mode, "relay");
	assert.equal(plan.owners[9], "b");
	assert.equal(plan.owners[0], "a");
});

test("planRoute: mostly foreign tracks hand the voice off to the node that can play them", () => {
	const tracks = [...Array(50).fill({ source: "youtube" }), { source: "soundcloud" }];
	const plan = net.planRoute({
		selfId: "a",
		selfSources: ["soundcloud"],
		peers: [
			{ id: "b", sources: ["youtube"] },
			{ id: "c", sources: ["spotify"] },
		],
		tracks,
	});
	assert.equal(plan.mode, "handoff");
	assert.equal(plan.executor, "b");
	assert.equal(plan.owners[0], "b");
	assert.equal(plan.owners[50], "a", "tracks the executor cannot play are pulled from this node");
});

test("planRoute: ties go to the least loaded peer; unresolvable tracks are reported", () => {
	const plan = net.planRoute({
		selfId: "a",
		selfSources: [],
		peers: [
			{ id: "b", sources: ["youtube"], load: 5 },
			{ id: "c", sources: ["youtube"], load: 1 },
		],
		tracks: [{ source: "youtube" }, { source: "tidal" }],
		handoffThreshold: 2,
	});
	assert.equal(plan.mode, "relay");
	assert.equal(plan.owners[0], "c");
	assert.deepEqual(plan.unresolvable, [1]);
});

// ── voice hand-off with fakes ───────────────────────────────────────────────
class FakePlayer extends EventEmitter {
	constructor(guildId, log) {
		super();
		this.guildId = guildId;
		this.log = log;
		this.isPlaying = false;
		this.volume = 100;
		this.destroyed = false;
		this.connection = null;
		this.currentTrack = null;
	}
	async connect(channel) {
		this.log.push(`connect:${channel.id}`);
		if (channel.guild?.voiceAdapterCreator) {
			// what @discordjs/voice does: create the adapter, then ask Discord to join
			this.methods = {
				onVoiceStateUpdate: (d) => this.log.push(`state:${d.channel_id}`),
				onVoiceServerUpdate: (d) => this.log.push(`server:${d.endpoint}`),
				destroy() {},
			};
			this.adapter = channel.guild.voiceAdapterCreator(this.methods);
			this.adapter.sendPayload({
				op: 4,
				d: { guild_id: this.guildId, channel_id: channel.id, self_mute: false, self_deaf: true },
			});
		}
		this.connection = { joinConfig: { guildId: this.guildId, channelId: channel.id, selfDeaf: true, selfMute: false } };
		return this.connection;
	}
	async disconnect(opts) {
		this.log.push(`disconnect:${opts?.silent ? "silent" : "leave"}`);
		this.connection = null;
	}
	async play(track) {
		this.log.push(`play:${track.id}`);
		this.currentTrack = track;
		return true;
	}
	async pause() {
		this.log.push("pause");
	}
	async resume() {
		this.log.push("resume");
	}
	async stop() {
		this.log.push("stop");
	}
	async seek(p) {
		this.log.push(`seek:${p}`);
	}
	setVolume(v) {
		this.log.push(`volume:${v}`);
	}
	async playNext() {
		this.log.push("playNext");
	}
	exitRemoteMode() {
		this.log.push("exitRemote");
	}
}

function fakeManager(log) {
	const players = new Map();
	return {
		players,
		get: (id) => players.get(id),
		getStats: () => ({ players: players.size }),
		async create(id) {
			if (!players.has(id)) players.set(id, new FakePlayer(id, log));
			return players.get(id);
		},
		async destroy(id) {
			players.delete(id);
		},
	};
}

async function voiceSetup(t, { roles } = {}) {
	const cluster = await makeCluster(["owner", "exec"], { roles, start: false }); // only used for keys + broker
	t.after(cluster.stopAll);
	const ownerLog = [];
	const execLog = [];
	const sent = [];
	const listeners = new Set();
	const gateway = {
		userId: "bot",
		onVoiceUpdate: (l) => (listeners.add(l), () => listeners.delete(l)),
		send: (guildId, payload) => sent.push({ guildId, payload }),
		resolveChannel: (_g, id) => ({ id, type: 2, guild: {} }),
	};
	const ownerMgr = fakeManager(ownerLog);
	const execMgr = fakeManager(execLog);
	const ownerNet = new net.ZiNet({
		nodeId: "owner",
		networkId: "test",
		identity: cluster.identities.owner.privateKeyPem,
		trust: [{ nodeId: "exec", publicKey: cluster.identities.exec.publicKeyPem, roles: roles?.exec }],
		transport: cluster.broker.transport(),
		manager: ownerMgr,
		gateway,
		handshakeTimeoutMs: 500,
		requestTimeoutMs: 1000,
	});
	const execNet = new net.ZiNet({
		nodeId: "exec",
		networkId: "test",
		identity: cluster.identities.exec.privateKeyPem,
		trust: [{ nodeId: "owner", publicKey: cluster.identities.owner.publicKeyPem, roles: roles?.owner }],
		transport: cluster.broker.transport(),
		manager: execMgr,
		handshakeTimeoutMs: 500,
		requestTimeoutMs: 1000,
	});
	await ownerNet.start();
	await execNet.start();
	t.after(() => Promise.all([ownerNet.stop(), execNet.stop()]));
	execNet.acceptVoice();
	const execTransport = execNet.node.transport;
	const player = await ownerMgr.create("g1");
	player.connection = { joinConfig: { guildId: "g1", channelId: "c1", selfDeaf: true, selfMute: false } };
	return { execTransport, cluster, ownerNet, execNet, ownerMgr, execMgr, ownerLog, execLog, sent, listeners, player, gateway };
}

test("delegateVoice: owner releases silently first, executor joins through the relay", async (t) => {
	const s = await voiceSetup(t);
	await s.ownerNet.delegateVoice(s.player, "exec");
	assert.equal(s.ownerLog[0], "disconnect:silent", "owner must not leave the channel");
	assert.ok(s.execLog.includes("connect:c1"));
	await tick();
	// executor's join request (op 4) reached the gateway on the owner
	assert.deepEqual(s.sent, [
		{ guildId: "g1", payload: { op: 4, d: { guild_id: "g1", channel_id: "c1", self_mute: false, self_deaf: true } } },
	]);
	// Discord's answers are relayed to the executor's adapter
	for (const l of s.listeners) l("g1", "state", { channel_id: "c1" });
	for (const l of s.listeners) l("g1", "server", { endpoint: "voice.example:443", token: "T", guild_id: "g1" });
	await tick();
	assert.ok(s.execLog.includes("state:c1"));
	assert.ok(s.execLog.includes("server:voice.example:443"));
});

test("relayed payloads are restricted to op 4 for the delegated guild", async (t) => {
	const s = await voiceSetup(t);
	await s.ownerNet.delegateVoice(s.player, "exec");
	await tick();
	s.sent.length = 0;
	await assert.rejects(
		() => s.execNet.node.request("owner", "voice.payload", { guildId: "g1", payload: { op: 2, d: { token: "steal" } } }),
		/not allowed/,
	);
	await assert.rejects(
		() =>
			s.execNet.node.request("owner", "voice.payload", {
				guildId: "g1",
				payload: { op: 4, d: { guild_id: "other", channel_id: "x" } },
			}),
		/not allowed/,
	);
	await assert.rejects(
		() =>
			s.execNet.node.request("owner", "voice.payload", { guildId: "unknown", payload: { op: 4, d: { guild_id: "unknown" } } }),
		/No delegation/,
	);
	assert.deepEqual(s.sent, []);
});

test("owner's remote handle drives the executor; executor events drive the owner's queue", async (t) => {
	const s = await voiceSetup(t);
	await s.ownerNet.delegateVoice(s.player, "exec");
	const remote = s.ownerNet.buildRemoteStream(s.player, {
		id: "song",
		title: "Song",
		url: "https://x/y",
		requestedBy: { id: 1, self: null },
	});
	assert.equal(remote.remote, true);
	await remote.handle.play();
	await remote.handle.pause();
	await remote.handle.resume();
	await remote.handle.seek(1500);
	await remote.handle.setVolume(40);
	await remote.handle.stop();
	assert.deepEqual(
		s.execLog.filter((l) => !l.startsWith("connect") && !l.startsWith("state") && !l.startsWith("server") && l !== "volume:100"),
		["play:song", "pause", "resume", "seek:1500", "volume:40", "stop"],
	);

	const ended = [];
	s.player.on("trackEnd", (tr) => ended.push(tr));
	s.player.currentTrack = { id: "song" };
	s.execMgr.get("g1").emit("trackEnd");
	await tick();
	assert.equal(ended.length, 1);
	assert.ok(s.ownerLog.includes("playNext"));
});

test("a failed hand-off puts the voice back on the owner", async (t) => {
	const s = await voiceSetup(t, { roles: { exec: ["accept-voice"] } }); // owner may not delegate to exec
	s.execNet.node.trust.add({ nodeId: "owner", publicKey: s.cluster.identities.owner.publicKeyPem, roles: ["provide-stream"] });
	await assert.rejects(() => s.ownerNet.delegateVoice(s.player, "exec"), /lacks role/);
	assert.deepEqual(s.ownerLog.slice(0, 2), ["disconnect:silent", "connect:c1"]);
	assert.equal(s.ownerNet.delegationFor("g1"), undefined);
	assert.equal(s.listeners.size, 0, "relay stopped");
});

test("reclaimVoice: executor lets go silently and the owner reconnects", async (t) => {
	const s = await voiceSetup(t);
	await s.ownerNet.delegateVoice(s.player, "exec");
	s.ownerLog.length = 0;
	await s.ownerNet.reclaimVoice(s.player);
	assert.ok(s.execLog.includes("disconnect:silent"));
	assert.deepEqual(s.ownerLog, ["exitRemote", "connect:c1"], "leave REMOTE mode, then reconnect locally");
	assert.equal(s.listeners.size, 0);
});

test("when the executor crashes the owner takes the voice back", async (t) => {
	const s = await voiceSetup(t);
	await s.ownerNet.delegateVoice(s.player, "exec");
	s.ownerLog.length = 0;
	await s.execTransport.kill();
	await tick(100);
	assert.deepEqual(s.ownerLog, ["exitRemote", "connect:c1"]);
	assert.equal(s.ownerNet.delegationFor("g1"), undefined);
});

test("delegation is refused while playing, or when not connected", async (t) => {
	const s = await voiceSetup(t);
	s.player.isPlaying = true;
	await assert.rejects(() => s.ownerNet.delegateVoice(s.player, "exec"), /Stop playback/);
	s.player.isPlaying = false;
	s.player.connection = null;
	await assert.rejects(() => s.ownerNet.delegateVoice(s.player, "exec"), /not connected/);
});

test("an executor can refuse delegations", async (t) => {
	const s = await voiceSetup(t);
	s.execNet.allowVoice = () => false;
	s.execNet.voiceAccepting = false;
	s.execNet.acceptVoice({ allow: () => false });
	await assert.rejects(() => s.ownerNet.delegateVoice(s.player, "exec"), /refused/);
	assert.equal(s.ownerLog[s.ownerLog.length - 1], "connect:c1", "owner recovered");
});

test("routeTracks marks foreign tracks with their owner node (relay)", async (t) => {
	const s = await voiceSetup(t);
	s.ownerNet.options.sources = ["soundcloud"];
	s.execNet.options.sources = ["youtube"];
	await tick();
	const tracks = [
		...Array(9)
			.fill(0)
			.map((_, i) => ({ id: `s${i}`, source: "soundcloud" })),
		{ id: "y", source: "youtube" },
	];
	const plan = await s.ownerNet.routeTracks(s.player, tracks);
	assert.equal(plan.mode, "relay");
	assert.equal(tracks[9].metadata.net.owner, "exec");
	assert.equal(tracks[0].metadata, undefined);
});

test("routeTracks hands the voice off when most tracks are foreign", async (t) => {
	const s = await voiceSetup(t);
	s.ownerNet.options.sources = ["soundcloud"];
	s.execNet.options.sources = ["youtube"];
	await tick();
	const tracks = [
		...Array(20)
			.fill(0)
			.map((_, i) => ({ id: `y${i}`, source: "youtube" })),
		{ id: "sc", source: "soundcloud" },
	];
	const plan = await s.ownerNet.routeTracks(s.player, tracks);
	assert.equal(plan.mode, "handoff");
	assert.equal(plan.applied, true, plan.error?.message);
	assert.ok(s.ownerNet.delegationFor("g1"));
	assert.equal(tracks[0].metadata, undefined, "executor resolves its own tracks");
	assert.equal(tracks[20].metadata.net.owner, "owner", "executor pulls the SoundCloud track from the owner");
});
