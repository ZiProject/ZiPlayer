const test = require("node:test");
const assert = require("node:assert/strict");

const { Bus, createSharedControllers, PlaybackMode, BUS_EVENT, PLAYER_QUERY } = require("../core/dist");

test("forward mode ignores queue-empty leave and clears pending timers", async (t) => {
	const bus = new Bus();
	const { lifecycle } = createSharedControllers({ bus });
	const playerId = "g1";
	let mode = PlaybackMode.NATIVE;
	let queue = [];
	let isPlaying = false;
	let requestCount = 0;

	bus.registerQuery(PLAYER_QUERY.playbackMode, () => mode);
	bus.registerQuery(PLAYER_QUERY.queue, () => queue);
	bus.registerQuery(PLAYER_QUERY.isPlaying, () => isPlaying);

	const originalRequest = bus.request.bind(bus);
	bus.request = (...args) => {
		requestCount += 1;
		return originalRequest(...args);
	};

	lifecycle.attach(playerId, { leaveOnEmpty: true, leaveTimeout: 50 }, () => undefined);

	mode = PlaybackMode.FORWARD;
	queue = [];
	bus.publish(playerId, BUS_EVENT.queueChanged, queue);
	lifecycle.scheduleLeave(playerId, "queue-empty");
	assert.equal(requestCount, 0);

	mode = PlaybackMode.NATIVE;
	lifecycle.scheduleLeave(playerId, "queue-empty");
	assert.equal(requestCount, 0);

	mode = PlaybackMode.FORWARD;
	bus.publish(playerId, BUS_EVENT.forwardModeStart, {});
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(requestCount, 0);

	t.after(() => {
		lifecycle.detach(playerId);
		bus.dispose();
	});
});
