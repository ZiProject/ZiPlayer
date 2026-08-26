import type { AudioResource } from "@discordjs/voice";
import type { Track } from "../types";
import type { PlayerBus } from "./PlayerBus";
import { PreloadManager } from "./PreloadManager";

export interface PreloadControllerOptions {
	manager: PreloadManager;
	bus?: PlayerBus;
}

/** Coordinates preload policy without exposing PreloadManager internals to Player. */
export class PreloadController {
	private readonly manager: PreloadManager;
	private readonly bus?: PlayerBus;

	public constructor(options: PreloadControllerOptions) {
		this.manager = options.manager;
		this.bus = options.bus;
	}

	public async preload(track?: Track): Promise<void> {
		if (track) {
			await this.manager.preloadNextTrack();
		} else {
			await this.manager.preloadNextTrack();
		}
		this.bus?.publish("preloadStateChanged", this.snapshot(track ?? null));
	}

	public has(track: Track): boolean {
		return this.manager.hasValidPreload(track);
	}

	public promote(track: Track, currentSlot: Parameters<PreloadManager["promoteToCurrent"]>[1]): AudioResource | null {
		const resource = this.manager.promoteToCurrent(track, currentSlot);
		if (resource) this.bus?.publish("preloadPromoted", track);
		return resource;
	}

	public cancel(): void {
		this.manager.cancelPreload();
		this.bus?.publish("preloadCancelled");
	}

	public async cancelSafely(): Promise<void> {
		await this.manager.safeCancelPreload();
		this.bus?.publish("preloadCancelled");
	}

	public clear(): void {
		this.manager.clearPreloadSlot();
	}

	public dispose(): void {
		this.manager.cancelPreload();
	}

	private snapshot(track: Track | null): { requestedTrack: Track | null; valid: boolean } {
		return { requestedTrack: track, valid: !!track && this.manager.hasValidPreload(track) };
	}
}
