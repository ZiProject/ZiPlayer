const test = require("node:test");
const assert = require("node:assert/strict");

const { Bus, BusLatencyTrace } = require("../core/dist");

test("Bus does not own latency trace state and BusLatencyTrace records without logging", () => {
	const bus = new Bus();
	assert.equal("setLatencyTrace" in bus, false);
	assert.equal(typeof bus.setLatencyTrace, "undefined");

	const records = [];
	const trace = new BusLatencyTrace((record) => records.push(record), "time");
	const value = trace.measure("rpc", "demo", () => 42);
	assert.equal(value, 42);
	assert.equal(records.length, 1);
	assert.equal(records[0].kind, "rpc");
	assert.equal(records[0].type, "demo");
	assert.ok(Number.isFinite(records[0].durationUs));
	assert.equal(typeof records[0].timestamp, "number");
});
