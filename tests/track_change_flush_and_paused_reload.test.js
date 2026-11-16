const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");
const { createTrackedAudioPlayer } = require("./helpers/audio-player");
const {
	Bus,
	PlaybackController,
	PlaybackSession,
	AntiStuckController,
	WebAudioConnection,
	CONTROLLER_RPC,
} = require("../core/dist");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 2000) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.ok(predicate(), "condition was not met in time");
};

// One valid 20ms Opus packet (CELT FB, code 0) followed by a marker byte identifying the source track.
const opusStream = (marker, count = Infinity) => {
	let produced = 0;
	return new Readable({
		objectMode: true,
		read() {
			if (produced++ >= count) this.push(null);
			else this.push(Buffer.from([0xf8, 0xff, 0xfe, marker]));
		},
	});
};
const makeResource = (marker, count) => createAudioResource(opusStream(marker, count), { inputType: StreamType.Opus });

const makeSocket = () => ({
	readyState: 1,
	bufferedAmount: 0,
	sent: [],
	send(data) {
		this.sent.push(data);
	},
	close() {},
	addEventListener() {},
	removeEventListener() {},
});
const FRAME_MARKER_OFFSET = 16 + 3;
const framesOf = (socket) => socket.sent.filter((m) => typeof m !== "string").map((m) => m[FRAME_MARKER_OFFSET]);
const flushIndexes = (socket) =>
	socket.sent.flatMap((m, i) => (typeof m === "string" && JSON.parse(m).type === "playback:flush" ? [i] : []));

const setupWeb = () => {
	const player = createTrackedAudioPlayer();
	const connection = new WebAudioConnection({ sessionId: "flush-test" });
	const socket = makeSocket();
	connection.attachSocket(socket);
	assert.ok(connection.subscribe(player));
	return { player, connection, socket };
};

test("WebAudioConnection drops the congested backlog of the old track when a new resource starts", async () => {
	const { player, connection, socket } = setupWeb();
	socket.bufferedAmount = 10_000_000; // congested listener: frames pile up in the per-socket queue
	player.play(makeResource(0xaa));
	await sleep(400);
	player.play(makeResource(0xbb));
	socket.bufferedAmount = 0; // listener catches up: any stale backlog would be delivered now
	await waitFor(() => framesOf(socket).includes(0xbb));
	await sleep(100);

	const [flushAt] = flushIndexes(socket);
	assert.notEqual(flushAt, undefined, "a playback:flush control message must be sent on source change");
	const afterFlush = socket.sent.slice(flushAt + 1).filter((m) => typeof m !== "string");
	assert.ok(afterFlush.length > 0);
	assert.ok(
		afterFlush.every((m) => m[FRAME_MARKER_OFFSET] === 0xbb),
		"no frame of the previous track may be delivered after the flush",
	);
	connection.destroy();
});

test("WebAudioConnection flushes when playback is stopped or skipped abruptly", async () => {
	const { player, connection, socket } = setupWeb();
	player.play(makeResource(0xaa));
	await waitFor(() => framesOf(socket).length > 3);
	player.stop(true);
	await waitFor(() => flushIndexes(socket).length === 1);
	assert.equal(JSON.parse(socket.sent[flushIndexes(socket)[0]]).reason, "stopped");
	connection.destroy();
});

test("WebAudioConnection lets the tail of a naturally ended track play out", async () => {
	const { player, connection, socket } = setupWeb();
	player.play(makeResource(0xaa, 5));
	await waitFor(() => player.state.status === AudioPlayerStatus.Idle, 3000);
	player.play(makeResource(0xbb));
	await waitFor(() => framesOf(socket).includes(0xbb));
	assert.equal(flushIndexes(socket).length, 0, "natural end -> next track must not cut the previous track's last frames");
	connection.destroy();
});

test("PlaybackController: a stream dying while paused is not a track end and the reload stays paused", async () => {
	const playerId = "paused-reload";
	const bus = new Bus();
	const { player, connection, socket } = setupWeb();
	const trackEnds = [];
	const trackErrors = [];
	const stuckReports = [];
	bus.subscribe(playerId, "TRACK_END", (e) => trackEnds.push(e));
	bus.subscribe(playerId, "TRACK_ERROR", (e) => trackErrors.push(e));
	bus.registerRpc(CONTROLLER_RPC.antiStuckReport, (req) => {
		stuckReports.push(req);
		return true;
	});
	const controller = new PlaybackController(bus);
	controller.attach(playerId, { audioPlayer: player });
	const track = { id: "t1", title: "t1", url: "x", source: "test" };
	const session = new PlaybackSession();
	session.begin(track);

	const first = makeResource(0xaa);
	await controller.play(playerId, first, session);
	await waitFor(() => player.state.status === AudioPlayerStatus.Playing);
	session.markPlaying(0);
	await controller.pause(playerId);
	session.markPaused();
	assert.equal(player.state.status, AudioPlayerStatus.Paused);

	// StreamManager.cleanupExpiredStreams() destroys the stream of a paused track.
	first.playStream.destroy(new Error("Premature close"));
	await waitFor(() => player.state.status === AudioPlayerStatus.Idle);
	await sleep(50);

	assert.equal(trackEnds.length, 0, "stream failure must not be reported as TRACK_END (would skip to next/queue end)");
	assert.equal(trackErrors.length, 1);
	assert.equal(stuckReports.length, 1);
	assert.equal(stuckReports[0].immediate, true, "hard stream failures retry immediately");
	assert.equal(session.isActive(), true, "session must survive so anti-stuck can reload it");

	// What ResourceRefreshController does on retry for a paused session.
	const framesBefore = framesOf(socket).length;
	await controller.play(playerId, makeResource(0xbb), session, undefined, undefined, undefined, true);
	await sleep(150);
	assert.equal(player.state.status, AudioPlayerStatus.Paused, "reload must keep the player paused");
	assert.equal(framesOf(socket).slice(framesBefore).includes(0xbb), false, "no audio may leak while the reload is paused");

	await controller.resume(playerId);
	await waitFor(() => framesOf(socket).includes(0xbb));
	assert.equal(trackEnds.length, 0);
	controller.dispose();
	connection.destroy();
});

