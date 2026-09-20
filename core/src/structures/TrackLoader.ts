import type {
	StreamInfo,
	Track,
	TrackMiddleware,
	TrackLoadResult,
	TrackLoaderContext,
	TrackLoaderOptions,
	TrackStreamResolver,
	TrackRecoveryPolicy,
	TrackAttemptQualityController,
} from "../types";
import type { PlaybackSession } from "./PlaybackSession";
import type { PreloadManager } from "./PreloadManager";
import type { Bus } from "./Bus";
import { CONTROLLER_RPC } from "../controller/ControllerBusContract";

const TRACK_LOADER_RPC = {
	load: "controller.track.load",
	loadWithRecovery: "controller.track.loadWithRecovery",
	resetRecovery: "controller.track.resetRecovery",
	getRecoveryCount: "controller.track.getRecoveryCount",
} as const;

/** Everything the loader keeps for ONE player. Lives only inside `TrackLoader.slots`. */
interface TrackLoaderSlot {
	readonly playerId: string;
	readonly middleware: TrackMiddleware[];
	readonly context: TrackLoaderContext;
	readonly resolvers: TrackStreamResolver[];
	readonly recovery: Required<TrackRecoveryPolicy>;
	readonly qualityController?: TrackAttemptQualityController;
	readonly debugLog: (message?: any, ...optionalParams: any[]) => void;
	readonly failures: Map<string, number>;
	disposed: boolean;
}

/**
 * Loads (and, on failure, recovers) the stream for a track on behalf of every player.
 *
 * Shared, singleton — created once in `ensureSharedControllers()`. Each player's
 * middleware chain, resolver list, recovery policy and failure counters live in an
 * internal `Map<playerId, TrackLoaderSlot>` (opened by `attach(playerId, ...)`, released
 * by `detach(playerId)`). Every RPC below is registered exactly once, in the constructor,
 * and routes by `ctx.playerId`.
 *
 * The only collaborator it holds is the (also shared) `PreloadManager`, used to reuse an
 * already-buffered stream before resolving a fresh one.
 */
export class TrackLoader {
	private readonly bus?: Bus;
	private readonly preloadManager?: PreloadManager;
	private readonly slots = new Map<string, TrackLoaderSlot>();
	private disposed = false;

