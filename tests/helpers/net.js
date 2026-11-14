const net = require("../../net/dist");

/** Build N trusted nodes sharing one in-memory broker. `roles` maps nodeId -> roles other nodes grant it. */
async function makeCluster(ids, { roles = {}, nodeOptions = {}, start = true } = {}) {
	const broker = new net.MemoryBroker();
	const identities = Object.fromEntries(ids.map((id) => [id, net.generateIdentity()]));
	const nodes = {};
	const transports = {};
	for (const id of ids) {
		const trust = ids
			.filter((other) => other !== id)
			.map((other) => ({ nodeId: other, publicKey: identities[other].publicKeyPem, roles: roles[other] }));
		transports[id] = broker.transport();
		nodes[id] = new net.NetNode({
			nodeId: id,
			networkId: "test",
			identity: identities[id].privateKeyPem,
			trust,
			transport: transports[id],
			handshakeTimeoutMs: 500,
			requestTimeoutMs: 1000,
			...nodeOptions,
		});
	}
	if (start) for (const id of ids) await nodes[id].start();
	return { broker, identities, nodes, transports, stopAll: () => Promise.all(Object.values(nodes).map((n) => n.stop().catch(() => {}))) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = { net, makeCluster, tick };
