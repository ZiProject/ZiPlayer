import type { AudioResource } from "@discordjs/voice";
import type { Track, TrackLoadResult, PromotedPreload, StreamInfo } from "../types";
import type { PlayerBus } from "../structures/PlayerBus";
import { createPlayerRequestId } from "../structures/PlayerBus";
import type { TrackLoader } from "../structures/TrackLoader";
import { PreloadManager } from "../structures/PreloadManager";
import type { PreloadControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Owns preload lifecycle. Player-facing requests are routed through PlayerBus. */
export class PreloadController {
	private readonly loader: TrackLoader;
	private readonly manager: PreloadManager;
	private readonly bus?: PlayerBus;
	private readonly unsubscribe?: () => void;
	private readonly detachRpcs: Array<() => void> = [];

	public constructor(options: PreloadControllerOptions) {
		this.loader = options.loader;
		this.manager = options.manager;
		this.bus = options.bus;
		if (this.bus) {
			this.unsubscribe = this.bus.onInput("[Player]->[Preload]:request", (event) => {
				void this.handleRequest(event);
			});
			this.detachRpcs.push(
				this.bus.registerRpc<{ track: Track }, AudioResource | null>(CONTROLLER_RPC.playbackPromotePreload, ({ track }) => {
					const session = this.bus!.querySync("playbackSessionInternal");
					if (!session) return null;
					const promoted = this.bus!.requestRpcSync<{ track: Track }, PromotedPreload | null>("preload.promote", { track });
					if (!promoted) return null;
					const streamInfo: StreamInfo = promoted.streamInfo ?? { stream: promoted.stream as any, type: "arbitrary" };
					const resource = this.bus!.requestRpcSync<
						{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
						AudioResource
					>("resource.create", {
						stream: (streamInfo.stream ?? promoted.stream) as import("stream").Readable,
						track: promoted.track,
						inputType: streamInfo.inputType,
					});
					session.setResource(resource);
					this.bus!.requestRpcSync(CONTROLLER_RPC.playbackPlay, { resource, session });
					session.markPlaying(0);
					this.bus!.event({ type: "playbackStateChanged", session: session.snapshot() });
					return resource;
				}),
				this.bus.registerRpc<void, void>("preload.next", () => this.preload()),
				this.bus.registerRpc<void, void>("preload.cancel", () => this.cancel()),
				this.bus.registerRpc<void, void>("preload.cancelSafe", () => this.cancelSafely()),
				this.bus.registerRpc<void, void>("preload.clear", () => this.clear()),
				this.bus.registerRpc<{ track: Track }, boolean>("preload.has", ({ track }) => this.has(track)),
				this.bus.registerRpc<{ track: Track }, PromotedPreload | null>("preload.promote", ({ track }) =>
					this.takePreloaded(track),
				),
			);
		}
	}

	public async preload(): Promise<void> {
		await this.loader.preloadNext();
		this.bus?.publish("preloadStateChanged", { requestedTrack: null, valid: false });
	}

	/**
	 * Compatibility hook for PlaybackOrchestrator's preload fast-path.
	 * Promotion remains owned by TrackLoader.loadWithRecovery(), which already
	 * consumes a valid preload before resolving a fresh stream. Returning null
	 * here avoids consuming the slot before a PlaybackSession exists.
	 */
	public peek(_track: Track): TrackLoadResult | null {
		return null;
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
	public takePreloaded(track: Track): PromotedPreload | null {
		const promoted = this.manager.takePreloaded(track);
		if (promoted) this.bus?.publish("preloadPromoted", track);
		return promoted;
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
		for (const detach of this.detachRpcs.splice(0)) detach();
		this.loader.cancelPreload();
	}
}
