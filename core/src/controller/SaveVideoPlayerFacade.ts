import type { Readable } from "stream";
import type { SaveOptions, Track } from "../types";
import { Player } from "../structures/Player";
import type { VideoResolveOptions } from "./VideoPluginFacade";

export type SaveVideoOptions = Pick<SaveOptions, "filename" | "quality">;

declare module "../structures/Player" {
	interface Player {
		saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Readable>;
	}
}

/**
 * Installs the public Player.saveVideo facade.
 *
 * Video export intentionally stays video-only. The provider owns video
 * extraction; callers that need an audio+video container can mux the returned
 * streams in their own pipeline.
 */
export function installSaveVideoFacade(): void {
	const prototype = Player.prototype as Player & {
		saveVideo?: (track: Track, options?: SaveVideoOptions | string) => Promise<Readable>;
	};

	if (prototype.saveVideo) return;

	prototype.saveVideo = async function saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Readable> {
		if (!track) throw new TypeError("A track is required to save video");

		const saveOptions: SaveVideoOptions = typeof options === "string" ? { filename: options } : options ?? {};
		this.debug(`[Player] saveVideo called for track: ${track.title}`);

		try {
			await this.applyTrackMiddleware(track);

			const streamInfo = await this.pluginManager.getVideo(track, {
				quality: saveOptions.quality,
			});

			if (!streamInfo?.stream) {
				throw new Error(`No video stream available for track: ${track.title}`);
			}

			if (saveOptions.filename) {
				this.debug(
					`[Player] saveVideo options - filename: ${saveOptions.filename}, quality: ${saveOptions.quality ?? "default"}`,
				);
			}

			return streamInfo.stream;
		} catch (error) {
			this.debug("[Player] saveVideo error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	};
}

installSaveVideoFacade();
