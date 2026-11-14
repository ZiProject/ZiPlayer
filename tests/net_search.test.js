const test = require("node:test");
const assert = require("node:assert/strict");
const { net, tick } = require("./helpers/net");

/** Fake PlayerManager: plugins = [{ name, canHandle(q), tracks(q) }]. */
function fakeManager(plugins) {
	const calls = [];
	const run = (q, only) => {
		const hits = plugins.filter((p) => (only ? only.includes(p.name) : p.canHandle(q)));
		return hits.flatMap((p) => p.tracks(q).map((t) => ({ ...t, source: p.name })));
	};
	return {
		calls,
		getStats: () => ({ players: 0 }),
		resolveStream: async () => null,
		controllers: {
			plugin: {
				getPlugins: () => plugins.map((p) => ({ name: p.name })),
				getSharedManager: () => ({
					async search(q, o) {
						calls.push({ via: "plugin", q, plugins: o.plugins });
						const tracks = run(q, o.plugins);
						return tracks.length ? { tracks } : null;
					},
				}),
			},
		},
		async search(q, by) {
			calls.push({ via: "manager", q, by });
			const tracks = run(q);
			if (!tracks.length) throw new Error(`No results found for: ${q}`);
			return { tracks };
		},
	};
}

const yt = (n = 3) => ({
	name: "youtube",
	canHandle: (q) => /youtube\.com|youtu\.be/.test(q) || !/^(sc|tts):/.test(q),
	tracks: (q) => Array.from({ length: n }, (_, i) => ({ id: `yt${i}`, title: `yt ${q} ${i}`, url: `https://youtube.com/watch?v=${i}`, duration: 10 })),
});
const sc = (n = 2) => ({
	name: "soundcloud",
	canHandle: (q) => !/youtube\.com|youtu\.be|^(yt|tts):/.test(q),
	tracks: (q) => Array.from({ length: n }, (_, i) => ({ id: `sc${i}`, title: `sc ${q} ${i}`, url: `https://soundcloud.com/${i}`, duration: 10 })),
});

/** specs: { id: { plugins, serve, roles } }; roles = roles OTHER nodes grant this node. */
async function cluster(specs, { zi = {} } = {}) {
	const broker = new net.MemoryBroker();
	const ids = Object.keys(specs);
	const identities = Object.fromEntries(ids.map((id) => [id, net.generateIdentity()]));
	const out = {};
	for (const id of ids) {
		const manager = fakeManager(specs[id].plugins);
		const node = new net.ZiNet({
			nodeId: id,
			networkId: "t",
			identity: identities[id].privateKeyPem,
			trust: ids.filter((o) => o !== id).map((o) => ({ nodeId: o, publicKey: identities[o].publicKeyPem, roles: specs[o].roles })),
			transport: broker.transport(),
			manager,
			handshakeTimeoutMs: 500,
			requestTimeoutMs: 1000,
			...zi,
		});
		out[id] = { zi: node, manager };
	}
	for (const id of ids) {
		await out[id].zi.start();
		if (specs[id].serve !== false) out[id].zi.provideSearch(specs[id].serve === true ? {} : specs[id].serve);
	}
	await tick(60);
	out.stopAll = () => Promise.all(ids.map((id) => out[id].zi.stop().catch(() => {})));
	return out;
}

test("yt: prefix searches the node that has the plugin and marks its tracks", async (t) => {
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [yt()], serve: true } });
	t.after(c.stopAll);
	const r = await c.bot.zi.search("yt:lofi", { requestedBy: "user-1", limit: 2 });
	assert.equal(r.node, "yt");
	assert.equal(r.tracks.length, 2);
	assert.equal(r.tracks[0].metadata.net.owner, "yt");
	assert.equal(r.tracks[0].requestedBy, "user-1");
	assert.deepEqual(c.yt.manager.calls[0], { via: "plugin", q: "lofi", plugins: ["youtube"] }, "prefix stripped, plugin filter used");
	assert.equal(c.bot.manager.calls.length, 0, "the bot did not search locally for a youtube query");
});

test("a URL the local plugins cannot handle falls back to the nodes that can", async (t) => {
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [yt()], serve: true } });
	t.after(c.stopAll);
	const url = "https://www.youtube.com/watch?v=PqpCRSOUuIE&list=RDPqpCRSOUuIE&start_radio=1";
	const r = await c.bot.zi.search(url);
	assert.equal(r.node, "yt");
	assert.equal(r.tracks[0].metadata.net.owner, "yt");
	assert.equal(c.bot.manager.calls[0].via, "manager", "tried locally first");
});

