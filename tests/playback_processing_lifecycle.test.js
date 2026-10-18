const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const { Bus, PlaybackController } = require("../core/dist");
const { StreamType } = require("@discordjs/voice");
const { wavSource } = require("./helpers/wav");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createController(playerId, audioProcessing = { enabled: true }) {
	const controller = new PlaybackController(new Bus());
	const audioPlayer = Object.assign(new EventEmitter(), {
		state: { status: "idle" },
		play() {},
		pause: () => true,
		unpause: () => true,
		stop: () => true,
	});
	controller.attach(playerId, { audioPlayer, audioProcessing, stuckTimeoutMs: 1000 });
	return controller;
}

async function waitFor(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(25);
	}
	assert.fail(message);
}

test("destroying the processed resource releases a stalled source without waiting for player detach", async () => {
	const controller = createController("lifecycle-stalled");
	const stats = {};
	// FFmpeg probes ~3s of input (~30 chunks) before emitting its first byte; stall well after that.
	const source = Readable.from(wavSource({ seconds: 300, channels: 2, stats, hangAfter: 90 }));
	const resource = controller.createResource(
		"lifecycle-stalled",
		source,
		{ id: "t", title: "Stalled", duration: 1000 },
		StreamType.Arbitrary,
	);
	let bytes = 0;
	resource.playStream.on("data", (chunk) => (bytes += chunk.length));
	await waitFor(() => bytes > 0, 5000, "no audio reached the output before the source stalled");
	await sleep(300); // let the source reach its stall so no chunk is in flight

	// This is exactly what AudioPlayer does on stop()/replace.
	resource.playStream.destroy();

	await waitFor(() => source.destroyed, 2000, "stalled source was still open after the player destroyed the resource");
	controller.detach("lifecycle-stalled");
});

test("destroying a flowing processed resource finalizes the upstream source", async () => {
	const controller = createController("lifecycle-flowing");
	const stats = {};
	const source = Readable.from(wavSource({ seconds: 300, channels: 2, stats }));
	const resource = controller.createResource(
		"lifecycle-flowing",
		source,
		{ id: "t", title: "Flowing", duration: 1000 },
		StreamType.Arbitrary,
	);
	let bytes = 0;
	resource.playStream.on("data", (chunk) => (bytes += chunk.length));
	await waitFor(() => bytes > 0, 5000, "no audio reached the output");
	resource.playStream.destroy();
	await waitFor(() => stats.returned === true, 3000, "upstream generator was not finalized");
	assert.ok(stats.pulled < (300 * 44100 * 4) / 16384, "must not consume the whole track after destroy");
	controller.detach("lifecycle-flowing");
});

test("a source that fails mid-stream surfaces as a track error instead of silence", async () => {
	const controller = createController("lifecycle-error");
	const source = Readable.from(wavSource({ seconds: 300, channels: 2, errorAfter: 5 }));
	const resource = controller.createResource(
		"lifecycle-error",
		source,
		{ id: "t", title: "Dropped", duration: 1000 },
		StreamType.Arbitrary,
	);
	let hangTimer;
	const outcome = await Promise.race([
		(async () => {
			try {
				for await (const _chunk of resource.playStream) {
					// drain
				}
				return "completed";
			} catch (error) {
				return String(error.message);
			}
		})(),
		new Promise((resolve) => (hangTimer = setTimeout(() => resolve("hung"), 8000))),
	]);
	clearTimeout(hangTimer);
	assert.notEqual(outcome, "hung", "playback hung on an upstream error");
	assert.match(outcome, /Audio processing failed for Dropped.*ECONNRESET/);
	controller.detach("lifecycle-error");
});
