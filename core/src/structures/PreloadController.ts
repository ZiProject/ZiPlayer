import type { AudioResource } from "@discordjs/voice";
import type { Track, StreamSlot } from "../types";
import type { PlayerBus } from "./PlayerBus";
import type { TrackLoader } from "./TrackLoader";
import { PreloadManager } from "./PreloadManager";

export interface PreloadControllerOptions {
	loader: TrackLoader;
	manager: PreloadManager;
	bus?: PlayerBus;
}

/**
 * Thin lifecycle boundary. TrackLoader owns acquisition; this class only
 * exposes preload lifecycle to the orchestration layer.
 */
export class PreloadController {
	private readonly loader: TrackLoader;
	private readonly manager: PreloadManager;
	private readonly bus?: PlayerBus;

	public constructor(options: PreloadControllerOptions) {
		this.loader = options.loader;
		this.manager = options.manager;
		this.bus = options.bus;
	}

	public async preload(): Promise<void> {
		await this.loader.preloadNext();
		this.bus?.publish("preloadStateChanged", { requestedTrack: null, valid: false });
	}

	public has(track: Track): boolean {
		return this.loader.hasPreload(track);
	}

	public promote(track: Track, currentSlot: StreamSlot): AudioResource | null {
		const resource = this.manager.promoteToCurrent(track, currentSlot);
		if (resource) this.bus?.publish("preloadPromoted", track);
		return resource;
	}

	public cancel(): void {
		this.loader.cancelPreload();
		this.bus?.publish("preloadCancelled");
	}

	public async cancelSafely(): Promise<void> {
		await this.loader.cancelPreloadSafely();
		this.bus?.publish("preloadCancelled");
	}

	public clear(): void {
		this.manager.clearPreloadSlot();
	}

	public dispose(): void {
		this.loader.cancelPreload();
	}
}
