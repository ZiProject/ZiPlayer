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
import type { PlayerBus } from "../structures/PlayerBus";
import type { SaveControllerOptions } from "../types";

/**
 * Owns the non-playback stream export pipeline.
 *
 * Save deliberately resolves a fresh provider stream instead of reusing the
 * active playback/preload stream. This keeps saving isolated from playback.
 */
export class SaveController {
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	private readonly activeFilterControllers = new Set<FilterController>();
	private readonly middleware: TrackMiddleware[];
	private readonly context: TrackMiddlewareContext;
	private readonly resolveStream: SaveControllerOptions["resolveStream"];
	private readonly resolveVideoStream: SaveControllerOptions["resolveVideoStream"];
	private readonly ffmpegPath?: string | null;
	private readonly debug: NonNullable<SaveControllerOptions["debug"]>;
	private readonly detachRpcs: Array<() => void> = [];

	public constructor(options: SaveControllerOptions) {
		this.middleware = [...(options.middleware ?? [])];
		this.context = options.middlewareContext;
		this.resolveStream = options.resolveStream;
		this.resolveVideoStream = options.resolveVideoStream;
		this.ffmpegPath = options.ffmpegPath;
		this.debug = options.debug ?? (() => undefined);
		if (options.bus) {
			this.detachRpcs.push(
				options.bus.registerRpc<{ track: Track; options?: SaveOptions | string }, Readable>(
					"save",
					({ track, options: saveOptions }) => this.save(track, saveOptions),
				),
				options.bus.registerRpc<{ track: Track; options?: SaveVideoOptions | string }, Readable>(
					"save.video",
					({ track, options: saveOptions }) => this.saveVideo(track, saveOptions),
				),
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		for (const controller of this.activeFilterControllers) controller.destroy();
		this.activeFilterControllers.clear();
		for (const detach of this.detachRpcs.splice(0)) detach();
	}

	public async save(track: Track, options?: SaveOptions | string): Promise<Readable> {
		this.assertActive();
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
		this.activeFilterControllers.add(filterController);
		this.lifecycleAbort.signal.addEventListener("abort", () => filterController.destroy(), { once: true });

		try {
			const filters: AudioFilter[] = saveOptions.filter ?? [];
			if (filters.length) await filterController.applyFilters(filters);
			const seek = typeof saveOptions.seek === "number" && saveOptions.seek >= 0 ? saveOptions.seek : -1;
			this.debug(`[SaveController] Applying filters to save stream: ${filterController.getFilterString() || "none"}`);

			const output = (await filterController.applyFiltersAndSeek(streamInfo, seek)).stream!;
			this.disposeFilterOnStreamEnd(filterController, output);
			return this.decorateStream(output, saveOptions);
		} catch (error) {
			this.activeFilterControllers.delete(filterController);
			filterController.destroy();
			throw error;
		}
	}

	public async saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Readable> {
		this.assertActive();
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
		this.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout =
			Number.isFinite(timeoutMs) && (timeoutMs as number) > 0 ?
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs}ms`)), timeoutMs);
				})
			:	null;
		const abort = new Promise<never>((_, reject) => {
			if (this.lifecycleAbort.signal.aborted) reject(this.abortError());
			this.lifecycleAbort.signal.addEventListener("abort", () => reject(this.abortError()), { once: true });
		});
		try {
			return await Promise.race(timeout ? [resolve(), timeout, abort] : [resolve(), abort]);
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
			this.throwIfAborted();
			const result = await middleware(track, this.context);
			this.throwIfAborted();
			if (result && result !== track) Object.assign(track, result);
		}
	}

	private disposeFilterOnStreamEnd(controller: FilterController, stream: Readable): void {
		const cleanup = () => {
			this.activeFilterControllers.delete(controller);
			controller.destroy();
		};
		stream.once("close", cleanup);
		stream.once("end", cleanup);
		stream.once("error", cleanup);
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("SaveController is disposed");
	}

	private throwIfAborted(): void {
		if (this.lifecycleAbort.signal.aborted) throw this.abortError();
	}

	private abortError(): Error {
		const error = new Error("Save operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
