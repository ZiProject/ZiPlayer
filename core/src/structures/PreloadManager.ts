import type { Track, StreamInfo, StreamSlot, PromotedPreload } from "../types";
import type { StreamManager } from "./StreamManager";
import type { Bus } from "./Bus";

/** Per-player resources handed to the shared `PreloadManager` via `attach(playerId, deps)`. */
export interface PreloadManagerDeps {
	streamManager: StreamManager;
	debug: (message?: any, ...optionalParams: any[]) => void;
	isDestroyed: () => boolean;
	isEnabled: () => boolean;
	/** Optional overrides for standalone/unit-test use. By default everything goes through the Bus. */
	getNextTrack?: () => Track | null;
	getStream?: (track: Track) => Promise<StreamInfo | null>;
	removeTrackFromQueue?: (track: Track) => boolean;
}

/** Everything the manager keeps for ONE player. Lives only inside `PreloadManager.slots`. */
interface PreloadPlayerSlot {
	readonly playerId: string;
	readonly deps: PreloadManagerDeps;
	preloadLock: boolean;
	preloadNext: boolean;
	readonly preloadSlot: StreamSlot;
}

const newStreamSlot = (): StreamSlot => ({
	streamInfo: null,
	track: null,
	streamId: null,
	processedStreamId: null,
	abortController: null,
	isValid: false,
	isLoading: false,
	loadPromise: null,
});

/**
 * Owns every player's single "next track" preload slot.
 *
 * Shared, singleton — created once in `ensureSharedControllers()`. Each player's slot,
 * lock flags and StreamManager reference live in an internal `Map<playerId, ...>`,
 * opened by `attach(playerId, deps)` and released by `detach(playerId)`.
 */
export class PreloadManager {
	private readonly bus?: Bus;
	private readonly slots = new Map<string, PreloadPlayerSlot>();

	/** `bus` is only needed by players that attach without `getNextTrack`/`getStream`/`removeTrackFromQueue` deps. */
	public constructor(bus?: Bus) {
		this.bus = bus;
	}

	public attach(playerId: string, deps: PreloadManagerDeps): void {
		if (this.slots.has(playerId)) this.detach(playerId);
		this.slots.set(playerId, { playerId, deps, preloadLock: false, preloadNext: false, preloadSlot: newStreamSlot() });
	}

	/** Cancels any in-flight preload, destroys the buffered stream and forgets `playerId`. */
	public detach(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		this.cancelPreload(playerId);
		this.clearPreloadSlot(playerId);
		this.slots.delete(playerId);
	}

	/** Global shutdown: releases every player's slot. */
	public dispose(): void {
		for (const playerId of [...this.slots.keys()]) this.detach(playerId);
	}

	public has(playerId: string): boolean {
		return this.slots.has(playerId);
	}

	public slotState(playerId: string): StreamSlot {
		return this.slots.get(playerId)?.preloadSlot ?? newStreamSlot();
	}

	// ---------------------------------------------------------------------
	// Bus / fallback plumbing
	// ---------------------------------------------------------------------

	private getNextTrack(slot: PreloadPlayerSlot): Track | null {
		if (slot.deps.getNextTrack) return slot.deps.getNextTrack() ?? null;
		if (!this.bus) return null;
		return this.bus.querySync(slot.playerId, "queueLoop") === "track" ?
				this.bus.querySync(slot.playerId, "queueCurrent")
			:	this.bus.querySync(slot.playerId, "queueNextTrack");
	}
	private getStream(slot: PreloadPlayerSlot, track: Track): Promise<StreamInfo | null> {
		if (slot.deps.getStream) return slot.deps.getStream(track);
		if (!this.bus) return Promise.resolve(null);
		return this.bus.requestRpc(slot.playerId, "stream.resolve", { track });
	}
	private removeTrack(slot: PreloadPlayerSlot, track: Track): boolean {
		if (slot.deps.removeTrackFromQueue) return slot.deps.removeTrackFromQueue(track);
		if (!this.bus) return false;
		const next = this.bus.querySync(slot.playerId, "queueNextTrack");
		const same =
			next === track ||
			(next?.id !== undefined && track.id !== undefined && next.id === track.id) ||
			(next?.url !== undefined && track.url !== undefined && next.url === track.url);
		return same ? this.bus.requestRpcSync(slot.playerId, "queue.remove", { index: 0 }) !== null : false;
	}
	private trackMatches(a: Track | null, b: Track | null): boolean {
		if (!a || !b) return false;
		if (a === b) return true;
		if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
		return a.url === b.url && a.url !== undefined;
	}

	// ---------------------------------------------------------------------
	// Preload operations (all keyed by playerId)
	// ---------------------------------------------------------------------

