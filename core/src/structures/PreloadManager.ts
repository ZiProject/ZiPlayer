import { createAudioResource, AudioResource } from "@discordjs/voice";
import type { Track, StreamInfo, StreamSlot } from "../types";
import type { StreamManager } from "./StreamManager";
interface PreloadManagerDeps {
	streamManager: StreamManager;
	debug: (message?: any, ...optionalParams: any[]) => void;
	getNextTrack: () => Track | null;
	getStream: (track: Track) => Promise<StreamInfo | null>;
	removeTrackFromQueue?: (track: Track) => boolean;
	isDestroyed: () => boolean;
	isEnabled: () => boolean;
}
export interface PromotedPreload {
	track: Track;
	stream: NodeJS.ReadableStream;
	streamId: string | null;
}
export class PreloadManager {
	private readonly streamManager: StreamManager;
	private readonly debugLog: (message?: any, ...optionalParams: any[]) => void;
	private readonly getNextTrack: () => Track | null;
	private readonly getStream: (track: Track) => Promise<StreamInfo | null>;
	private readonly removeTrackFromQueue?: (track: Track) => boolean;
	private readonly isDestroyed: () => boolean;
	private readonly isEnabled: () => boolean;
	private preloadLock = false;
	private preloadNext = false;
	private readonly preloadSlot: StreamSlot = {
		resource: null,
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
		this.getNextTrack = deps.getNextTrack;
		this.getStream = deps.getStream;
		this.removeTrackFromQueue = deps.removeTrackFromQueue;
		this.isDestroyed = deps.isDestroyed;
		this.isEnabled = deps.isEnabled;
	}
	private trackMatches(a: Track | null, b: Track | null): boolean {
		if (!a || !b) return false;
		if (a === b) return true;
		if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
		return a.url === b.url && a.url !== undefined;
	}
	public hasValidPreload(track: Track): boolean {
		return !!(
			this.preloadSlot.isValid &&
			this.trackMatches(this.preloadSlot.track, track) &&
			this.preloadSlot.resource &&
			this.preloadSlot.resource.playStream?.readable !== false
		);
	}
	public takePreloaded(track: Track): PromotedPreload | null {
		if (!this.hasValidPreload(track)) return null;
		const resource = this.preloadSlot.resource;
		if (!resource?.playStream) return null;
		const stream = resource.playStream;
		const streamId = this.preloadSlot.streamId;
		if (streamId) this.streamManager.unregisterStream(streamId, false);
		this.debugLog(`[Preload] Promoting preloaded track: ${track.title} (Stream ID: ${streamId ?? "none"})`);
		this.preloadSlot.resource = null;
		this.preloadSlot.track = null;
		this.preloadSlot.streamId = null;
		this.preloadSlot.abortController = null;
		this.preloadSlot.isValid = false;
		this.preloadSlot.isLoading = false;
		this.preloadSlot.loadPromise = null;
		return { track, stream, streamId };
	}
	public promoteToCurrent(track: Track, currentSlot: StreamSlot): AudioResource | null {
		const promoted = this.takePreloaded(track);
		if (!promoted) return null;
		currentSlot.resource = createAudioResource(promoted.stream as any, {
			inlineVolume: true,
			metadata: { ...track, preloaded: true },
		});
		currentSlot.resource.volume?.setVolume(0);
		currentSlot.track = track;
		currentSlot.streamId = promoted.streamId;
		currentSlot.abortController = null;
		currentSlot.isValid = true;
		currentSlot.isLoading = false;
		currentSlot.loadPromise = null;
		return currentSlot.resource;
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
		if (!this.preloadSlot.abortController && !this.preloadSlot.resource && !this.preloadSlot.streamId) return;
		this.debugLog(`[Preload] Safely cancelling preload for: ${this.preloadSlot.track?.title || "unknown"}`);
		this.preloadSlot.abortController?.abort();
		this.preloadSlot.abortController = null;
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		if (this.preloadSlot.resource) {
			try {
				const stream = this.preloadSlot.resource.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
			} catch {}
		}
		this.clearPreloadSlot();
	}
	public cancelPreload(): void {
		this.preloadSlot.abortController?.abort();
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		this.clearPreloadSlot();
	}
	public clearPreloadSlot(): void {
		if (this.preloadSlot.resource) {
			try {
				const stream = this.preloadSlot.resource.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
			} catch {}
		}
		if (this.preloadSlot.streamId) this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		this.preloadSlot.resource = null;
		this.preloadSlot.track = null;
		this.preloadSlot.streamId = null;
		this.preloadSlot.abortController = null;
		this.preloadSlot.isValid = false;
		this.preloadSlot.isLoading = false;
		this.preloadSlot.loadPromise = null;
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
		if (!streamInfo?.stream && !streamInfo?.url) {
			if (this.removeTrackFromQueue?.(track)) this.debugLog(`[Preload] Removed unplayable track from queue: ${track.title}`);
			throw new Error("No stream available");
		}
		const streamId =
			streamInfo.stream ?
				this.streamManager.registerStream(streamInfo.stream, track, {
					source: track.source || "preload",
					isPreload: true,
					priority: 5,
				})
			:	null;
		this.preloadSlot.streamId = streamId;
		try {
			const resource = createAudioResource(streamInfo.stream || streamInfo.url!, {
				inlineVolume: true,
				metadata: { ...track, preloaded: true },
			});
			resource.volume?.setVolume(0);
			if (abortController.signal.aborted || this.isDestroyed()) {
				try {
					resource.playStream?.destroy?.();
				} catch {}
				throw new Error("PRELOAD_CANCELLED");
			}
			if (!resource.playStream || resource.playStream.readable === false) throw new Error("Resource not readable");
			this.preloadSlot.resource = resource;
			this.preloadSlot.isValid = true;
			this.preloadSlot.track = track;
			this.debugLog(`[Preload] Successfully preloaded: ${track.title} (Stream ID: ${streamId})`);
		} catch (error) {
			if (streamId) this.streamManager.unregisterStream(streamId, true);
			this.preloadSlot.streamId = null;
			throw error;
		}
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
