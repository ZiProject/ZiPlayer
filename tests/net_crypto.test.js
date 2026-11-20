const test = require("node:test");
const assert = require("node:assert/strict");
const { net, makeCluster, tick } = require("./helpers/net");

test("handshake establishes a session and carries request/response", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("echo", (body, ctx) => ({ body, from: ctx.from }));
	const reply = await c.nodes.a.request("b", "echo", { n: 1 });
	assert.deepEqual(reply, { body: { n: 1 }, from: "a" });
	assert.ok(c.nodes.a.hasSession("b"));
	assert.ok(c.nodes.b.hasSession("a"));
});

test("control payloads never appear in clear on the broker", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("secret", () => "reply-SECRET-token");
	await c.nodes.a.request("b", "secret", { token: "voice-SECRET-token" });
	for (const { topic, payload } of c.broker.log) {
		if (topic.includes("presence")) continue;
		const text = Buffer.from(payload).toString("latin1");
		assert.ok(!text.includes("SECRET"), `plaintext leaked on ${topic}`);
	}
});

test("untrusted initiator is rejected", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const rogue = net.generateIdentity();
	const broker = c.broker;
	const evil = new net.NetNode({
		nodeId: "a", // impersonates a
		networkId: "test",
		identity: rogue.privateKeyPem,
		trust: [{ nodeId: "b", publicKey: c.identities.b.publicKeyPem }],
		transport: broker.transport(),
		handshakeTimeoutMs: 300,
	});
	await evil.start();
	t.after(() => evil.stop());
	await assert.rejects(() => evil.request("b", "echo", {}, { timeoutMs: 300 }), /timed out|HANDSHAKE/);
	assert.equal(c.nodes.b.hasSession("a"), false);
});

test("a peer with an unexpected key is refused (key pinning)", async (t) => {
	const c = await makeCluster(["a", "b"], { start: false });
	const other = net.generateIdentity();
	// a pins the WRONG key for b
	c.nodes.a.trust.add({ nodeId: "b", publicKey: other.publicKeyPem });
	await c.nodes.a.start();
	await c.nodes.b.start();
	t.after(c.stopAll);
	await assert.rejects(() => c.nodes.a.request("b", "echo", {}), /signature|authentication|timed out/i);
});

test("tampered control frames are dropped", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	let calls = 0;
	c.nodes.b.handle("count", () => ++calls);
	await c.nodes.a.request("b", "count");
	assert.equal(calls, 1);
	c.broker.intercept = (topic, payload) => {
		if (!topic.endsWith("/in") || payload[0] !== 2) return payload;
		const copy = Buffer.from(payload);
		copy[copy.length - 1] ^= 0xff;
		return copy;
	};
	await assert.rejects(() => c.nodes.a.request("b", "count", undefined, { timeoutMs: 200 }), /timed out/);
	assert.equal(calls, 1);
});

test("replayed control frames are executed once", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	let calls = 0;
	c.nodes.b.handle("count", () => ++calls);
	await c.nodes.a.request("b", "count");
	const captured = [];
	c.broker.intercept = (topic, payload) => {
		if (topic.endsWith("/node/b/in") && payload[0] === 2) captured.push(Buffer.from(payload));
		return payload;
	};
	await c.nodes.a.notify("b", "count");
	await tick();
	assert.equal(calls, 2);
	c.broker.intercept = undefined;
	for (const frame of captured) c.broker.deliver("zi/v1/test/node/b/in", frame);
	await tick();
	assert.equal(calls, 2, "replay must not re-run the handler");
});

test("roles restrict what a peer may ask for", async (t) => {
	const c = await makeCluster(["a", "b"], { roles: { a: ["accept-voice"] } });
	t.after(c.stopAll);
	c.nodes.b.handle("stream.test", () => "ok", { role: "provide-stream" });
	c.nodes.b.handle("voice.test", () => "ok", { role: "accept-voice" });
	await assert.rejects(() => c.nodes.a.request("b", "stream.test"), /lacks role/);
	assert.equal(await c.nodes.a.request("b", "voice.test"), "ok");
});

