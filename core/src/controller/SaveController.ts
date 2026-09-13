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
import type { PlayerBusRpcContext } from "../types";
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
					({ track, options: saveOptions }, rpcContext) => this.save(track, saveOptions, rpcContext.signal),
				),
				options.bus.registerRpc<{ track: Track; options?: SaveVideoOptions | string }, Readable>(
					"save.video",
					({ track, options: saveOptions }, rpcContext) => this.saveVideo(track, saveOptions, rpcContext.signal),
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

	public async save(track: Track, options?: SaveOptions | string, signal?: AbortSignal): Promise<Readable> {
		this.assertActive();
		if (!track) throw new TypeError("A track is required to save audio");

		const saveOptions: SaveOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		const operationSignal = signal ?? saveOptions.signal;
		this.debug(`[SaveController] save called for track: ${track.title}`);

		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(exportTrack, operationSignal);

		const streamInfo = await this.resolveWithTimeout(() => this.resolveStream(exportTrack), saveOptions.timeout, operationSignal);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		this.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			this.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		if (!saveOptions.filter?.length && saveOptions.seek === undefined) {
			return this.decorateStream(this.bindAbortToStream(streamInfo.stream, operationSignal), saveOptions);
		}

		const filterController = new FilterController({ refreshPlayerResource: async () => true }, this.debug, undefined, {
			ffmpegPath: this.ffmpegPath,
		});
		this.activeFilterControllers.add(filterController);
		const cleanupAbort = this.bindAbortToFilter(filterController, operationSignal);

		try {
			this.throwIfAborted(operationSignal);
			const filters: AudioFilter[] = saveOptions.filter ?? [];
			if (filters.length) await filterController.applyFilters(filters);
			this.throwIfAborted(operationSignal);
			const seek = typeof saveOptions.seek === "number" && saveOptions.seek >= 0 ? saveOptions.seek : -1;
			this.debug(`[SaveController] Applying filters to save stream: ${filterController.getFilterString() || "none"}`);

			const output = (await filterController.applyFiltersAndSeek(streamInfo, seek)).stream!;
			this.throwIfAborted(operationSignal);
			this.disposeFilterOnStreamEnd(filterController, output);
			cleanupAbort();
			return this.decorateStream(this.bindAbortToStream(output, operationSignal), saveOptions);
		} catch (error) {
			cleanupAbort();
			this.activeFilterControllers.delete(filterController);
			filterController.destroy();
			throw error;
		}
	}

	public async saveVideo(track: Track, options?: SaveVideoOptions | string, signal?: AbortSignal): Promise<Readable> {
		this.assertActive();
		if (!track) throw new TypeError("A track is required to save video");

		const saveOptions: SaveVideoOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		const operationSignal = signal ?? saveOptions.signal;
		this.debug(`[SaveController] save called for track: ${track.title}`);

		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(exportTrack, operationSignal);

		const streamInfo = await this.resolveWithTimeout(() => this.resolveVideoStream(exportTrack), saveOptions.timeout, operationSignal);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		this.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			this.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		return this.decorateStream(this.bindAbortToStream(streamInfo.stream, operationSignal), saveOptions);
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

	private async resolveWithTimeout<T>(resolve: () => Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
		this.throwIfAborted(signal);
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout =
			Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
				? new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs}ms`)), timeoutMs);
				})
				: null;
		const abort = new Promise<never>((_, reject) => {
				const rejectIfAborted = () => reject(this.abortError());
				if (this.lifecycleAbort.signal.aborted || signal?.aborted) {
					rejectIfAborted();
					return;
				}
				const onLifecycleAbort = () => rejectIfAborted();
				const onOperationAbort = () => rejectIfAborted();
				this.lifecycleAbort.signal.addEventListener("abort", onLifecycleAbort, { once: true });
				if (signal) signal.addEventListener("abort", onOperationAbort, { once: true });
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

	private async applyMiddleware(track: Track, signal?: AbortSignal): Promise<void> {
		for (const middleware of this.middleware) {
			this.throwIfAborted(signal);
			const result = await middleware(track, this.context);
			this.throwIfAborted(signal);
			if (result && result !== track) Object.assign(track, result);
		}
	}

	private bindAbortToFilter(controller: FilterController, signal?: AbortSignal): () => void {
		const onLifecycleAbort = () => controller.destroy();
		const onOperationAbort = () => controller.destroy();
		this.lifecycleAbort.signal.addEventListener("abort", onLifecycleAbort, { once: true });
		if (signal) signal.addEventListener("abort", onOperationAbort, { once: true });
		return () => {
			this.lifecycleAbort.signal.removeEventListener("abort", onLifecycleAbort);
			if (signal) signal.removeEventListener("abort", onOperationAbort);
		};
	}

	private bindAbortToStream<T extends Readable>(stream: T, signal?: AbortSignal): T {
		if (!signal) return stream;
		const onAbort = () => stream.destroy(this.abortError());
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		stream.once("close", cleanup);
		stream.once("error", cleanup);
		stream.once("end", cleanup);
		return stream;
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

	private throwIfAborted(signal?: AbortSignal): void {
		if (this.lifecycleAbort.signal.aborted || signal?.aborted) throw this.abortError();
	}

	private abortError(): Error {
		const error = new Error("Save operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
