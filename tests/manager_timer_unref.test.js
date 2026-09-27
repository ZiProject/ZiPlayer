const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

// If code that embeds this library throws between `new PlayerManager()` and
// `.destroy()`/`.dispose()` (a retry loop, hot-reload, module restart, ...), that PlayerManager is
// never freed: every Map/cache/player inside it stays in memory, and — before this fix —
// `cleanupInterval`/`statsInterval` (both created with `autoCleanup: true`, the default) kept
// running forever, which also kept the whole Node process alive. Repeat that pattern enough times
// and memory grows without bound for the lifetime of the process. This can only be verified from
// a separate process: inside this same test-runner process, other handles already keep Node
// alive, so an un-ref'd timer here wouldn't visibly change anything.
const CHILD_SCRIPT = `
const { PlayerManager } = require(${JSON.stringify(path.join(__dirname, "..", "core", "dist"))});
new PlayerManager({ autoCleanup: true }); // starts cleanupInterval + statsInterval, never destroy()ed
console.log("created");
`;

test("a PlayerManager created and never destroyed does not keep the process alive", async () => {
	const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });

	let stdout = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));

	const exitedOnItsOwn = await new Promise((resolve) => {
		// If the process is still alive after a couple of seconds, its own unref'd timers are not
		// the reason — something is actively keeping it up (the bug this test guards against).
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 3000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});

	assert.ok(stdout.includes("created"), "the child process should have reached PlayerManager construction");
	assert.equal(
		exitedOnItsOwn,
		true,
		"an abandoned PlayerManager's cleanupInterval/statsInterval must be unref()'d so the process can exit on its own",
	);
});
