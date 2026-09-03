import type { StreamInfo, Track } from "ziplayer";
import { YouTubePlugin } from "./YouTubePlugin.js";
import { createSabrVideoStream } from "./utils/sabr-stream-factory.js";

export function installYouTubeVideo(): void {
	const prototype = YouTubePlugin.prototype as YouTubePlugin & {
		getVideo?: (track: Track, signal?: AbortSignal) => Promise<StreamInfo>;
	};

	if (prototype.getVideo) return;

	prototype.getVideo = async function getVideo(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		if (!track?.url && !track?.id) throw new Error("Track must have a URL or ID");
		const plugin = this as any;
		plugin.throwIfAborted?.(signal);
		await plugin.ready;
		plugin.throwIfAborted?.(signal);
		const id = track.id || plugin.extractVideoId(track.url);
		if (!id) throw new Error("Invalid YouTube video id");
		plugin.debug("🎬 Resolving YouTube video through SABR:", id);
		const result = await createSabrVideoStream(id, plugin.client, undefined, signal);
		plugin.throwIfAborted?.(signal);
		plugin.debug("✅ YouTube SABR video stream ready:", result.format);
		return {
			stream: result.stream,
			type: "arbitrary",
			metadata: {
				...track.metadata,
				title: result.title,
				itag: result.format.itag,
				mime: result.format.mimeType,
				contentLength: result.format.contentLength,
				mediaType: "video",
			},
		};
	};
}

installYouTubeVideo();
