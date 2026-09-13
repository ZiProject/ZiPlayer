import type { Track, StreamInfo, StreamSlot, PromotedPreload } from "../types";
import type { StreamManager } from "./StreamManager";
import type { PlayerBus } from "./PlayerBus";
interface PreloadManagerDeps {
	streamManager: StreamManager;
	debug: (message?: any, ...optionalParams: any[]) => void;
	bus?: PlayerBus;
	getNextTrack?: () => Track | null;
	getStream?: (track: Track) => Promise<StreamInfo | null>;
	removeTrackFromQueue?: (track: Track) => boolean;
	isDestroyed: () => boolean;
	isEnabled: () => boolean;
}
export class PreloadManager {
	private readonly streamManager: StreamManager;
	private readonly debugLog: (message?: any, ...optionalParams: any[]) => void;
	private readonly bus?: PlayerBus;
	private readonly getNextTrackFallback?: () => Track | null;
	private readonly getStreamFallback?: (track: Track) => Promise<StreamInfo | null>;
	private readonly removeTrackFromQueue?: (track: Track) => boolean;
	private readonly isDestroyed: () => boolean;
	private readonly isEnabled: () => boolean;
	private preloadLock = false;
	private preloadNext = false;
	private readonly preloadSlot: StreamSlot = {
		streamInfo: null,
		track: null,
		streamId: null,
		processedStreamId: null,
		abortController: null,
		isValid: false,
		isLoading: false,
		loadPromise: null,
	};
	constructor(deps: PreloadManagerDeps) {
		this.streamManager = deps.streamManager;
		this.debugLog = deps.debug;
		this.bus = deps.bus;
		this.getNextTrackFallback = deps.getNextTrack;
		this.getStreamFallback = deps.getStream;
		this.removeTrackFromQueue = deps.removeTrackFromQueue;
		this.isDestroyed = deps.isDestroyed;
		this.isEnabled = deps.isEnabled;
	}
	private getNextTrack(): Track | null {
		if (this.bus)
			return this.bus.querySync("queueLoop") === "track" ?
					this.bus.querySync("queueCurrent")
				:	this.bus.querySync("queueNextTrack");
		return this.getNextTrackFallback?.() ?? null;
	}
	private getStream(track: Track): Promise<StreamInfo | null> {
		if (this.bus) return this.bus.requestRpc("stream.resolve", { track });
		return this.getStreamFallback?.(track) ?? Promise.resolve(null);
	}
	private removeTrack(track: Track): boolean {
		if (this.bus) {
			const next = this.bus.querySync("queueNextTrack");
			const same =
				next === track ||
				(next?.id !== undefined && track.id !== undefined && next.id === track.id) ||
				(next?.url !== undefined && track.url !== undefined && next.url === track.url);
			return same ? this.bus.requestRpcSync("queue.remove", { index: 0 }) !== null : false;
		}
		return this.removeTrackFromQueue?.(track) ?? false;
	}
	private trackMatches(a: Track | null, b: Track | null): boolean {
		if (!a || !b) return false;
		if (a === b) return true;
		if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
		return a.url === b.url && a.url !== undefined;
	}
	public hasValidPreload(track: Track): boolean {
		const stream = this.preloadSlot.streamInfo?.stream;
		const isStreamAlive = !stream || (!stream.destroyed && (stream as any).readable !== false);
		return !!(
			this.preloadSlot.isValid &&
			this.trackMatches(this.preloadSlot.track, track) &&
			this.preloadSlot.streamInfo &&
			isStreamAlive
		);
	}
	public takePreloaded(track: Track): PromotedPreload | null {
		if (!this.hasValidPreload(track)) return null;
		const streamInfo = this.preloadSlot.streamInfo;
		if (!streamInfo) return null;
		const stream = (streamInfo.stream ?? null) as NodeJS.ReadableStream;
		const streamId = this.preloadSlot.streamId;
		// Transfer ownership to active playback without unregistering from StreamManager
		this.debugLog(`[Preload] Promoting preloaded track: ${track.title} (Stream ID: ${streamId ?? "none"})`);
		this.preloadSlot.streamInfo = null;
		this.preloadSlot.track = null;
		this.preloadSlot.streamId = null;
		this.preloadSlot.abortController = null;
		this.preloadSlot.isValid = false;
		this.preloadSlot.isLoading = false;
		this.preloadSlot.loadPromise = null;
		return { track, stream, streamInfo, streamId };
	}
	public async preloadNextTrack(): Promise<void> {
		if (this.isDestroyed()) return;
		if (!this.isEnabled()) {
			this.debugLog(`[Preload] Disabled by options/runtime profile`);
			return;
		}
		if (this.preloadLock) {
			this.debugLog(`[Preload] Already preloading, skipping`);
			return;
		}
		const nextTrack = this.getNextTrack();
		if (!nextTrack) {
			this.debugLog(`[Preload] No next track to preload`);
			return;
		}
		if (this.hasValidPreload(nextTrack)) {
			this.debugLog(`[Preload] Already have valid preload for: ${nextTrack.title}`);
			return;
		}
		if (this.preloadSlot.isLoading && this.trackMatches(this.preloadSlot.track, nextTrack)) {
			if (this.preloadSlot.loadPromise) await this.preloadSlot.loadPromise;
			return;
		}
		if (this.preloadSlot.isValid && !this.trackMatches(this.preloadSlot.track, nextTrack)) await this.safeCancelPreload();
		this.preloadLock = true;
		this.preloadNext = false;
		const abortController = new AbortController();
		this.preloadSlot.track = nextTrack;
		this.preloadSlot.abortController = abortController;
		this.preloadSlot.isLoading = true;
		const loadPromise = this.executePreload(nextTrack, abortController);
		this.preloadSlot.loadPromise = loadPromise;
		try {
			await loadPromise;
		} catch (err) {
			if (err instanceof Error && err.message === "PRELOAD_CANCELLED")
				this.debugLog(`[Preload] Cancelled for ${nextTrack.title}`);
			else if (err instanceof Error && err.message === "No stream available") {
				this.debugLog(`[Preload] Skipped unplayable track: ${nextTrack.title}`);
				this.clearPreloadSlot();
				this.preloadNext = true;
			} else {
				this.debugLog(`[Preload] Failed for ${nextTrack.title}:`, err);
				this.clearPreloadSlot();
			}
		} finally {
			this.preloadLock = false;
			this.preloadSlot.isLoading = false;
			this.preloadSlot.loadPromise = null;
		}
		if (this.preloadNext && !this.isDestroyed() && this.isEnabled()) await this.preloadNextTrack();
	}
	public async safeCancelPreload(): Promise<void> {
		if (!this.preloadSlot.abortController && !this.preloadSlot.streamInfo && !this.preloadSlot.streamId) return;
		this.debugLog(`[Preload] Safely cancelling preload for: ${this.preloadSlot.track?.title || "unknown"}`);
		this.preloadSlot.abortController?.abort();
		this.preloadSlot.abortController = null;
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		if (this.preloadSlot.streamInfo) {
			this.destroyStreamInfo(this.preloadSlot.streamInfo);
		}
		this.clearPreloadSlot();
	}
	public cancelPreload(): void {
		this.preloadSlot.abortController?.abort();
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		this.clearPreloadSlot();
	}
	public clearPreloadSlot(): void {
		if (this.preloadSlot.streamInfo) {
			this.destroyStreamInfo(this.preloadSlot.streamInfo);
		}
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		this.preloadSlot.streamInfo = null;
		this.preloadSlot.track = null;
		this.preloadSlot.streamId = null;
		this.preloadSlot.abortController = null;
		this.preloadSlot.isValid = false;
		this.preloadSlot.isLoading = false;
		this.preloadSlot.loadPromise = null;
	}
	/**
	 * Full teardown hook so PlayerRuntimeController's generic `.dispose()`/`.destroy()`
	 * duck-typed resolver can find and call this. Without a method matching that
	 * exact name, any in-flight or already-buffered preloaded track (a whole
	 * AudioResource + its underlying ffmpeg/yt-dlp Readable stream) is never
	 * destroyed when the player is destroyed, leaking that memory indefinitely.
	 */
	public dispose(): void {
		this.cancelPreload();
		this.clearPreloadSlot();
	}
	private async executePreload(track: Track, abortController: AbortController): Promise<void> {
		if (this.isDestroyed()) throw new Error("PLAYER_DESTROYED");
		this.debugLog(`[Preload] Starting preload for: ${track.title}`);
		if (abortController.signal.aborted || !this.trackMatches(this.getNextTrack(), track)) throw new Error("PRELOAD_CANCELLED");
		const streamInfo = await this.getStreamWithCancel(track, abortController.signal);
		if (abortController.signal.aborted || this.isDestroyed()) {
			this.destroyStreamInfo(streamInfo);
			throw new Error("PRELOAD_CANCELLED");
		}
		if (!this.trackMatches(this.getNextTrack(), track)) {
			this.destroyStreamInfo(streamInfo);
			throw new Error("PRELOAD_CANCELLED");
		}
		if (!streamInfo?.stream && !streamInfo?.url && !streamInfo?.recreate) {
			if (this.removeTrack(track)) this.debugLog(`[Preload] Removed unplayable track from queue: ${track.title}`);
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
			streamId = this.streamManager.registerStream(streamInfo.stream, track, {
				source: track.source || "preload",
				isPreload: true,
				priority: 5,
			});
		}
		this.preloadSlot.streamId = streamId;

		if (abortController.signal.aborted || this.isDestroyed()) {
			this.destroyStreamInfo(streamInfo);
			if (streamId) this.streamManager.unregisterStream(streamId, true);
			throw new Error("PRELOAD_CANCELLED");
		}

		if (streamInfo.stream && (streamInfo.stream.destroyed || (streamInfo.stream as any).readable === false)) {
			if (streamId) this.streamManager.unregisterStream(streamId, true);
			this.preloadSlot.streamId = null;
			throw new Error("Resource not readable");
		}

		this.preloadSlot.streamInfo = streamInfo;
		this.preloadSlot.isValid = true;
		this.preloadSlot.track = track;
		this.debugLog(`[Preload] Successfully preloaded: ${track.title} (Stream ID: ${streamId})`);
	}
	private destroyStreamInfo(streamInfo: StreamInfo | null): void {
		const stream = streamInfo?.stream;
		if (!stream) return;
		try {
			if (typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
		} catch (error) {
			this.debugLog(`[Preload] Error destroying abandoned stream:`, error);
		}
	}
	private async getStreamWithCancel(track: Track, signal: AbortSignal): Promise<StreamInfo | null> {
		if (this.isDestroyed()) throw new Error("PLAYER_DESTROYED");
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
		const existingStream = this.streamManager.getStreamByTrack(track.id || track.title);
		if (existingStream && !existingStream.destroyed && existingStream.readable !== false) {
			if (abortHandler) signal.removeEventListener("abort", abortHandler);
			return { stream: existingStream, type: "arbitrary" };
		}
		const streamPromise = this.getStream(track);
		void streamPromise.then(
			(result) => {
				if (signal.aborted || this.isDestroyed()) this.destroyStreamInfo(result);
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
