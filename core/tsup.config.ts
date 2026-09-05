import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/plugins/index.ts", "src/plugins/BasePlugin.ts"],
	format: ["cjs", "esm"],
	outDir: "dist",
	dts: true,
	sourcemap: true,
	clean: true,
	target: "es2022",
	platform: "node",
	external: ["@discordjs/voice", "@snazzah/davey", "discord-api-types", "libsodium-wrappers", "lru-cache", "opusscript"],
	noExternal: ["ffmpeg-static"],
	bundle: true,
	minify: false,
});
