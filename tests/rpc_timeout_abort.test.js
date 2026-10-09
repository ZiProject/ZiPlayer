const test = require("node:test");
const assert = require("node:assert/strict");

const { Bus } = require("../core/dist");

test("requestRpc timeout aborts the handler's signal instead of leaving it running", async () => {
	const bus = new Bus();
	let sawAbort = false;
	bus.registerRpc(
		"slow.test",
		(_request, context) =>
			new Promise((resolve) => {
				context.signal.addEventListener("abort", () => {
					sawAbort = true;
					resolve("late");
				});
			}),
	);

	await assert.rejects(
		bus.requestRpc("player-1", "slow.test", {}, { timeoutMs: 30 }),
		(error) => error.name === "BusRequestError" && error.reason === "timeout",
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sawAbort, true, "handler should be told to stop once the caller timed out");
	bus.dispose?.();
});

test("requestRpc without timeout still passes through the caller's own signal", async () => {
	const bus = new Bus();
	const controller = new AbortController();
	let received = null;
	bus.registerRpc("echo.test", (_request, context) => {
		received = context.signal;
		return "ok";
	});
	assert.equal(await bus.requestRpc("player-1", "echo.test", {}, { signal: controller.signal }), "ok");
	assert.equal(received, controller.signal);
	bus.dispose?.();
});

test("requestRpc propagates a caller abort to the handler when a timeout is also set", async () => {
	const bus = new Bus();
	const controller = new AbortController();
	let sawAbort = false;
	bus.registerRpc(
		"slow2.test",
		(_request, context) =>
			new Promise((resolve) => {
				context.signal.addEventListener("abort", () => {
					sawAbort = true;
					resolve("aborted");
				});
			}),
	);
	const pending = bus.requestRpc("player-1", "slow2.test", {}, { timeoutMs: 5000, signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	assert.equal(await pending, "aborted");
	assert.equal(sawAbort, true);
	bus.dispose?.();
});
