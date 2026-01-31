import { BasePlugin } from "ziplayer";
import { Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";
import youtubedl from "youtube-dl-exec";

/**
 * Converts a Web ReadableStream to a Node.js Readable stream
 */
export function webStreamToNodeStream(webStream: ReadableStream): Readable {
	const nodeStream = new Readable({
		read() {
			// This will be handled by the Web Stream reader
		},
	});

	// Create a reader from the Web Stream
	const reader = webStream.getReader();

	// Read chunks and push to Node.js stream
	const pump = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					nodeStream.push(null); // End the stream
					break;
				}
				nodeStream.push(Buffer.from(value));
			}
		} catch (error) {
			nodeStream.destroy(error as Error);
		}
	};

	// Start pumping data
	pump();

	return nodeStream;
}

async function getYoutubeStream(url: string): Promise<string | null> {
	const info = await youtubedl(url, {
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
			const response = await fetch(youtubeUrl);
			if (!response.ok || !response.body) {
				throw new Error("Failed to fetch YouTube stream");
			}
			const stream = webStreamToNodeStream(response.body as ReadableStream) as unknown as Readable;

			return {
				stream,
				type: "arbitrary",
				metadata: track.metadata,
			};
		} catch (error) {
			throw new Error(`Failed to get YouTube stream: ${error}`);
		}
	}
}
