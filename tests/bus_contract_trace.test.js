const test = require("node:test");
const assert = require("node:assert/strict");

const { BUS_REQUEST, BUS_OUTPUT, traceBusSignal } = require("../core/dist");

// BUS_REQUEST/BUS_OUTPUT values used to bake a human-readable "[Player]->[Connection]:connect"
// flow diagram directly into the wire value that Bus/Player/controllers switch on. That's now
// pulled out into `traceBusSignal`, a debug-only lookup — the wire values themselves are plain
// dot-notation identifiers, matching every other group in BusContract (CONTROLLER_RPC etc.).

test("BUS_REQUEST/BUS_OUTPUT values are plain identifiers, not [From]->[To] annotations", () => {
	for (const value of Object.values(BUS_REQUEST)) {
		assert.doesNotMatch(value, /\[.*\]->\[.*\]/, `${value} should not carry a [From]->[To] annotation`);
		assert.match(value, /^[a-z]+\.[a-zA-Z]+$/, `${value} should be a plain dot-notation identifier`);
	}
	for (const value of Object.values(BUS_OUTPUT)) {
		assert.doesNotMatch(value, /\[.*\]->\[.*\]/, `${value} should not carry a [From]->[To] annotation`);
		assert.match(value, /^[a-z]+\.[a-zA-Z]+$/, `${value} should be a plain dot-notation identifier`);
	}
});

test("traceBusSignal renders the [From]->[To]:label annotation for debug logging only", () => {
	assert.equal(traceBusSignal(BUS_REQUEST.connectionConnect), "[Player]->[Connection]:connect");
	assert.equal(traceBusSignal(BUS_OUTPUT.connectionConnected), "[Connection]->[Player]:connected");
	assert.equal(traceBusSignal(BUS_REQUEST.preloadRequest), "[Player]->[Preload]:request");
	assert.equal(traceBusSignal(BUS_OUTPUT.preloadReady), "[Preload]->[Player]:ready");
	assert.equal(traceBusSignal(BUS_REQUEST.recoveryRecover), "[Player]->[Recovery]:recover");
	assert.equal(traceBusSignal(BUS_OUTPUT.recoveryRetrying), "[Recovery]->[Player]:retrying");
	assert.equal(traceBusSignal(BUS_REQUEST.resourceRefresh), "[Player]->[Resource]:refresh");
	assert.equal(traceBusSignal(BUS_OUTPUT.resourceRefreshed), "[Resource]->[Player]:refreshed");
});

test("traceBusSignal falls back to the raw value for anything not in the table", () => {
	assert.equal(traceBusSignal("some.unknown.signal"), "some.unknown.signal");
});

test("every BUS_REQUEST/BUS_OUTPUT value has a trace entry (no silent gaps)", () => {
	for (const value of [...Object.values(BUS_REQUEST), ...Object.values(BUS_OUTPUT)]) {
		assert.notEqual(traceBusSignal(value), value, `missing BUS_SIGNAL_TRACE entry for "${value}"`);
	}
});