test("audio is clear by default and encrypted on request; no downgrade", async (t) => {
	const clear = await makeCluster(["a", "b"]);
	t.after(clear.stopAll);
	const got = [];
	clear.nodes.b.onAudio((peer, frame) => got.push([peer, frame]));
	const payload = Buffer.from("OPUS-PAYLOAD-MARKER");
	await clear.nodes.a.sendAudio("b", { streamId: 7, seq: 0, flags: 0, payload });
	await tick();
	assert.equal(got.length, 1);
	assert.deepEqual(got[0][1].payload, payload);
	assert.ok(clear.broker.log.some((m) => Buffer.from(m.payload).includes("OPUS-PAYLOAD-MARKER")));

	const enc = await makeCluster(["a", "b"], { nodeOptions: { encryptAudio: true } });
	t.after(enc.stopAll);
	const got2 = [];
	enc.nodes.b.onAudio((peer, frame) => got2.push(frame));
	await enc.nodes.a.sendAudio("b", { streamId: 7, seq: 0, flags: 0, payload });
	await tick();
	assert.deepEqual(got2[0].payload, payload);
	assert.ok(!enc.broker.log.some((m) => Buffer.from(m.payload).includes("OPUS-PAYLOAD-MARKER")));
});

test("presence: a crashed peer closes its sessions and fails pending requests", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("hang", () => new Promise(() => {}));
	await tick();
	assert.ok(c.nodes.a.isOnline("b"));
	const pending = c.nodes.a.request("b", "hang", undefined, { timeoutMs: 5000 });
	await tick(50);
	const offline = new Promise((r) => c.nodes.a.once("peerOffline", r));
	await c.transports.b.kill();
	assert.equal(await offline, "b");
	await assert.rejects(pending, /closed|offline/i);
	assert.equal(c.nodes.a.hasSession("b"), false);
});

test("sessions past their maximum age are renegotiated", async (t) => {
	const c = await makeCluster(["a", "b"], { nodeOptions: { sessionMaxAgeMs: 30 } });
	t.after(c.stopAll);
	c.nodes.b.handle("ping", () => "pong");
	await c.nodes.a.request("b", "ping");
	const first = (await c.nodes.a.ensureSession("b")).sessionId;
	await tick(60);
	await c.nodes.a.request("b", "ping");
	const second = (await c.nodes.a.ensureSession("b")).sessionId;
	assert.notEqual(first, second);
});

test("replay window accepts reordering but not duplicates", () => {
	const w = new net.ReplayWindow(8);
	assert.ok(w.accept(5));
	assert.ok(w.accept(3));
	assert.ok(!w.accept(5));
	assert.ok(w.accept(20));
	assert.ok(!w.accept(3), "outside the window");
});

test("unknown nodes are discovered, accepted by fingerprint, and then can talk", async (t) => {
	const broker = new net.MemoryBroker();
	const a = new net.NetNode({
		nodeId: "a",
		networkId: "t",
		identity: net.generateIdentity().privateKeyPem,
		transport: broker.transport(),
		handshakeTimeoutMs: 300,
	});
	const b = new net.NetNode({
		nodeId: "b",
		networkId: "t",
		identity: net.generateIdentity().privateKeyPem,
		transport: broker.transport(),
		handshakeTimeoutMs: 300,
	});
	await a.start();
	const seen = new Promise((r) => a.once("peerDiscovered", r));
	await b.start();
	t.after(() => Promise.all([a.stop(), b.stop()]));
	const found = await seen;
	assert.equal(found.nodeId, "b");
	assert.equal(found.fingerprint, b.fingerprint);
	assert.throws(() => a.acceptPeer("b", "00".repeat(32)), /Fingerprint mismatch/);
	a.acceptPeer("b", b.fingerprint);
	b.acceptPeer("a", a.fingerprint);
	b.handle("hi", () => "hello");
	assert.equal(await a.request("b", "hi"), "hello");
});

test("keyFile: creates an identity when missing and reuses it afterwards", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zinet-"));
	try {
		const file = path.join(dir, "node.key");
		const first = net.loadOrCreateIdentity(file);
		assert.equal(first.created, true);
		if (process.platform !== "win32")
			assert.equal(fs.statSync(file).mode & 0o077, 0, "private key must not be group/world readable");
		const second = net.loadOrCreateIdentity(file);
		assert.equal(second.created, false);
		assert.equal(second.publicKeyPem, first.publicKeyPem);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