	public hasValidPreload(playerId: string, track: Track): boolean {
		const slot = this.slots.get(playerId);
		return slot ? this.slotHasValidPreload(slot, track) : false;
	}
	private slotHasValidPreload(slot: PreloadPlayerSlot, track: Track): boolean {
		const stream = slot.preloadSlot.streamInfo?.stream;
		const isStreamAlive = !stream || (!stream.destroyed && (stream as any).readable !== false);
		return !!(
			slot.preloadSlot.isValid &&
			this.trackMatches(slot.preloadSlot.track, track) &&
			slot.preloadSlot.streamInfo &&
			isStreamAlive
		);
	}
	public takePreloaded(playerId: string, track: Track): PromotedPreload | null {
		if (!track) return null;
		const slot = this.slots.get(playerId);
		if (!slot || !this.slotHasValidPreload(slot, track)) return null;
		const preloadSlot = slot.preloadSlot;
		const streamInfo = preloadSlot.streamInfo;
		if (!streamInfo) return null;
		const stream = (streamInfo.stream ?? null) as NodeJS.ReadableStream;
		const streamId = preloadSlot.streamId;
		// Transfer ownership to active playback without unregistering from StreamManager
		slot.deps.debug(`[Preload] Promoting preloaded track: ${track.title} (Stream ID: ${streamId ?? "none"})`);
		preloadSlot.streamInfo = null;
		preloadSlot.track = null;
		preloadSlot.streamId = null;
		preloadSlot.abortController = null;
		preloadSlot.isValid = false;
		preloadSlot.isLoading = false;
		preloadSlot.loadPromise = null;
		return { track, stream, streamInfo, streamId };
	}
	public async preloadNextTrack(id: string): Promise<void> {
		const slot = this.slots.get(id);
		if (!slot) return;
		const { debug, isDestroyed, isEnabled } = slot.deps;
		const preloadSlot = slot.preloadSlot;
		if (isDestroyed()) return;
		if (!isEnabled()) {
			debug(`[Preload] Disabled by options/runtime profile`);
			return;
		}
		if (slot.preloadLock) {
			debug(`[Preload] Already preloading, skipping`);
			return;
		}
		const nextTrack = this.getNextTrack(slot);
		if (!nextTrack) {
			debug(`[Preload] No next track to preload`);
			return;
		}
		if (this.slotHasValidPreload(slot, nextTrack)) {
			debug(`[Preload] Already have valid preload for: ${nextTrack.title}`);
			return;
		}
		if (preloadSlot.isLoading && this.trackMatches(preloadSlot.track, nextTrack)) {
			if (preloadSlot.loadPromise) await preloadSlot.loadPromise;
			return;
		}
		if (preloadSlot.isValid && !this.trackMatches(preloadSlot.track, nextTrack)) await this.safeCancelPreload(id);
		slot.preloadLock = true;
		slot.preloadNext = false;
		const abortController = new AbortController();
		preloadSlot.track = nextTrack;
		preloadSlot.abortController = abortController;
		preloadSlot.isLoading = true;
		const loadPromise = this.executePreload(slot, nextTrack, abortController);
		preloadSlot.loadPromise = loadPromise;
		try {
			await loadPromise;
		} catch (err) {
			if (err instanceof Error && err.message === "PRELOAD_CANCELLED") debug(`[Preload] Cancelled for ${nextTrack.title}`);
			else if (err instanceof Error && err.message === "No stream available") {
				debug(`[Preload] Skipped unplayable track: ${nextTrack.title}`);
				this.clearPreloadSlot(id);
				slot.preloadNext = true;
			} else {
				debug(`[Preload] Failed for ${nextTrack.title}:`, err);
				this.clearPreloadSlot(id);
			}
		} finally {
			slot.preloadLock = false;
			preloadSlot.isLoading = false;
			preloadSlot.loadPromise = null;
		}
		if (slot.preloadNext && !isDestroyed() && isEnabled()) await this.preloadNextTrack(slot.playerId);
	}
	public async safeCancelPreload(id: string): Promise<void> {
		const slot = this.slots.get(id);
		if (!slot) return;
		const preloadSlot = slot.preloadSlot;
		if (!preloadSlot.abortController && !preloadSlot.streamInfo && !preloadSlot.streamId) return;
		slot.deps.debug(`[Preload] Safely cancelling preload for: ${preloadSlot.track?.title || "unknown"}`);
		preloadSlot.abortController?.abort();
		preloadSlot.abortController = null;
		if (preloadSlot.streamId) slot.deps.streamManager.unregisterStream(preloadSlot.streamId, true);
		if (preloadSlot.streamInfo) {
			this.destroyStreamInfo(slot, preloadSlot.streamInfo);
		}
		this.clearPreloadSlot(id);
	}
	public cancelPreload(id: string): void {
		const slot = this.slots.get(id);
		if (!slot) return;
		slot.preloadSlot.abortController?.abort();
		if (slot.preloadSlot.streamId) slot.deps.streamManager.unregisterStream(slot.preloadSlot.streamId, true);
		this.clearPreloadSlot(id);
	}
	public clearPreloadSlot(id: string): void {
		const slot = this.slots.get(id);
		if (!slot) return;
		const preloadSlot = slot.preloadSlot;
		if (preloadSlot.streamInfo) {
			this.destroyStreamInfo(slot, preloadSlot.streamInfo);
		}
		if (preloadSlot.streamId) slot.deps.streamManager.unregisterStream(preloadSlot.streamId, true);
		preloadSlot.streamInfo = null;
		preloadSlot.track = null;
		preloadSlot.streamId = null;
		preloadSlot.abortController = null;
		preloadSlot.isValid = false;
		preloadSlot.isLoading = false;
		preloadSlot.loadPromise = null;
	}
	private async executePreload(slot: PreloadPlayerSlot, track: Track, abortController: AbortController): Promise<void> {
		const { debug, isDestroyed, streamManager } = slot.deps;
		const preloadSlot = slot.preloadSlot;
		if (isDestroyed()) throw new Error("PLAYER_DESTROYED");
		debug(`[Preload] Starting preload for: ${track.title}`);
		if (abortController.signal.aborted || !this.trackMatches(this.getNextTrack(slot), track))
			throw new Error("PRELOAD_CANCELLED");
		const streamInfo = await this.getStreamWithCancel(slot, track, abortController.signal);
		if (abortController.signal.aborted || isDestroyed()) {
			this.destroyStreamInfo(slot, streamInfo);
			throw new Error("PRELOAD_CANCELLED");
		}
		if (!this.trackMatches(this.getNextTrack(slot), track)) {
			this.destroyStreamInfo(slot, streamInfo);
			throw new Error("PRELOAD_CANCELLED");
		}
		if (!streamInfo?.stream && !streamInfo?.url && !streamInfo?.recreate) {
			if (this.removeTrack(slot, track)) debug(`[Preload] Removed unplayable track from queue: ${track.title}`);
			throw new Error("No stream available");
		}

		// If recreate is present without stream, pre-warm by resolving stream
		if (!streamInfo.stream && streamInfo.recreate) {
			try {
				streamInfo.stream = await streamInfo.recreate(0);
			} catch {}
		}

		let streamId: string | null = null;
		if (streamInfo.stream) {
			streamId = streamManager.registerStream(streamInfo.stream, track, {
				source: track.source || "preload",
				isPreload: true,
				priority: 5,
			});
		}
		preloadSlot.streamId = streamId;

		if (abortController.signal.aborted || isDestroyed()) {
			this.destroyStreamInfo(slot, streamInfo);
			if (streamId) streamManager.unregisterStream(streamId, true);
			throw new Error("PRELOAD_CANCELLED");
		}

		if (streamInfo.stream && (streamInfo.stream.destroyed || (streamInfo.stream as any).readable === false)) {
			if (streamId) streamManager.unregisterStream(streamId, true);
			preloadSlot.streamId = null;
			throw new Error("Resource not readable");
		}

		preloadSlot.streamInfo = streamInfo;
		preloadSlot.isValid = true;
		preloadSlot.track = track;
		debug(`[Preload] Successfully preloaded: ${track.title} (Stream ID: ${streamId})`);
	}
	private destroyStreamInfo(slot: PreloadPlayerSlot, streamInfo: StreamInfo | null): void {
		const stream = streamInfo?.stream;
		if (!stream) return;
		try {
			if (typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
		} catch (error) {
			slot.deps.debug(`[Preload] Error destroying abandoned stream:`, error);
		}
	}
	private async getStreamWithCancel(slot: PreloadPlayerSlot, track: Track, signal: AbortSignal): Promise<StreamInfo | null> {
		const { isDestroyed, streamManager } = slot.deps;
		if (isDestroyed()) throw new Error("PLAYER_DESTROYED");
		let abortHandler: (() => void) | null = null;
		let settled = false;
		const abortPromise = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(new Error("PRELOAD_CANCELLED"));
				return;
			}
			abortHandler = () => reject(new Error("PRELOAD_CANCELLED"));
			signal.addEventListener("abort", abortHandler, { once: true });
		});
		const existingStream = streamManager.getStreamByTrack(track.id || track.title);
		if (existingStream && !existingStream.destroyed && existingStream.readable !== false) {
			if (abortHandler) signal.removeEventListener("abort", abortHandler);
			return { stream: existingStream, type: "arbitrary" };
		}
		const streamPromise = this.getStream(slot, track);
		void streamPromise.then(
			(result) => {
				if (signal.aborted || isDestroyed()) this.destroyStreamInfo(slot, result);
			},
			() => undefined,
		);
		try {
			const result = await Promise.race([streamPromise, abortPromise]);
			settled = true;
			return result as StreamInfo | null;
		} finally {
			if (!settled && signal.aborted) {
			}
			if (abortHandler) signal.removeEventListener("abort", abortHandler);
		}
	}
}
