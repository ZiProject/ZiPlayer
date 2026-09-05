import { Readable } from "stream";
import type {
	AudioFilter,
	SaveOptions,
	SaveVideoOptions,
	StreamInfo,
	Track,
	TrackMiddleware,
	TrackMiddlewareContext,
} from "../types";
import { FilterController } from "./FilterController";

export interface SaveControllerOptions {
	middleware?: TrackMiddleware[];
	middlewareContext: TrackMiddlewareContext;
	resolveStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	resolveVideoStream: (track: Track) => Promise<StreamInfo | null | undefined>;
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
	private readonly resolveVideoStream: SaveControllerOptions["resolveVideoStream"];
	private readonly ffmpegPath?: string | null;
	private readonly debug: NonNullable<SaveControllerOptions["debug"]>;

	public constructor(options: SaveControllerOptions) {
		this.middleware = [...(options.middleware ?? [])];
		this.context = options.middlewareContext;
		this.resolveStream = options.resolveStream;
		this.resolveVideoStream = options.resolveVideoStream;
		this.ffmpegPath = options.ffmpegPath;
		this.debug = options.debug ?? (() => undefined);
	}

	public async save(track: Track, options?: SaveOptions | string): Promise<Readable> {
		if (!track) throw new TypeError("A track is required to save audio");

		const saveOptions: SaveOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		this.debug(`[SaveController] save called for track: ${track.title}`);

		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(exportTrack);

		const streamInfo = await this.resolveWithTimeout(() => this.resolveStream(exportTrack), saveOptions.timeout);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		this.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			this.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		if (!saveOptions.filter?.length && saveOptions.seek === undefined) return this.decorateStream(streamInfo.stream, saveOptions);

		// Saving must not mutate the player's active FilterController. Use an
		// isolated FFmpeg controller for this export operation.
		const filterController = new FilterController({ refreshPlayerResource: async () => true }, this.debug, undefined, {
			ffmpegPath: this.ffmpegPath,
		});

		const filters: AudioFilter[] = saveOptions.filter ?? [];
		if (filters.length) await filterController.applyFilters(filters);
		const seek = typeof saveOptions.seek === "number" && saveOptions.seek >= 0 ? saveOptions.seek : -1;
		this.debug(`[SaveController] Applying filters to save stream: ${filterController.getFilterString() || "none"}`);

		// Do not destroy filterController here: it owns the returned FFmpeg
		// process/output until that Readable closes. The controller becomes
		// unreachable after the stream finishes and its listeners clean up.
		return this.decorateStream((await filterController.applyFiltersAndSeek(streamInfo, seek)).stream!, saveOptions);
	}

	public async saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Readable> {
		if (!track) throw new TypeError("A track is required to save video");

		const saveOptions: SaveVideoOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		this.debug(`[SaveController] save called for track: ${track.title}`);

		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(exportTrack);

		const streamInfo = await this.resolveWithTimeout(() => this.resolveVideoStream(exportTrack), saveOptions.timeout);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		this.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			this.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		return this.decorateStream(streamInfo.stream, saveOptions);
	}

	private prepareExportTrack(track: Track, options: SaveOptions): Track {
		return {
			...track,
			metadata: {
				...(track.metadata ?? {}),
				...(options.metadata ?? {}),
				...(options.quality ? { saveQuality: options.quality } : {}),
			},
		};
	}

	private async resolveWithTimeout<T>(resolve: () => Promise<T>, timeoutMs?: number): Promise<T> {
		if (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0) return resolve();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs}ms`)), timeoutMs);
		});
		try {
			return await Promise.race([resolve(), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private decorateStream<T extends Readable>(stream: T, options: SaveOptions): T {
		const exportStream = stream as T & { filename?: string; metadata?: Record<string, any>; quality?: SaveOptions["quality"] };
		if (options.filename) exportStream.filename = options.filename;
		if (options.metadata) exportStream.metadata = { ...options.metadata };
		if (options.quality) exportStream.quality = options.quality;
		return exportStream;
	}

	private async applyMiddleware(track: Track): Promise<void> {
		for (const middleware of this.middleware) {
			const result = await middleware(track, this.context);
			if (result && result !== track) Object.assign(track, result);
		}
	}
}
