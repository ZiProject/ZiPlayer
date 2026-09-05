/**
 * @fileoverview Main export file for ZiPlayer plugins.
 */

export * from "./YouTubePlugin.js";
export * from "./SoundCloudPlugin.js";
export * from "./SpotifyPlugin.js";
export * from "./TTSPlugin.js";
export * from "./AttachmentsPlugin.js";

import { YouTubePlugin } from "./YouTubePlugin.js";
import { createSabrSeekStream } from "./utils/sabr-seek.js";

const youtubeGetStream = YouTubePlugin.prototype.getStream;
const sabrRecreateInstalled = Symbol.for("ziplayer.youtube.sabr-recreate-installed");

function extractYouTubeVideoId(url?: string): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.hostname === "youtu.be" || parsed.hostname === "www.youtu.be") {
			return parsed.pathname.slice(1).split("/")[0] || undefined;
		}
		if (["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
			return parsed.searchParams.get("v") || undefined;
		}
	} catch {}
	return undefined;
}

if (!(YouTubePlugin.prototype as any)[sabrRecreateInstalled]) {
	Object.defineProperty(YouTubePlugin.prototype, sabrRecreateInstalled, { value: true });
	YouTubePlugin.prototype.getStream = async function (track: any, signal?: AbortSignal) {
		const streamInfo = await youtubeGetStream.call(this, track, signal);
		if (!streamInfo?.stream || track?.source !== "youtube") return streamInfo;

		const videoId = track?.id || extractYouTubeVideoId(track?.url);
		const client = (this as any).client;
		if (!videoId || !client) return streamInfo;

		return {
			...streamInfo,
			recreate: async (position: number) => createSabrSeekStream(videoId, client, position, signal),
		};
	};
}