	/** `bus` is what the per-player RPCs are registered on; `preloadManager` lets loads reuse a buffered stream. */
	public constructor(bus?: Bus, preloadManager?: PreloadManager) {
		this.bus = bus;
		this.preloadManager = preloadManager;

		if (bus) {
			const bridge = <TReq, TRes>(handler: (slot: TrackLoaderSlot, request: TReq) => TRes) => {
				return (request: TReq, context: { playerId: string }): TRes => {
					const slot = this.slots.get(context.playerId);
					if (!slot) throw new Error("No TrackLoader registered for this player");
					return handler(slot, request);
				};
			};
			bus.registerRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				CONTROLLER_RPC.playbackRecover,
				bridge((slot, { track, session }) => bus.requestRpc(slot.playerId, CONTROLLER_RPC.trackLoadWithRecovery, { track, session })),
			);
			bus.registerRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				CONTROLLER_RPC.playbackLoadFresh,
				bridge((slot, { track, session }) => bus.requestRpc(slot.playerId, CONTROLLER_RPC.trackLoad, { track, session })),
			);
			bus.registerRpc<{ track: Track }, TrackLoadResult | null>(
				CONTROLLER_RPC.playbackLoadFreshCurrent,
				bridge((slot, { track }) => {
					const session = bus.querySync(slot.playerId, "playbackSessionInternal");
					if (!session) return null;
					return bus.requestRpc(slot.playerId, CONTROLLER_RPC.trackLoad, { track, session });
				}),
			);
			bus.registerRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				TRACK_LOADER_RPC.load,
				bridge((slot, { track, session }) => this.loadSlot(slot, track, session)),
			);
			bus.registerRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				TRACK_LOADER_RPC.loadWithRecovery,
				bridge((slot, { track, session }) => this.loadWithRecoverySlot(slot, track, session)),
			);
			bus.registerRpc<{ track?: Track }, void>(
				TRACK_LOADER_RPC.resetRecovery,
				bridge((slot, { track }) => this.resetRecoverySlot(slot, track)),
			);
			bus.registerRpc<{ track: Track }, number>(
				TRACK_LOADER_RPC.getRecoveryCount,
				bridge((slot, { track }) => slot.failures.get(this.key(track)) ?? 0),
			);
			bus.registerRpc<{ track: Track }, Track>(
				"track.middleware",
				bridge((slot, { track }) => this.applyMiddlewareSlot(slot, track)),
			);
		}
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Opens a slot for `playerId`. Re-attaching replaces the previous slot. */
	public attach(playerId: string, options: TrackLoaderOptions): void {
		if (this.slots.has(playerId)) this.detach(playerId);
		this.slots.set(playerId, {
			playerId,
			middleware: [...(options.middleware ?? [])],
			context: options.context,
			resolvers: [...(options.resolvers ?? [])],
			recovery: {
				enabled: options.recovery?.enabled ?? true,
				maxRetries: Math.max(0, options.recovery?.maxRetries ?? 2),
				retryDelayMs: Math.max(0, options.recovery?.retryDelayMs ?? 900),
				reusePreloadFirst: options.recovery?.reusePreloadFirst ?? true,
				reduceQualityOnRetry: options.recovery?.reduceQualityOnRetry ?? true,
				controlledSkipThreshold: Math.max(1, options.recovery?.controlledSkipThreshold ?? 3),
			},
			qualityController: options.qualityController,
			debugLog: options.debug ?? (() => undefined),
			failures: new Map(),
			disposed: false,
		});
	}

	public detach(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		slot.disposed = true;
		slot.failures.clear();
		this.slots.delete(playerId);
	}

	/** Global shutdown: releases every player's slot. */
	public dispose(): void {
		this.disposed = true;
		for (const playerId of [...this.slots.keys()]) this.detach(playerId);
	}

	public has(playerId: string): boolean {
		return this.slots.has(playerId);
	}

	// ---------------------------------------------------------------------
	// Public API (every call names the player it acts for)
	// ---------------------------------------------------------------------

	public addResolver(playerId: string, resolver: TrackStreamResolver): () => void {
		const slot = this.requireSlot(playerId);
		slot.resolvers.push(resolver);
		return () => {
			const i = slot.resolvers.indexOf(resolver);
			if (i >= 0) slot.resolvers.splice(i, 1);
		};
	}

	public async load(playerId: string, track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		return this.loadSlot(this.requireSlot(playerId), track, session);
	}

	public async loadWithRecovery(playerId: string, track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		return this.loadWithRecoverySlot(this.requireSlot(playerId), track, session);
	}

	public async preloadNext(playerId: string): Promise<void> {
		this.requireSlot(playerId);
		await this.preloadManager?.preloadNextTrack(playerId);
	}

	public async applyMiddleware(playerId: string, track: Track): Promise<Track> {
		return this.applyMiddlewareSlot(this.requireSlot(playerId), track);
	}

	public hasPreload(playerId: string, track: Track): boolean {
		return this.preloadManager?.hasValidPreload(playerId, track) ?? false;
	}

	public cancelPreload(playerId: string): void {
		this.preloadManager?.cancelPreload(playerId);
	}

	public async cancelPreloadSafely(playerId: string): Promise<void> {
		await this.preloadManager?.safeCancelPreload(playerId);
	}

	public resetRecovery(playerId: string, track?: Track): void {
		const slot = this.slots.get(playerId);
		if (slot) this.resetRecoverySlot(slot, track);
	}

	public getRecoveryCount(playerId: string, track: Track): number {
		return this.slots.get(playerId)?.failures.get(this.key(track)) ?? 0;
	}

	public recoveryPolicy(playerId: string): Readonly<Required<TrackRecoveryPolicy>> {
		return this.requireSlot(playerId).recovery;
	}

	// ---------------------------------------------------------------------
	// Slot-level implementation
	// ---------------------------------------------------------------------

	private requireSlot(playerId: string): TrackLoaderSlot {
		if (this.disposed) throw new Error("TrackLoader is disposed");
		const slot = this.slots.get(playerId);
		if (!slot || slot.disposed) throw new Error("TrackLoader is disposed");
		return slot;
	}
	private async loadSlot(slot: TrackLoaderSlot, track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		this.assertNotDisposed(slot);
		const stream = await this.resolve(slot, track, session);
		return { track, stream, sessionId: session.id, retry: 0, usedFallback: false };
	}
	private async loadWithRecoverySlot(slot: TrackLoaderSlot, track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		this.assertNotDisposed(slot);
		this.assertActive(slot, session);
		const key = this.key(track);
		let retry = slot.failures.get(key) ?? 0;
		let lastError: unknown;
		if (slot.recovery.reusePreloadFirst && this.preloadManager) {
			const preload = this.preloadManager.takePreloaded(slot.playerId, track);
			if (preload) {
				slot.debugLog(`[TrackLoader] Using preloaded stream for: ${track.title}`);
				return {
					track,
					stream: preload.streamInfo ?? { stream: preload.stream as any, type: "arbitrary" },
					sessionId: session.id,
					retry: 0,
					usedFallback: false,
				};
			}
		}
		const attempts = slot.recovery.enabled ? slot.recovery.maxRetries + 1 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			this.assertActive(slot, session);
			try {
				const stream = await this.resolve(slot, track, session);
				slot.failures.delete(key);
				return { track, stream, sessionId: session.id, retry, usedFallback: retry > 0 };
			} catch (error) {
				lastError = error;
				if (this.isAbort(error) || !slot.recovery.enabled || attempt >= slot.recovery.maxRetries) break;
				retry++;
				slot.failures.set(key, retry);
				if (slot.recovery.reduceQualityOnRetry) this.reduceQualityForRetry(slot, track, retry);
				slot.debugLog(`[TrackLoader] Recovery attempt ${retry}/${slot.recovery.maxRetries} for ${track.title}`, error);
				if (slot.recovery.retryDelayMs > 0) await this.delay(slot.recovery.retryDelayMs, session.signal);
			}
		}
		if (retry >= slot.recovery.controlledSkipThreshold)
			slot.debugLog(`[TrackLoader] Controlled skip threshold reached for ${track.title}`);
		throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `Unable to load track: ${track.title}`));
	}
	private async applyMiddlewareSlot(slot: TrackLoaderSlot, track: Track): Promise<Track> {
		this.assertNotDisposed(slot);
		for (const middleware of slot.middleware) {
			const result = await middleware(track, slot.context);
			if (result && result !== track) Object.assign(track, result);
		}
		return track;
	}
	private resetRecoverySlot(slot: TrackLoaderSlot, track?: Track): void {
		if (track) slot.failures.delete(this.key(track));
		else slot.failures.clear();
	}
	private async resolve(slot: TrackLoaderSlot, track: Track, session: PlaybackSession): Promise<StreamInfo> {
		this.assertActive(slot, session);
		await this.applyMiddlewareSlot(slot, track);
		this.assertActive(slot, session);
		for (const resolver of slot.resolvers) {
			this.assertActive(slot, session);
			const stream = await resolver(track, session);
			if (!stream) continue;
			this.assertActive(slot, session);
			return stream;
		}
		throw new Error(`No stream resolver could load track: ${track.title}`);
	}
	private reduceQualityForRetry(slot: TrackLoaderSlot, track: Track, retry: number): void {
		if (!slot.qualityController) {
			slot.debugLog(`[TrackLoader] reduceQualityOnRetry enabled but no quality controller is configured for ${track.title}`);
			return;
		}
		if (slot.qualityController.get() === "low") return;
		slot.qualityController.set("low");
		slot.debugLog(`[TrackLoader] Reduced quality to low for recovery retry ${retry} on ${track.title}`);
	}
	private assertActive(slot: TrackLoaderSlot, session: PlaybackSession): void {
		this.assertNotDisposed(slot);
		if (!session.isActive()) throw new DOMException("Playback session is no longer active", "AbortError");
	}
	private assertNotDisposed(slot: TrackLoaderSlot): void {
		if (slot.disposed) throw new Error("TrackLoader is disposed");
	}
	private delay(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
			const timer = setTimeout(resolve, ms);
			const abort = () => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	private isAbort(error: unknown): boolean {
		return (
			(error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError")
		);
	}
	private key(track: Track): string {
		return track.id ?? track.url ?? `${track.source}:${track.title}`;
	}
}
