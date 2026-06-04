import { BasePlugin } from "ziplayer";
import { Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";
import youtubedl from "youtube-dl-exec";
import { url } from "inspector/promises";

function extractVideoId(input: string): string | null {
	try {
		const u = new URL(input);
		const allowedShortHosts = ["youtu.be"];
		const allowedLongHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"];
		if (allowedShortHosts.includes(u.hostname)) {
			return u.pathname.split("/").filter(Boolean)[0] || null;
		}
		if (allowedLongHosts.includes(u.hostname)) {
			// watch?v=, shorts/, embed/
			if (u.searchParams.get("v")) return u.searchParams.get("v");
			const path = u.pathname;
			if (path.startsWith("/shorts/")) return path.replace("/shorts/", "");
			if (path.startsWith("/embed/")) return path.replace("/embed/", "");
		}
		return null;
	} catch {
		return null;
	}
}

async function getYoutubeStream(url: string): Promise<string | null> {
	const URL = "https://youtu.be/" + extractVideoId(url);
	const info = await youtubedl(URL, {
		dumpSingleJson: true,
		noCheckCertificates: true,
		noWarnings: true,
		preferFreeFormats: true,
		format: "bestaudio/best",
		addHeader: ["referer:youtube.com", "user-agent:googlebot"],
	});

	const videourl = typeof info === "object" ? (info as any)?.url : info;
	if (!videourl) {
		return null;
	}

	return videourl;
}

export class YTexec extends BasePlugin {
	name = "YTexec";
	version = "1.0.0";

	canHandle(query: string): boolean {
		const q = (query || "").trim().toLowerCase();
		const isUrl = q.startsWith("http://") || q.startsWith("https://");
		if (isUrl) {
			try {
				const parsed = new URL(query);
				const allowedHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"];
				return allowedHosts.includes(parsed.hostname.toLowerCase());
			} catch (e) {
				return false;
			}
		}
		return false;
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		return { tracks: [] };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		try {
			const youtubeUrl = await getYoutubeStream(track.url);
			if (!youtubeUrl) {
				throw new Error("Failed to get YouTube stream URL");
			}

			return {
				url: youtubeUrl,
				type: "url",
				metadata: track.metadata,
			};
		} catch (error) {
			throw new Error(`Failed to get YouTube stream: ${error}`);
		}
	}
}
