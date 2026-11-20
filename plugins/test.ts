import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { YouTubePlugin } from "./src";

const plugin = new YouTubePlugin({
	debug: console.log,
});

const track = {
	id: "J1X6LEa1hYA",
	url: `https://www.youtube.com/watch?v=${"J1X6LEa1hYA"}`,
	title: "test",
	metadata: {},
} as any;

async function main() {
	const video = await plugin?.getVideo?.(track);
	await pipeline(video.stream!, createWriteStream("./test-video.mp4"));
	const audio = await plugin?.getStream?.(track);
	await pipeline(audio.stream!, createWriteStream("./test-audio.opus"));
	console.log("Done");
}

main().catch(console.error);