test("PlaybackController falls back to a skip when anti-stuck cannot recover a dead stream", async () => {
	const playerId = "dead-stream-fallback";
	const bus = new Bus();
	const { player, connection } = setupWeb();
	const actions = [];
	bus.onAction((action) => actions.push(action.type));
	bus.registerRpc(CONTROLLER_RPC.antiStuckReport, () => false); // e.g. anti-stuck disabled
	const controller = new PlaybackController(bus);
	controller.attach(playerId, { audioPlayer: player });
	const session = new PlaybackSession();
	session.begin({ id: "t2", title: "t2", url: "x", source: "test" });
	const resource = makeResource(0xaa);
	await controller.play(playerId, resource, session);
	await waitFor(() => player.state.status === AudioPlayerStatus.Playing);
	session.markPlaying(0);
	resource.playStream.destroy(new Error("Premature close"));
	await waitFor(() => actions.includes("SKIP"));
	controller.dispose();
	connection.destroy();
});

test("AntiStuckController skips the retry delay for immediate (hard failure) reports", async () => {
	const playerId = "antistuck-immediate";
	const bus = new Bus();
	const antiStuck = new AntiStuckController(bus);
	antiStuck.attach(playerId, { retryDelayMs: 60_000, maxRetries: 2 });
	const session = new PlaybackSession();
	session.begin({ id: "t3", title: "t3", url: "x", source: "test" });
	session.markPlaying(0);
	let retried = 0;
	const handlers = {
		retry: async () => {
			retried++;
			return true;
		},
		skip: async () => {},
	};
	const started = Date.now();
	const ok = await bus.requestRpc(playerId, CONTROLLER_RPC.antiStuckReport, {
		session,
		reason: "audio player error: Premature close",
		handlers,
		immediate: true,
	});
	assert.equal(ok, true);
	assert.equal(retried, 1);
	assert.ok(Date.now() - started < 2000, "immediate reports must not wait for retryDelayMs");
	antiStuck.detach(playerId);
});

// A reloaded resource can take arbitrarily long to become readable (FFmpeg seeking on a piped YouTube
// stream). The pause must not depend on a timeout: it is armed before play() and fires on Playing.
const slowResource = (marker, delayMs) => {
	let ready = false;
	const stream = new Readable({
		objectMode: true,
		read() {
			if (ready) this.push(Buffer.from([0xf8, 0xff, 0xfe, marker]));
		},
	});
	setTimeout(() => {
		ready = true;
		stream.read(0);
		stream.push(Buffer.from([0xf8, 0xff, 0xfe, marker]));
	}, delayMs);
	return createAudioResource(stream, { inputType: StreamType.Opus });
};

test("PlaybackController: a slow paused reload still ends up paused with no audio", async () => {
	const playerId = "slow-paused-reload";
	const bus = new Bus();
	const { player, connection, socket } = setupWeb();
	const controller = new PlaybackController(bus);
	controller.attach(playerId, { audioPlayer: player });
	const session = new PlaybackSession();
	session.begin({ id: "t4", title: "t4", url: "x", source: "test" });
	session.markPaused();

	await controller.play(playerId, slowResource(0xbb, 500), session, undefined, undefined, undefined, true);
	assert.equal(player.state.status, AudioPlayerStatus.Buffering, "play() must not wait for the stream");
	await waitFor(() => player.state.status === AudioPlayerStatus.Paused, 3000);
	await sleep(150);
	assert.equal(framesOf(socket).includes(0xbb), false, "no frame may be sent for a paused reload");
	connection.destroy();
	controller.dispose();
});

test("PlaybackController: resume while a paused reload is still buffering plays it when ready", async () => {
	const playerId = "resume-while-buffering";
	const bus = new Bus();
	const { player, connection, socket } = setupWeb();
	const controller = new PlaybackController(bus);
	controller.attach(playerId, { audioPlayer: player });
	const session = new PlaybackSession();
	session.begin({ id: "t5", title: "t5", url: "x", source: "test" });
	session.markPaused();

	await controller.play(playerId, slowResource(0xbb, 400), session, undefined, undefined, undefined, true);
	assert.equal(await controller.resume(playerId), true);
	await waitFor(() => framesOf(socket).includes(0xbb), 3000);
	assert.equal(player.state.status, AudioPlayerStatus.Playing);
	connection.destroy();
	controller.dispose();
});
