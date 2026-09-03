import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { YouTubePlugin } from "./src";

const plugin = new YouTubePlugin({});

const track = {
	id: process.argv[2] ?? "J1X6LEa1hYA",
	url: `https://www.youtube.com/watch?v=${process.argv[2] ?? "J1X6LEa1hYA"}`,
	title: "test",
	metadata: {},
} as any;

async function main() {
	const info = await plugin?.getVideo?.(track);

	console.log("Metadata:", info.metadata);

	await pipeline(info.stream!, createWriteStream(process.argv[3] ?? "./test-video.mp4"));

	console.log("Done");
}

main().catch(console.error);
