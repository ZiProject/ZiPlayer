// pretest helper: rebuild core only when dist is missing or older than src.
// Uses the fast build (no .d.ts) because tests only load the JS output.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "core", "src");
const distEntry = path.join(root, "core", "dist", "index.js");

function newestMtime(dir) {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
	}
	return newest;
}

const configs = ["package.json", "tsup.config.ts", "tsconfig.json"].map((f) => path.join(root, "core", f));
const srcNewest = Math.max(newestMtime(srcDir), ...configs.filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs));
const distTime = fs.existsSync(distEntry) ? fs.statSync(distEntry).mtimeMs : 0;

if (process.env.ZIPLAYER_FORCE_BUILD !== "1" && distTime > srcNewest) {
	console.log("[pretest] core/dist is up to date, skipping build");
	process.exit(0);
}

console.log("[pretest] building core (fast, no .d.ts)...");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["run", "build:fast", "--prefix", "core"], {
	cwd: root,
	stdio: "inherit",
	shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
