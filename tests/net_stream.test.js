const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const crypto = require("node:crypto");
const { net, makeCluster, tick } = require("./helpers/net");

function setup(cluster, info) {
	const sources = [];
	const provider = new net.StreamProvider(cluster.nodes.b, {
		resolveStream: async (track) => {
			const stream = info.make(track);
			sources.push(stream);
			return { stream, streamType: info.streamType ?? "webm/opus", recreate: info.recreate };
		},
		chunkBytes: 4096,
	});
	const importer = new net.StreamImporter(cluster.nodes.a, { bufferBytes: 64 * 1024 });
	cluster.nodes.a.onAudio((peer, frame) => importer.onFrame(peer, frame));
	return { provider, importer, sources };
}

async function collect(stream) {
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	return Buffer.concat(chunks);
}

test("a large stream arrives intact and in order", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const data = crypto.randomBytes(1024 * 1024);
	const { importer } = setup(c, { make: () => Readable.from([data]) });
	const remote = await importer.open("b", { id: "t1", title: "x" });
	assert.equal(remote.streamType, "webm/opus");
	const out = await collect(remote.stream);
	assert.equal(out.length, data.length);
	assert.ok(out.equals(data));
});

test("a slow consumer is paced by credit (provider does not run away)", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	let produced = 0;
	const total = 2 * 1024 * 1024;
	const make = () =>
		new Readable({
			read() {
				if (produced >= total) return this.push(null);
				produced += 16384;
				this.push(Buffer.alloc(16384, 7));
			},
		});
	const { importer } = setup(c, { make });
	const remote = await importer.open("b", { id: "t2" });
	await tick(300); // consumer idle
	assert.ok(produced < total / 2, `provider produced ${produced} bytes with no consumer`);
	let got = 0;
	for await (const chunk of remote.stream) got += chunk.length;
	assert.equal(got, total);
});

test("out-of-order frames are reordered and duplicates dropped", async (t) => {
	const c = await makeCluster(["a", "b"], { start: false });
	const importer = new net.StreamImporter(c.nodes.a, { bufferBytes: 1024 });
	// open manually: fake the request so we can feed frames directly
	c.nodes.a.request = async () => ({ streamType: "ogg/opus", seekable: false, positionApplied: false });
	c.nodes.a.notify = async () => {};
	const remote = await importer.open("b", { id: "t3" });
	const frame = (seq, text, flags = 0) => ({ streamId: 1, seq, flags, payload: Buffer.from(text) });
	importer.onFrame("b", frame(1, "B"));
	importer.onFrame("b", frame(0, "A"));
	importer.onFrame("b", frame(0, "A")); // duplicate
	importer.onFrame("b", frame(2, "C", 1));
	assert.equal((await collect(remote.stream)).toString(), "ABC");
});

test("seek uses recreate on the owner", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const seen = [];
	const { importer } = setup(c, {
		make: () => Readable.from([Buffer.from("from-start")]),
		recreate: async (pos) => {
			seen.push(pos);
			return Readable.from([Buffer.from(`from-${pos}`)]);
		},
	});
	const remote = await importer.open("b", { id: "t4" });
	assert.equal((await collect(remote.stream)).toString(), "from-start");
	const again = await remote.recreate(30000);
	assert.equal((await collect(again)).toString(), "from-30000");
	assert.deepEqual(seen, [30000]);
});

test("raw PCM is never transferred; compressed containers are", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const pcm = setup(c, { make: () => Readable.from([Buffer.alloc(10)]), streamType: "raw" });
	await assert.rejects(() => pcm.importer.open("b", { id: "t5" }), /not transferable/);
	assert.equal(pcm.sources[0].destroyed, true, "refused source must be released");

	const c2 = await makeCluster(["a", "b"]);
	t.after(c2.stopAll);
	const arb = setup(c2, { make: () => Readable.from([Buffer.from("compressed")]), streamType: "arbitrary" });
	const remote = await arb.importer.open("b", { id: "t5b" });
	assert.equal((await collect(remote.stream)).toString(), "compressed");
});

test("allowedStreamTypes can restrict a provider to Opus containers", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	new net.StreamProvider(c.nodes.b, {
		resolveStream: async () => ({ stream: Readable.from([Buffer.alloc(4)]), streamType: "arbitrary" }),
		allowedStreamTypes: ["webm/opus", "ogg/opus", "opus"],
	});
	const importer = new net.StreamImporter(c.nodes.a);
	await assert.rejects(() => importer.open("b", { id: "t5c" }), /not transferable/);
});

test("closing the consumer stops the provider and releases the source", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const { importer, sources } = setup(c, {
		make: () =>
			new Readable({
				read() {
					this.push(Buffer.alloc(8192));
				},
			}),
	});
	const remote = await importer.open("b", { id: "t7" });
	await tick(50);
	remote.stream.destroy();
	await tick(100);
	assert.equal(sources[0].destroyed, true);
});

test("the provider refuses tracks and peers it should not serve", async (t) => {
	const c = await makeCluster(["a", "b"], { roles: { a: ["accept-voice"] } });
	t.after(c.stopAll);
	const { importer } = setup(c, { make: () => Readable.from([Buffer.alloc(10)]) });
	await assert.rejects(() => importer.open("b", { id: "t8" }), /lacks role/);

	const c2 = await makeCluster(["a", "b"]);
	t.after(c2.stopAll);
	new net.StreamProvider(c2.nodes.b, { resolveStream: async () => null, allow: (track) => track.source === "ok" });
	const imp2 = new net.StreamImporter(c2.nodes.a);
	await assert.rejects(() => imp2.open("b", { id: "x", source: "nope" }), /refused/);
});

test("losing the session fails the stream instead of hanging", async (t) => {
	const c = await makeCluster(["a", "b"]);
	t.after(c.stopAll);
	const { importer } = setup(c, { make: () => new Readable({ read() {} }) });
	const remote = await importer.open("b", { id: "t9" });
	const failed = new Promise((resolve) => remote.stream.once("error", resolve));
	remote.stream.resume();
	await c.transports.b.kill();
	assert.match((await failed).message, /closed|offline/i);
});
