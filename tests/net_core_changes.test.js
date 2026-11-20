const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { PlayerManager } = require("../core/dist");

test("manager.resolveStream resolves through plugins without creating a player", async (t) => {
	const calls = [];
	const plugin = {
		name: "fake",
		version: "1.0.0",
		canHandle: () => true,
		validate: () => true,
		async search() {
			return { tracks: [] };
		},
		async getStream(track) {
			calls.push(track.id);
			return { stream: Readable.from([Buffer.from("opus")]), type: "webm/opus" };
		},
	};
	const mgr = new PlayerManager({ autoCleanup: false, plugins: [plugin] });
	t.after(() => mgr.destroy());
	const info = await mgr.resolveStream({ id: "t1", title: "T", url: "https://fake/1", duration: 1, source: "fake" });
	assert.ok(info?.stream, "stream returned");
	assert.equal(info.streamType, "webm/opus");
	assert.deepEqual(calls, ["t1"]);
	assert.deepEqual(mgr.getAll(), [], "no player was created");
	info.stream.destroy();
});

test("raw PCM is still refused by resolveStream", async (t) => {
	const plugin = {
		name: "rawfake",
		version: "1.0.0",
		canHandle: () => true,
		validate: () => true,
		async search() {
			return { tracks: [] };
		},
		async getStream() {
			return { stream: Readable.from([Buffer.alloc(4)]), type: "raw" };
		},
	};
	const mgr = new PlayerManager({ autoCleanup: false, plugins: [plugin] });
	t.after(() => mgr.destroy());
	const info = await mgr
		.resolveStream({ id: "t2", title: "T", url: "https://fake/2", duration: 1, source: "rawfake" })
		.catch((e) => e);
	assert.ok(info === null || info instanceof Error);
});

async function connectionWithFake(mgr, guildId) {
	const player = await mgr.create(guildId);
	const destroyCalls = [];
	const fake = {
		state: { status: "ready" },
		joinConfig: { guildId, channelId: "c1" },
		destroy(arg) {
			destroyCalls.push(arg);
			this.state = { status: "destroyed" };
		},
	};
	const controller = mgr.controllers.connection;
	const slot = controller.slots.get(guildId);
	assert.ok(slot, "connection slot exists for the player");
	slot.connection = fake;
	return { player, destroyCalls };
}

test("disconnect() leaves the Discord channel by default", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const { player, destroyCalls } = await connectionWithFake(mgr, "guild-leave");
	await player.disconnect();
	assert.deepEqual(destroyCalls, [true]);
});

test("disconnect({ silent: true }) releases the connection without leaving the channel", async (t) => {
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const { player, destroyCalls } = await connectionWithFake(mgr, "guild-silent");
	await player.disconnect({ silent: true });
	assert.deepEqual(destroyCalls, [false]);
});

test("extension streams are cached unless they opt out with cacheable: false", async (t) => {
	const { BaseExtension } = require("../core/dist");
	const counts = { cached: 0, single: 0 };
	const make = (key, extra) =>
		class extends BaseExtension {
			name = `ext-${key}`;
			version = "1.0.0";
			player = null;
			constructor(player) {
				super();
				this.player = player ?? null;
			}
			active() {
				return true;
			}
			async provideStream(_ctx, { track }) {
				counts[key]++;
				return { stream: Readable.from([Buffer.alloc(16)]), track, streamType: "arbitrary", ...extra };
			}
		};
	const mgr = new PlayerManager({ autoCleanup: false });
	t.after(() => mgr.destroy());
	const track = (id) => ({ id, title: id, url: `https://example.com/${id}`, duration: 1000, source: "x" });
	const attempt = async (player, tr) => {
		await player.play(tr, { requestedBy: "t" }).catch(() => {});
		await new Promise((r) => setTimeout(r, 150));
		await player.stop().catch(() => {});
	};
	const a = await mgr.create("cache-default", { extensions: [make("cached")] });
	await attempt(a, track("same"));
	await attempt(a, track("same"));
	const b = await mgr.create("cache-optout", { extensions: [make("single", { cacheable: false })] });
	await attempt(b, track("same"));
	await attempt(b, track("same"));
	assert.equal(counts.cached, 1, "default: the second play reuses the cached stream");
	assert.equal(counts.single, 2, "cacheable:false: every play asks the extension again");
});
