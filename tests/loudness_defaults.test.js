const test = require("node:test");
const assert = require("node:assert/strict");
const { defaults, VolumeController, Bus } = require("../core/dist");

test("Loudness default constants match specification (6 dB boost, 12 dB cut, 1.0 limiter ceiling)", () => {
	assert.equal(defaults.loudness.maxBoostDb, 6);
	assert.equal(defaults.loudness.maxCutDb, 12);
	assert.equal(defaults.loudness.limiterCeiling, 1);
});

test("VolumeController auto-disables loudness in low-performance mode by default", () => {
	const bus = new Bus();
	const volumeController = new VolumeController(bus);
	const playerId = "test-low-perf-player";

	// Low performance mode active with loudness requested
	volumeController.attach(playerId, {
		lowPerformance: true,
		loudness: { enabled: true },
	});

	const state = volumeController.settings(playerId);
	assert.ok(state);
	assert.equal(state.enabled, false, "Loudness should be auto-disabled in low performance mode");
	assert.equal(state.maxBoostDb, 6);
	assert.equal(state.maxCutDb, 12);
	assert.equal(state.limiterCeiling, 1);

	volumeController.detach(playerId);
});

test("VolumeController respects autoDisableInLowPerformance: false", () => {
	const bus = new Bus();
	const volumeController = new VolumeController(bus);
	const playerId = "test-low-perf-override";

	volumeController.attach(playerId, {
		lowPerformance: true,
		loudness: { enabled: true, autoDisableInLowPerformance: false },
	});

	const state = volumeController.settings(playerId);
	assert.ok(state);
	assert.equal(state.enabled, true, "Loudness should remain enabled when auto-disable is explicitly false");

	volumeController.detach(playerId);
});

test("VolumeController keeps loudness enabled when lowPerformance is false", () => {
	const bus = new Bus();
	const volumeController = new VolumeController(bus);
	const playerId = "test-normal-perf";

	volumeController.attach(playerId, {
		lowPerformance: false,
		loudness: { enabled: true },
	});

	const state = volumeController.settings(playerId);
	assert.ok(state);
	assert.equal(state.enabled, true);

	volumeController.detach(playerId);
});
