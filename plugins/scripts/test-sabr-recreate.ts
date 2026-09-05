import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createSabrSeekStream } from "../src/utils/sabr-seek.js";
import { Innertube, UniversalCache, Platform, type Types } from "youtubei.js";
import { Log } from "youtubei.js";

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();
Log.setLevel(0);

const videoId = process.argv[2] ?? "J1X6LEa1hYA";
const position = Number(process.argv[3] ?? "3132162");
const output = resolve(process.argv[4] ?? `./tmp/sabr-recreate-${videoId}-${position}.webm`);
const maxBytes = Number(process.argv[5] ?? String(32 * 1024 * 1024));

if (!videoId) throw new Error("Usage: node dist/scripts/test-sabr-recreate.js <videoId> <positionMs> [output] [maxBytes]");
if (!Number.isFinite(position) || position < 0) throw new Error("positionMs must be a non-negative number");

function runFfmpeg(file: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise) => {
		let ffmpegPath: string;
		try {
			// ffmpeg-static is already a dependency of ZiPlayer core.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			ffmpegPath = require("ffmpeg-static") as string;
		} catch {
			ffmpegPath = "ffmpeg";
		}

		const child = spawn(ffmpegPath, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			file,
			"-t",
			"5",
			"-f",
			"null",
			"-",
		]);

		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolvePromise({ code, stderr }));
		child.on("error", (error) => resolvePromise({ code: -1, stderr: String(error) }));
	});
}

async function main(): Promise<void> {
	mkdirSync(dirname(output), { recursive: true });

	const client = await Innertube.create({
		cache: new UniversalCache(true),
		client_type: "WEB",
	} as any);

	const controller = new AbortController();
	const startedAt = Date.now();

	console.log("[SABR TEST] videoId:", videoId);
	console.log("[SABR TEST] seek position:", `${position}ms (${(position / 1000).toFixed(3)}s)`);
	console.log("[SABR TEST] output:", output);
	console.log("[SABR TEST] max bytes:", maxBytes);

	const stream = await createSabrSeekStream(videoId, client, position, controller.signal);
	console.log("[SABR TEST] recreate() returned stream after", `${Date.now() - startedAt}ms`);

	let bytes = 0;
	let chunks = 0;
	const limited = stream.pipe(new (await import("node:stream")).Transform({
		transform(chunk, _encoding, callback) {
			const buffer = Buffer.from(chunk);
			const remaining = maxBytes - bytes;
			if (remaining <= 0) {
				callback();
				return;
			}
			const outputChunk = buffer.subarray(0, remaining);
			bytes += outputChunk.length;
			chunks++;
			callback(null, outputChunk);
		},
		flush(callback) {
			callback();
		},
	}));

	await pipeline(limited, createWriteStream(output));

	const size = statSync(output).size;
	console.log("[SABR TEST] downloaded:", `${size} bytes`, `(${chunks} chunks)`);
	console.log("[SABR TEST] file:", output);

	if (size < 4096) {
		throw new Error(`Downloaded file is suspiciously small: ${size} bytes`);
	}

	const result = await runFfmpeg(output);
	if (result.code === 0) {
		console.log("[SABR TEST] ffmpeg decode: PASS");
	} else if (result.code === -1) {
		console.warn("[SABR TEST] ffmpeg unavailable; raw file was downloaded but decode was not checked");
		console.warn(result.stderr.trim());
	} else {
		console.error("[SABR TEST] ffmpeg decode: FAIL");
		console.error(result.stderr.trim());
		process.exitCode = 2;
	}
}

main().catch((error) => {
	console.error("[SABR TEST] FAILED");
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exitCode = 1;
});
