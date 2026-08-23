import type { Track, StreamInfo } from "ziplayer";
import { Readable } from "node:stream";

import { webStreamToNodeStream } from "./stream-converter.js";
import { mintYouTubePoToken } from "./youtube-botguard.js";
import { YouTubePlugin } from "../YouTubePlugin.js";

const PATCHED = "__ziplayer_youtube_botguard_download_patched" as const;

type PluginPrototype = {
	[PATCHED]?: boolean;
	downloadWithYoutubei?: (track: Track, id: string, signal?: AbortSignal) => Promise<StreamInfo>;
	getStream: (track: Track, signal?: AbortSignal) => Promise<StreamInfo>;
	debug?: (message?: any, ...optionalParams: any[]) => void;
};

export function installYouTubeBotGuardDownload(): void {
	const prototype = YouTubePlugin.prototype as unknown as PluginPrototype & Record<string, any>;
	if (prototype[PATCHED]) return;

	const originalGetStream = prototype.getStream;

	prototype.downloadWithYoutubei = async function downloadWithYoutubei(
		this: PluginPrototype & Record<string, any>,
		track: Track,
		id: string,
		signal?: AbortSignal,
	): Promise<StreamInfo> {
		this.debug?.("🚀 Attempting youtubei.js download with BotGuard WebPO token");

		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		}

		const poToken = await mintYouTubePoToken(id, signal);
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		}

		const client = this.client;
		if (!client) throw new Error("YouTube client is not initialized");

		const stream = await client.download(id, {
			type: "audio",
			quality: "best",
			po_token: poToken,
		} as any);

		if (signal?.aborted) {
			try {
				await stream?.cancel(signal.reason);
			} catch {}
			throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		}

		if (!stream || typeof (stream as any).getReader !== "function") {
			throw new Error("youtubei.js did not return a Web ReadableStream");
		}

		const nodeStream = await webStreamToNodeStream(stream as ReadableStream<Uint8Array>, 32 * 1024, 0, signal);

		nodeStream.on("error", (error: Error) => {
			const message = error.message || String(error);
			if (!message.includes("Controller is already closed")) {
				this.debug?.("⚠️ youtubei.js stream error:", message);
			}
		});

		if (!Readable.isReadable(nodeStream)) {
			throw new Error("youtubei.js did not return a readable Node.js stream");
		}

		this.debug?.("✅ youtubei.js download with BotGuard WebPO token succeeded");

		return {
			stream: nodeStream,
			type: "arbitrary",
			metadata: track.metadata,
		};
	};

	prototype.getStream = async function getStream(
		this: PluginPrototype & Record<string, any>,
		track: Track,
		signal?: AbortSignal,
	): Promise<StreamInfo> {
		try {
			return await originalGetStream.call(this, track, signal);
		} catch (error: any) {
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
			}

			const id = track.id || this.extractVideoId?.(track.url);
			if (!id) throw error;

			this.debug?.("🔁 SABR failed; falling back to youtubei.js + BotGuard WebPO", error?.message);

			try {
				return await this.downloadWithYoutubei!(track, id, signal);
			} catch (youtubeError: any) {
				this.debug?.("❌ youtubei.js + BotGuard fallback failed:", youtubeError?.message);

				throw new Error(
					`YouTube stream extraction failed: ${youtubeError?.message || youtubeError}`,
					{ cause: error },
				);
			}
		}
	};

	prototype[PATCHED] = true;
}

installYouTubeBotGuardDownload();
