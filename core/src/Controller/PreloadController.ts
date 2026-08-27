import type { AudioResource } from "@discordjs/voice";
import type { Track, StreamSlot } from "../types";
import type { PlayerBus } from "../structures/PlayerBus";
import { createPlayerRequestId } from "../structures/PlayerBus";
import type { TrackLoader } from "../structures/TrackLoader";
import { PreloadManager } from "../structures/PreloadManager";

export interface PreloadControllerOptions {
	loader: TrackLoader;
	manager: PreloadManager;
	bus?: PlayerBus;
}

/** Owns preload lifecycle. Player-facing requests are routed through PlayerBus. */
export class PreloadController {
	private readonly loader: TrackLoader;
	private readonly manager: PreloadManager;
	private readonly bus?: PlayerBus;
	private readonly unsubscribe?: () => void;

	public constructor(options: PreloadControllerOptions) {
		this.loader = options.loader;
		this.manager = options.manager;
		this.bus = options.bus;
		if (this.bus) {
			this.unsubscribe = this.bus.onInput("[Player]->[Preload]:request", (event) => {
				void this.handleRequest(event);
			});
		}
	}

	public async preload(): Promise<void> {
		await this.loader.preloadNext();
		this.bus?.publish("preloadStateChanged", { requestedTrack: null, valid: false });
	}

	/** PlayerBus request entry point; keeps preload ownership inside this controller. */
	private async handleRequest(event: { type: "[Player]->[Preload]:request"; requestId: string; track: Track }): Promise<void> {
		if (this.loader.hasPreload(event.track)) {
			this.bus?.emitOutput({ type: "[Preload]->[Player]:ready", requestId: event.requestId, track: event.track });
			return;
		}

		this.bus?.emitOutput({ type: "[Preload]->[Player]:loading", requestId: event.requestId, track: event.track });
		try {
			await this.loader.preloadNext();
			const valid = this.loader.hasPreload(event.track);
			if (!valid) throw new Error(`Preload did not produce the requested track: ${event.track.title}`);
			this.bus?.emitOutput({ type: "[Preload]->[Player]:ready", requestId: event.requestId, track: event.track });
		} catch (error) {
			this.bus?.emitOutput({
				type: "[Preload]->[Player]:failed",
				requestId: event.requestId,
				track: event.track,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}

	public request(track: Track): Promise<Track> {
		if (!this.bus) return Promise.reject(new Error("PreloadController is not connected to PlayerBus"));
		return this.bus
			.request({ type: "[Player]->[Preload]:request", requestId: createPlayerRequestId(), track })
			.then((event) => event.track);
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
		this.unsubscribe?.();
		this.loader.cancelPreload();
	}
}
