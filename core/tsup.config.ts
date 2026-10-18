import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/plugins/index.ts", "src/plugins/BasePlugin.ts"],
	format: ["cjs", "esm"],
	outDir: "dist",
	// `tsup --no-dts` (build:fast) skips the slow declaration build; tests only need JS.
	dts: true,
	sourcemap: true,
	clean: true,
	target: "es2022",
	platform: "node",
	external: [
		"@discordjs/voice",
		"@snazzah/davey",
		"libsodium-wrappers",
		"lru-cache",
		"opusscript",
		"ffmpeg-static",
		"prism-media",
	],
	bundle: true,
	minify: false,
});
