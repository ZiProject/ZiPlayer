const test = require("node:test");
const assert = require("node:assert/strict");

const { createSharedControllers, BUS_REQUEST, BUS_OUTPUT, traceBusSignal } = require("../core/dist");

// `debugSink` used to be an accepted-but-unused parameter of `createSharedControllers`.
// ConnectionController/PreloadController/ResourceRefreshController/AntiStuckController now log
// through it, using `traceBusSignal` so the old "[From]->[To]:label" picture that used to be
// baked into the wire value is still visible — but only in debug output.

const collectDebug = () => {
	const lines = [];
	return { lines, debugSink: (message) => lines.push(String(message)) };
};

test("ConnectionController logs traceBusSignal(connectionConnect) when handling the request", () => {
	const { lines, debugSink } = collectDebug();
	const { connection, bus } = createSharedControllers({ debugSink });
	connection.attach("g1", {});

	bus.emitInput({
		type: BUS_REQUEST.connectionConnect,
		requestId: "r1",
		playerId: "g1",
		channel: { id: "c1", guild: { id: "g1", voiceAdapterCreator: () => {} } },
	});

	assert.ok(
		lines.some((line) => line.includes(traceBusSignal(BUS_REQUEST.connectionConnect)) && line.includes("guild=g1")),
		`expected a debug line with "${traceBusSignal(BUS_REQUEST.connectionConnect)}", got: ${JSON.stringify(lines)}`,
	);
});

test("PreloadController logs traceBusSignal(preloadRequest) when request() is called", () => {
	const { lines, debugSink } = collectDebug();
	const { preload, preloadManager } = createSharedControllers({ debugSink });
	preload.attach("g1");
	preloadManager.attach("g1", { requestLoad: async () => null });

	const track = { id: "t1", title: "t1", url: "https://example.com/t1", duration: 1000, requestedBy: "tester", source: "test" };
	void preload.request("g1", track).catch(() => {});

	assert.ok(
		lines.some((line) => line.includes(traceBusSignal(BUS_REQUEST.preloadRequest)) && line.includes("g1")),
		`expected a debug line with "${traceBusSignal(BUS_REQUEST.preloadRequest)}", got: ${JSON.stringify(lines)}`,
	);
});
