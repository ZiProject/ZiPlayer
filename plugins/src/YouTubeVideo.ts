import type { StreamInfo, Track } from "ziplayer";
import { YouTubePlugin } from "./YouTubePlugin.js";
import { mintYouTubePoToken } from "./utils/youtube-botguard.js";

/**
 * Installs the optional SourcePlugin.getVideo implementation for YouTube.
 *
 * Kept separate from YouTubePlugin so the video resolver can evolve independently
 * from the audio/SABR playback pipeline.
 */
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

		plugin.debug("🎬 Resolving YouTube video stream:", id);

		const poToken = await mintYouTubePoToken(id, signal);
		plugin.throwIfAborted?.(signal);

		const videoInfo = await plugin.client.getBasicInfo(id, { client: "YTMUSIC" });
		plugin.throwIfAborted?.(signal);

		const format = videoInfo.chooseFormat({
			quality: "best",
			type: "video",
		});

		if (!format) throw new Error("youtubei.js could not choose a video format");

		const decipheredUrl = await format.decipher(plugin.client.session.player);
		plugin.throwIfAborted?.(signal);

		if (!decipheredUrl) throw new Error("youtubei.js returned an empty deciphered video URL");

		const separator = decipheredUrl.includes("&") ? "&" : "?";
		const videoUrl = `${decipheredUrl}${separator}pot=${encodeURIComponent(poToken)}`;

		plugin.debug("✅ YouTube video format resolved:", {
			itag: format.itag,
			mimeType: (format as any).mime_type ?? (format as any).mimeType,
			quality: (format as any).quality,
		});

		return {
			url: videoUrl,
			type: "url",
			metadata: {
				...track.metadata,
				itag: format.itag,
				mime: (format as any).mime_type ?? (format as any).mimeType,
				mediaType: "video",
			},
		};
	};
}

installYouTubeVideo();
