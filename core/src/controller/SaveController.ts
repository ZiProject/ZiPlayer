import { Readable } from "stream";
import type { AudioFilter, SaveOptions, SaveVideoOptions, Track, TrackMiddleware, TrackMiddlewareContext } from "../types";
import { FilterEngine } from "./FilterController";
import type { Bus } from "../structures/Bus";
import { PLAYER_RPC } from "../structures/BusContract";
import type { SaveControllerOptions } from "../types";

interface SaveState {
	lifecycleAbort: AbortController;
	disposed: boolean;
	activeFilterEngines: Set<FilterEngine>;
	middleware: TrackMiddleware[];
	context: TrackMiddlewareContext;
	resolveStream: SaveControllerOptions["resolveStream"];
	resolveVideoStream: SaveControllerOptions["resolveVideoStream"];
	ffmpegPath?: string | null;
	debug: NonNullable<SaveControllerOptions["debug"]>;
}

/** Shared non-playback export pipeline with active operations tracked per playerId. */
export class SaveController {
	public readonly states = new Map<string, SaveState>();

	public constructor(private readonly bus: Bus) {
		bus.registerRpc<{ track: Track; options?: SaveOptions | string }, Readable>(
			PLAYER_RPC.save,
			({ track, options }, context) => {
				const state = this.states.get(context.playerId);
				if (!state) throw new Error("SaveController is disposed");
				return this.save(state, track, options, context.signal);
			},
		);
		bus.registerRpc<{ track: Track; options?: SaveVideoOptions | string }, Readable>(
			PLAYER_RPC.saveVideo,
			({ track, options }, context) => {
				const state = this.states.get(context.playerId);
				if (!state) throw new Error("SaveController is disposed");
				return this.saveVideo(state, track, options, context.signal);
			},
		);
	}

	attach(playerId: string, options: Omit<SaveControllerOptions, "bus">): void {
		this.detach(playerId);
		this.states.set(playerId, {
			lifecycleAbort: new AbortController(),
			disposed: false,
			activeFilterEngines: new Set(),
			middleware: [...(options.middleware ?? [])],
			context: options.middlewareContext,
			resolveStream: options.resolveStream,
			resolveVideoStream: options.resolveVideoStream,
			ffmpegPath: options.ffmpegPath,
			debug: options.debug ?? (() => undefined),
		});
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.disposed = true;
		state.lifecycleAbort.abort();
		for (const controller of state.activeFilterEngines) controller.destroy();
		state.activeFilterEngines.clear();
	}

	private async save(state: SaveState, track: Track, options?: SaveOptions | string, signal?: AbortSignal): Promise<Readable> {
		this.assertActive(state);
		if (!track) throw new TypeError("A track is required to save audio");

		const saveOptions: SaveOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		const operationSignal = signal ?? saveOptions.signal;
		state.debug(`[SaveController] save called for track: ${track.title}`);

		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(state, exportTrack, operationSignal);
		const streamInfo = await this.resolveWithTimeout(
			state,
			() => state.resolveStream(exportTrack),
			saveOptions.timeout,
			operationSignal,
		);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		state.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			state.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
		}

		if (!saveOptions.filter?.length && (!saveOptions.seek || saveOptions.seek <= 0)) {
			return this.decorateStream(this.bindAbortToStream(streamInfo.stream, operationSignal), saveOptions);
		}

		const filterController = new FilterEngine({ refreshPlayerResource: async () => true }, state.debug, undefined, {
			ffmpegPath: state.ffmpegPath,
		});
		state.activeFilterEngines.add(filterController);
		const cleanupAbort = this.bindAbortToFilter(state, filterController, operationSignal);

