const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const crypto = require("node:crypto");
const netDir = require("node:path").join(__dirname, "..", "net");
const { net } = require("./helpers/net");

let Aedes,
	createServer,
	hasMqtt = true;
try {
	Aedes = require(require.resolve("aedes", { paths: [netDir] }));
	createServer = require("node:net").createServer;
	require.resolve("mqtt", { paths: [netDir] });
} catch {
	hasMqtt = false;
}

// mqtt is resolved from net/node_modules by MqttTransport (require("mqtt") inside net/dist).
async function broker() {
	const aedes = typeof Aedes.createBroker === "function" ? await Aedes.createBroker() : new Aedes();
	const server = createServer(aedes.handle);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `mqtt://127.0.0.1:${server.address().port}`;
	const published = [];
	aedes.on("publish", (packet) => published.push({ topic: packet.topic, payload: Buffer.from(packet.payload) }));
	return { url, published, close: () => new Promise((r) => aedes.close(() => server.close(() => r()))) };
}

test(
	"real MQTT broker: handshake, encrypted control, Opus stream, presence/LWT",
	{ skip: !hasMqtt && "mqtt/aedes not installed (npm install --prefix net)" },
	async (t) => {
		const b = await broker();
		const ids = { a: net.generateIdentity(), b: net.generateIdentity() };
		const make = (id, other) =>
			new net.NetNode({
				nodeId: id,
				networkId: "mq",
				identity: ids[id].privateKeyPem,
				trust: [{ nodeId: other, publicKey: ids[other].publicKeyPem }],
				transport: new net.MqttTransport({ url: b.url, clientId: `zi-${id}`, protocolVersion: 4 }),
				handshakeTimeoutMs: 3000,
				requestTimeoutMs: 3000,
			});
		const a = make("a", "b");
		const bn = make("b", "a");
		await a.start();
		await bn.start();
		// node:test runs t.after hooks in registration order, so tear down in one hook: nodes first, then the broker.
		t.after(async () => {
			await Promise.all([a.stop(), bn.stop()]);
			await b.close();
		});

		await new Promise((r) => setTimeout(r, 200));
		assert.ok(a.isOnline("b"), "presence arrived over retained MQTT message");

		bn.handle("echo", (body) => ({ got: body }));
		assert.deepEqual(await a.request("b", "echo", { token: "VOICE-SECRET" }), { got: { token: "VOICE-SECRET" } });
		assert.ok(
			!b.published.some((m) => !m.topic.includes("presence") && m.payload.includes("VOICE-SECRET")),
			"broker never saw the secret",
		);

		const data = crypto.randomBytes(300 * 1024);
		new net.StreamProvider(bn, { resolveStream: async () => ({ stream: Readable.from([data]), streamType: "ogg/opus" }) });
		const importer = new net.StreamImporter(a, { bufferBytes: 64 * 1024 });
		a.onAudio((peer, frame) => importer.onFrame(peer, frame));
		const remote = await importer.open("b", { id: "mq1" });
		const chunks = [];
		for await (const c of remote.stream) chunks.push(c);
		assert.ok(Buffer.concat(chunks).equals(data));
	},
);
