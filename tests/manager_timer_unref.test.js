const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Diagnostic child:
// - creates a PlayerManager
// - prints active resources after construction
// - inspects active handles and their hasRef() state
// - stays alive long enough for the parent test to collect diagnostics
const CHILD_SCRIPT = `
const { PlayerManager } = require(${JSON.stringify(path.join(__dirname, "..", "core", "dist"))});

const manager = new PlayerManager({ autoCleanup: true });

console.log("created");

function dumpResources(label) {
    console.log("\\n=== " + label + " ===");

    // Public Node.js API: resource types currently keeping the event loop alive.
    if (typeof process.getActiveResourcesInfo === "function") {
        console.log(
            "activeResources:",
            JSON.stringify(process.getActiveResourcesInfo())
        );
    } else {
        console.log("activeResources: <unsupported>");
    }

    // Diagnostic only. This is intentionally not used by the library itself.
    if (typeof process._getActiveHandles === "function") {
        const handles = process._getActiveHandles();

        console.log("activeHandles:", handles.length);

        for (const [index, handle] of handles.entries()) {
            const type = handle?.constructor?.name ?? "<unknown>";

            let refState = "unknown";

            try {
                if (typeof handle?.hasRef === "function") {
                    refState = String(handle.hasRef());
                }
            } catch (error) {
                refState = "error:" + error.message;
            }

            console.log(
                "handle[" + index + "]:",
                type,
                "hasRef=" + refState
            );
        }
    } else {
        console.log("activeHandles: <unsupported>");
    }
}

dumpResources("after PlayerManager construction");

// Give timers/resources a chance to finish initialization.
setTimeout(() => {
    dumpResources("after 100ms");
    console.log("diagnostic-ready");
}, 100);
`;

test("a PlayerManager created and never destroyed does not keep the process alive", async () => {
	const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";

	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});

	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const exitedOnItsOwn = await new Promise((resolve) => {
		// If the process is still alive after a couple of seconds, its own unref'd timers are not
		// the reason — something is actively keeping it up (the bug this test guards against).
		const timer = setTimeout(() => {
			console.error("\n========== CHILD DID NOT EXIT ==========");
			console.error(stdout);

			if (stderr) {
				console.error("\n========== CHILD STDERR ==========");
				console.error(stderr);
			}

			child.kill();
			resolve(false);
		}, 3000);

		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve(true);
		});
	});

	assert.ok(
		stdout.includes("created"),
		"the child process should have reached PlayerManager construction",
	);

	assert.equal(
		exitedOnItsOwn,
		true,
		[
			"an abandoned PlayerManager should not keep the process alive.",
			"See CHILD STDOUT above for active resources/handles.",
		].join(" "),
	);
});