		try {
			this.throwIfAborted(state, operationSignal);
			const filters: AudioFilter[] = saveOptions.filter ?? [];
			if (filters.length) await filterController.applyFilters(filters);
			this.throwIfAborted(state, operationSignal);
			const seek = typeof saveOptions.seek === "number" && saveOptions.seek >= 0 ? saveOptions.seek : -1;
			state.debug(`[SaveController] Applying filters to save stream: ${filterController.getFilterString() || "none"}`);

			const output = (await filterController.applyFiltersAndSeek(streamInfo, seek)).stream!;
			this.throwIfAborted(state, operationSignal);
			this.disposeFilterOnStreamEnd(state, filterController, output);
			cleanupAbort();
			return this.decorateStream(this.bindAbortToStream(output, operationSignal), saveOptions);
		} catch (error) {
			cleanupAbort();
			state.activeFilterEngines.delete(filterController);
			filterController.destroy();
			throw error;
		}
	}

	private async saveVideo(
		state: SaveState,
		track: Track,
		options?: SaveVideoOptions | string,
		signal?: AbortSignal,
	): Promise<Readable> {
		this.assertActive(state);
		if (!track) throw new TypeError("A track is required to save video");

		const saveOptions: SaveVideoOptions = typeof options === "string" ? { filename: options } : (options ?? {});
		const operationSignal = signal ?? saveOptions.signal;
		state.debug(`[SaveController] save called for track: ${track.title}`);
		const exportTrack = this.prepareExportTrack(track, saveOptions);
		await this.applyMiddleware(state, exportTrack, operationSignal);
		const streamInfo = await this.resolveWithTimeout(
			state,
			() => state.resolveVideoStream(exportTrack),
			saveOptions.timeout,
			operationSignal,
		);
		if (!streamInfo?.stream) throw new Error(`No save stream available for track: ${track.title}`);

		state.debug(`[SaveController] Save stream obtained for track: ${track.title}`);
		if (saveOptions.filename) {
			state.debug(`[SaveController] filename=${saveOptions.filename}, quality=${saveOptions.quality ?? "default"}`);
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

	private async resolveWithTimeout<T>(
		state: SaveState,
		resolve: () => Promise<T>,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<T> {
		this.throwIfAborted(state, signal);
		let timer: ReturnType<typeof setTimeout> | null = null;
		const operationSignal = signal ? AbortSignal.any([signal, state.lifecycleAbort.signal]) : state.lifecycleAbort.signal;
		let onAbort: (() => void) | null = null;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(this.abortError());
			if (operationSignal.aborted) {
				onAbort();
				return;
			}
			operationSignal.addEventListener("abort", onAbort, { once: true });
		});
		const timeout =
			Number.isFinite(timeoutMs) && (timeoutMs as number) > 0 ?
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs}ms`)), timeoutMs);
				})
			:	null;
		try {
			return await Promise.race(timeout ? [resolve(), timeout, aborted] : [resolve(), aborted]);
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) operationSignal.removeEventListener("abort", onAbort);
		}
	}

	private decorateStream<T extends Readable>(stream: T, options: SaveOptions): T {
		const exportStream = stream as T & { filename?: string; metadata?: Record<string, any>; quality?: SaveOptions["quality"] };
		if (options.filename) exportStream.filename = options.filename;
		if (options.metadata) exportStream.metadata = { ...options.metadata };
		if (options.quality) exportStream.quality = options.quality;
		return exportStream;
	}

	private async applyMiddleware(state: SaveState, track: Track, signal?: AbortSignal): Promise<void> {
		for (const middleware of state.middleware) {
			this.throwIfAborted(state, signal);
			const result = await middleware(track, state.context);
			this.throwIfAborted(state, signal);
			if (result && result !== track) Object.assign(track, result);
		}
	}

	private bindAbortToFilter(state: SaveState, controller: FilterEngine, signal?: AbortSignal): () => void {
		const onLifecycleAbort = () => controller.destroy();
		const onOperationAbort = () => controller.destroy();
		state.lifecycleAbort.signal.addEventListener("abort", onLifecycleAbort, { once: true });
		if (signal) signal.addEventListener("abort", onOperationAbort, { once: true });
		return () => {
			state.lifecycleAbort.signal.removeEventListener("abort", onLifecycleAbort);
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

	private disposeFilterOnStreamEnd(state: SaveState, controller: FilterEngine, stream: Readable): void {
		const cleanup = () => {
			state.activeFilterEngines.delete(controller);
			controller.destroy();
		};
		stream.once("close", cleanup);
		stream.once("end", cleanup);
		stream.once("error", cleanup);
	}

	private assertActive(state: SaveState): void {
		if (state.disposed) throw new Error("SaveController is disposed");
	}

	private throwIfAborted(state: SaveState, signal?: AbortSignal): void {
		if (state.lifecycleAbort.signal.aborted || signal?.aborted) throw this.abortError();
	}

	private abortError(): Error {
		const error = new Error("Save operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
