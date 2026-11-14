// pretest helper: rebuild core (and @ziplayer/net) only when dist is missing or older than src.
// Uses the fast build (no .d.ts) because tests only load the JS output.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
function newestMtime(dir) {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
	}
	return newest;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function ensureBuild({ name, dir, entry, configFiles, script }) {
	const srcDir = path.join(root, dir, "src");
	const distEntry = path.join(root, dir, "dist", entry);
	if (!fs.existsSync(srcDir)) return 0;
	const configs = configFiles.map((f) => path.join(root, dir, f));
	const srcNewest = Math.max(newestMtime(srcDir), ...configs.filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs));
	const distTime = fs.existsSync(distEntry) ? fs.statSync(distEntry).mtimeMs : 0;
	if (process.env.ZIPLAYER_FORCE_BUILD !== "1" && distTime > srcNewest) {
		console.log(`[pretest] ${dir}/dist is up to date, skipping build`);
		return 0;
	}
	console.log(`[pretest] building ${name}...`);
	const r = spawnSync(npm, ["run", script, "--prefix", dir], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
	return r.status ?? 1;
}

// Core: fast build (no .d.ts) because tests only load the JS output.
let status = ensureBuild({
	name: "core (fast, no .d.ts)",
	dir: "core",
	entry: "index.js",
	configFiles: ["package.json", "tsup.config.ts", "tsconfig.json"],
	script: "build:fast",
});

// @ziplayer/net: plain tsc. Needs `npm install --prefix net` once; skipped (with a notice) otherwise.
if (status === 0 && fs.existsSync(path.join(root, "net", "node_modules", "typescript"))) {
	status = ensureBuild({
		name: "net",
		dir: "net",
		entry: "index.js",
		configFiles: ["package.json", "tsconfig.json"],
		script: "build",
	});
} else if (status === 0 && fs.existsSync(path.join(root, "net", "src"))) {
	console.log("[pretest] net/node_modules missing: run `npm install --prefix net` to build and test @ziplayer/net");
}

process.exit(status);