test("local results win when this node can handle the query (no network round trip)", async (t) => {
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [yt()], serve: true } });
	t.after(c.stopAll);
	const r = await c.bot.zi.search("sc:ambient");
	assert.equal(r.node, "bot");
	assert.equal(r.tracks[0].metadata, undefined);
	assert.equal(c.yt.manager.calls.length, 0);
});

test("the owner of a remote track is the node that answered, whatever the peer wrote", async (t) => {
	const evil = { name: "youtube", canHandle: () => true, tracks: () => [{ id: "x", title: "x", url: "https://e/x", metadata: { net: { owner: "someone-else" }, keep: 1 } }] };
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [evil], serve: true } });
	t.after(c.stopAll);
	const r = await c.bot.zi.search("yt:anything");
	assert.equal(r.tracks[0].metadata.net.owner, "yt");
	assert.equal(r.tracks[0].metadata.keep, 1);
});

test("nobody finds anything → NO_RESULTS with the core error text", async (t) => {
	const c = await cluster({ bot: { plugins: [sc(0)], serve: false }, yt: { plugins: [yt(0)], serve: true } });
	t.after(c.stopAll);
	await assert.rejects(
		() => c.bot.zi.search("https://nothing.example/x"),
		(e) => e.code === "NO_RESULTS" && /^No results found for: https:\/\/nothing\.example\/x/.test(e.message),
	);
});

test("nodes that do not serve search are skipped; searchOn explains why", async (t) => {
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [yt()], serve: false } });
	t.after(c.stopAll);
	await assert.rejects(() => c.bot.zi.search("yt:lofi"), /No results found/);
	assert.equal(c.yt.manager.calls.length, 0);
	await assert.rejects(() => c.bot.zi.searchOn("yt", "lofi"), (e) => e.code === "NOT_PROVIDED");
});

test("provideSearch({ allow }) can refuse, and the provide-search role is required", async (t) => {
	const c = await cluster({
		bot: { plugins: [sc()], serve: false, roles: ["provide-stream"] }, // what yt grants the bot: no provide-search
		yt: { plugins: [yt()], serve: true },
	});
	t.after(c.stopAll);
	await assert.rejects(() => c.bot.zi.searchOn("yt", "lofi"), (e) => e.code === "FORBIDDEN");

	const d = await cluster({
		bot: { plugins: [sc()], serve: false },
		yt: { plugins: [yt()], serve: { allow: (q) => !q.includes("blocked") } },
	});
	t.after(d.stopAll);
	await assert.rejects(() => d.bot.zi.searchOn("yt", "blocked words"), (e) => e.code === "FORBIDDEN");
	assert.ok((await d.bot.zi.searchOn("yt", "fine")).tracks.length);
});

test("merge asks every node and de-duplicates", async (t) => {
	const c = await cluster({
		bot: { plugins: [sc(2)], serve: true },
		yt: { plugins: [yt(2)], serve: true },
		yt2: { plugins: [yt(2)], serve: true },
	});
	t.after(c.stopAll);
	const r = await c.bot.zi.search("something", { merge: true, limit: 20 });
	assert.deepEqual([...r.nodes].sort(), ["yt", "yt2"].concat(r.nodes.includes("bot") ? ["bot"] : []).sort());
	const owners = r.tracks.map((x) => `${x.metadata?.net?.owner ?? "bot"}:${x.id}`);
	assert.equal(new Set(owners).size, owners.length, "no duplicate owner+id");
});

test("answers are trimmed to maxResults and maxResponseBytes", async (t) => {
	const big = { name: "youtube", canHandle: () => true, tracks: () => Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, title: "t".repeat(2000), url: `https://e/${i}` })) };
	const c = await cluster({
		bot: { plugins: [sc()], serve: false },
		yt: { plugins: [big], serve: { maxResults: 8, maxResponseBytes: 5000 } },
	});
	t.after(c.stopAll);
	const r = await c.bot.zi.search("yt:big", { limit: 50 });
	assert.ok(r.tracks.length >= 1 && r.tracks.length <= 2, `got ${r.tracks.length}`);
});

test("capabilities tell peers whether search is served", async (t) => {
	const c = await cluster({ bot: { plugins: [sc()], serve: false }, yt: { plugins: [yt()], serve: true } });
	t.after(c.stopAll);
	assert.equal((await c.bot.zi.peerCapabilities("yt")).search, true);
	assert.equal((await c.yt.zi.peerCapabilities("bot")).search, false);
});
