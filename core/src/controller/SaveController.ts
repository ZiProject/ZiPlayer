import { Readable } from "stream";
import type { AudioFilter, SaveOptions, StreamInfo, Track, TrackMiddleware, TrackMiddlewareContext } from "../types";
import { FilterController } from "./FilterController";

export interface SaveControllerOptions {
	middleware?: TrackMiddleware[];
	middlewareContext: TrackMiddlewareContext;
	resolveStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	ffmpegPath?: string | null;
	debug?: (message?: any, ...optionalParams: any[]) => void;
}

/**
 * Owns the non-playback stream export pipeline.
 *
 * Save deliberately resolves a fresh provider stream instead of reusing the
 * active playback/preload stream. This keeps saving isolated from playback.
 */
export class SaveController {
	private readonly middleware: TrackMiddleware[];
	private readonly context: TrackMiddlewareContext;
	private readonly resolveStream: SaveControllerOptions["resolveStream"];
	private readonly ffmpegPath?: string | null;
	private readonly debug: NonNullable<SaveControllerOptions["debug"]>;

	public constructor(options: SaveControllerOptions) {
		this.middleware = [...(options.middleware ?? [])];
		this.context = options.middlewareContext;
		this.resolveStream = options.resolveStream;
		this.ffmpegPath = options.ffmpegPath;
		this.debug = options.debug ?? (() => undefined);
	}

	public async save(track: Track, options?: SaveOptions | string): Promise<Readable> {
		if (!track) throw new TypeError("A track is required to save audio");

		const saveOptions: SaveOptions = typeof options === "string" ? { filename: options } : options ?? {};
		this.debug(`[SaveController] save called for track: ${track.title}`);

		await this.applyMiddleware(track);

		const streamInfo = await this.resolveStream(track);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		this.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			this.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		if (!saveOptions.filter?.length && saveOptions.seek === undefined) return streamInfo.stream;

		// Never mutate the player's active FilterController. Saving is an
		// independent export operation and therefore gets an isolated FFmpeg
		// filter pipeline.
		const filterController = new FilterController(
			{ refreshPlayerResource: async () => true },
			this.debug,
			undefined,
			{ ffmpegPath: this.ffmpegPath },
		);

		try {
			const filters: AudioFilter[] = saveOptions.filter ?? [];
			if (filters.length) await filterController.applyFilters(filters);
			const seek = typeof saveOptions.seek === "number" && saveOptions.seek >= 0 ? saveOptions.seek : -1;
			this.debug(`[SaveController] Applying filters to save stream: ${filterController.getFilterString() || "none"}`);
			return (await filterController.applyFiltersAndSeek(streamInfo, seek)).stream!;
		} finally {
			// FFmpeg resources are intentionally kept alive by the returned
			// readable stream; destroy() only tears down the controller-owned
			// process when it is still active.
			filterController.destroy();
		}
	}

	private async applyMiddleware(track: Track): Promise<void> {
		for (const middleware of this.middleware) {
			const result = await middleware(track, this.context);
			if (result && result !== track) Object.assign(track, result);
		}
	}
}
