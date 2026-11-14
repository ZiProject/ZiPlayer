const test = require("node:test");
const assert = require("node:assert/strict");
const { net, makeCluster, tick } = require("./helpers/net");

function collect(node) {
	const events = [];
	node.on("debug", (e) => events.push(e));
	return events;
}

test("debug events show the wire (ciphertext) and the decoded message", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("echo", (body) => ({ got: body }));
	const events = collect(c.nodes.a);
	await tick(30);
	const reply = await c.nodes.a.request("b", "echo", { query: "super secret song", token: "abc123" });
	assert.deepEqual(reply.got.query, "super secret song");

	const msgOut = events.find((e) => e.layer === "message" && e.dir === "out" && e.type === "echo");
	assert.ok(msgOut, "outgoing message reported");
	assert.equal(msgOut.peer, "b");
	assert.equal(msgOut.kind, "control");
	assert.equal(msgOut.body.query, "super secret song");
	assert.equal(msgOut.body.token, "[redacted]", "tokens are hidden by default");
	assert.ok(events.some((e) => e.layer === "message" && e.dir === "in" && e.re !== undefined && e.type === "reply"));

	const wire = events.filter((e) => e.layer === "wire" && e.kind === "control" && e.dir === "out");
	assert.ok(wire.length >= 1);
	assert.equal(wire[0].encrypted, true);
	assert.match(wire[0].topic, /^zi\/v1\/test\/node\/b\/in$/);
	assert.equal(wire[0].qos, 1);
	assert.ok(wire[0].bytes > 0 && /^[0-9a-f]+…?$/.test(wire[0].hex));
	for (const e of events.filter((x) => x.layer === "wire")) {
		assert.ok(!Buffer.from(e.hex.replace("…", ""), "hex").toString("latin1").includes("secret"), "plaintext never reaches the wire");
	}
	const hs = events.filter((e) => e.layer === "wire" && e.kind === "handshake").map((e) => e.type);
	assert.ok(hs.includes("hs1") && hs.includes("hs3"), `handshake steps seen on the wire: ${hs}`);
});

test("presence messages are decoded without dumping the public key", async (t) => {
	const c = await makeCluster(["a", "b"], { start: false });
	t.after(c.stopAll);
	const events = collect(c.nodes.a);
	await c.nodes.a.start();
	const will = events.find((e) => e.layer === "wire" && e.kind === "presence" && /last-will/.test(e.type ?? ""));
	assert.ok(will, "the last-will registration is visible");
	assert.equal(will.body.online, false);
	const p = events.find((e) => e.layer === "wire" && e.kind === "presence" && e.dir === "out" && e.body?.online === true);
	assert.ok(p);
	assert.equal(p.body.online, true);
	assert.equal(p.body.pub, "<public key>");
});

test("debugRedact: false shows raw bodies; audio frames need debugAudio", async (t) => {
	const c = await makeCluster(["a", "b"], { nodeOptions: { debugRedact: false } });
	t.after(c.stopAll);
	c.nodes.b.handle("echo", (b) => b);
	const events = collect(c.nodes.a);
	await tick(30);
	await c.nodes.a.request("b", "echo", { token: "visible" });
	assert.equal(events.find((e) => e.type === "echo").body.token, "visible");

	c.nodes.b.onAudio(() => {});
	await c.nodes.a.sendAudio("b", { streamId: 1, seq: 1, flags: 0, payload: Buffer.alloc(10) });
	await tick(20);
	assert.ok(!events.some((e) => /audio/.test(e.kind ?? "")), "audio is not traced by default");

	const d = await makeCluster(["a", "b"], { nodeOptions: { debugAudio: true } });
	t.after(d.stopAll);
	d.nodes.b.onAudio(() => {});
	const ev = collect(d.nodes.a);
	await tick(30);
	await d.nodes.a.sendAudio("b", { streamId: 7, seq: 3, flags: 0, payload: Buffer.alloc(10) });
	const audio = ev.find((e) => e.layer === "message" && e.kind === "audio");
	assert.equal(audio.streamId, 7);
	assert.equal(audio.seq, 3);
	assert.equal(audio.bytes, 10);
	assert.ok(ev.some((e) => e.layer === "wire" && e.kind === "audio"));
});

test("no listener, no work; a throwing listener cannot break the node", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("echo", (b) => b);
	assert.equal(c.nodes.a.tracing, false);
	c.nodes.a.on("debug", () => {
		throw new Error("listener bug");
	});
	await tick(30);
	assert.deepEqual(await c.nodes.a.request("b", "echo", { ok: 1 }), { ok: 1 });
});

test("formatNetDebug renders every layer on one line", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	c.nodes.b.handle("echo", (b) => b);
	const events = collect(c.nodes.a);
	await tick(30);
	await c.nodes.a.request("b", "echo", { hello: "world" });
	c.nodes.a.traceNote("hello note");
	for (const e of events) {
		const line = net.formatNetDebug(e);
		assert.equal(typeof line, "string");
		assert.ok(!line.includes("\n"));
		assert.ok(line.startsWith("[net:a]"));
	}
	assert.ok(events.map(net.formatNetDebug).some((l) => l.includes("→ MQTT PUBLISH zi/v1/test/node/b/in qos1")));
	assert.ok(events.map(net.formatNetDebug).some((l) => l.includes('echo #') && l.includes('{"hello":"world"}')));
});

test("search routing leaves info notes", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const events = collect(c.nodes.a);
	c.nodes.a.traceNote('search "x" → b', { peer: "b" });
	const e = events.find((x) => x.layer === "info");
	assert.equal(e.peer, "b");
	assert.equal(e.dir, "info");
});
