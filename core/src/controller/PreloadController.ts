import type { AudioResource } from "@discordjs/voice";
import type { Track, TrackLoadResult, PromotedPreload, StreamInfo, StreamSlot } from "../types";
import type { Bus } from "../structures/Bus";
import { createPlayerRequestId } from "../structures/Bus";
import type { TrackLoader } from "../structures/TrackLoader";
import type { PreloadManager } from "../structures/PreloadManager";
import type { PreloadControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/**
 * Owns preload lifecycle for every player.
 *
 * Shared, singleton — created once in `ensureSharedControllers()`. Attachment is tracked
 * by a `Set<playerId>` (opened by `attach(playerId)`, released by `detach(playerId)`); the
 * actual preload slot lives in the (also shared) `PreloadManager` this controller was
 * constructed with. Every `preload.*` RPC/query below, plus the
 * `"[Player]->[Preload]:request"` input, is registered exactly once, in the constructor,
 * and routes by `ctx.playerId` / `event.playerId`.
 */
export class PreloadController {
	private readonly bus?: Bus;
	private readonly loader: TrackLoader;
	private readonly manager: PreloadManager;
	private readonly attached = new Set<string>();
	private defaultPlayerId?: string;

	public constructor(bus: Bus, options: PreloadControllerOptions);
	public constructor(options: PreloadControllerOptions & { bus?: Bus; playerId?: string });
	public constructor(
		busOrOptions: Bus | (PreloadControllerOptions & { bus?: Bus; playerId?: string }),
		maybeOptions?: PreloadControllerOptions,
	) {
		const isLegacy = !maybeOptions && typeof (busOrOptions as any)?.loader === "object";
		const bus: Bus | undefined = isLegacy ? ((busOrOptions as any).bus ?? (busOrOptions as any).loader?.bus) : (busOrOptions as Bus);
		const options = (isLegacy ? busOrOptions : maybeOptions) as PreloadControllerOptions;
		this.bus = bus;
		this.loader = options.loader;
		this.manager = options.manager;

		if (bus) {
			bus.registerRpc<{ track: Track }, AudioResource | null>(CONTROLLER_RPC.playbackPromotePreload, ({ track }, ctx) =>
				this.promotePreload(ctx.playerId, track),
			);
			bus.registerRpc<void, void>("preload.next", (_req, ctx) => this.preload(ctx.playerId));
			bus.registerRpc<void, void>("preload.cancel", (_req, ctx) => this.cancel(ctx.playerId));
			bus.registerRpc<void, void>("preload.cancelSafe", (_req, ctx) => this.cancelSafely(ctx.playerId));
			bus.registerRpc<void, void>("preload.clear", (_req, ctx) => this.clear(ctx.playerId));
			bus.registerRpc<{ track: Track }, boolean>("preload.has", ({ track }, ctx) => this.has(ctx.playerId, track));
			bus.registerRpc<{ track: Track }, PromotedPreload | null>("preload.promote", ({ track }, ctx) =>
				this.takePreloaded(ctx.playerId, track),
			);
			bus.registerQuery("preload.state", (playerId) => this.getState(playerId));
			bus.registerRpc("preload.state", (_req, ctx) => this.getState(ctx.playerId));
			bus.onInput("[Player]->[Preload]:request", (event) => {
				if (!this.attached.has(event.playerId)) return;
				void this.handleRequest(event.playerId, event);
			});
		}
		if (isLegacy) {
			const pid = (busOrOptions as any).playerId ?? "default";
			this.defaultPlayerId = pid;
			this.attach(pid);
		}
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Marks `playerId` as attached; the preload slot itself lives in `PreloadManager`. */
	public attach(playerId: string): void {
		this.attached.add(playerId);
	}

	/** Releases `playerId`: stops routing input events to it and cancels any in-flight preload. */
	public detach(playerId: string): void {
		if (!this.attached.has(playerId)) return;
		this.attached.delete(playerId);
		this.loader.cancelPreload(playerId);
	}

	/** Global shutdown: releases every player. */
	public dispose(): void {
		for (const playerId of [...this.attached]) this.detach(playerId);
	}

	public has(playerId: string, track: Track): boolean;
	public has(track: Track): boolean;
	public has(arg1: string | Track, arg2?: Track): boolean {
		if (typeof arg1 === "string") {
			return this.loader.hasPreload(arg1, arg2!);
		}
		const playerId = this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		return this.loader.hasPreload(playerId, arg1);
	}

	// ---------------------------------------------------------------------
	// Preload operations (all keyed by playerId)
	// ---------------------------------------------------------------------

	public promotePreload(playerId: string, track: Track): AudioResource | null;
	public promotePreload(track: Track): AudioResource | null;
	public promotePreload(arg1: string | Track, arg2?: Track): AudioResource | null {
		const isFirstArgString = typeof arg1 === "string";
		const playerId = isFirstArgString ? arg1 : (this.defaultPlayerId ?? this.attached.values().next().value ?? "default");
		const track = (isFirstArgString ? arg2 : arg1) as Track;
		if (!this.bus) return null;
		const session = this.bus.querySync(playerId, "playbackSessionInternal");
		if (!session) return null;
		const promoted = this.bus.requestRpcSync<{ track: Track }, PromotedPreload | null>(playerId, "preload.promote", { track });
		if (!promoted) return null;
		const streamInfo: StreamInfo = promoted.streamInfo ?? { stream: promoted.stream as any, type: "arbitrary" };
		const resource = this.bus.requestRpcSync<
			{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
			AudioResource
		>(playerId, "resource.create", {
			stream: (streamInfo.stream ?? promoted.stream) as import("stream").Readable,
			track: promoted.track,
			inputType: streamInfo.inputType,
		});
		session.setResource(resource);
		this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackPlay, { resource, session });
		session.markPlaying(0);
		this.bus.event(playerId, { type: "playbackStateChanged", session: session.snapshot() });
		return resource;
	}

	public getState(playerId?: string): { hasSlot: boolean; currentSlot: StreamSlot } {
		const id = playerId ?? this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		const currentSlot = this.manager.slotState(id);
		return {
			hasSlot: Boolean(currentSlot.track || currentSlot.streamInfo || currentSlot.streamId || currentSlot.isLoading),
			currentSlot,
		};
	}

	public async preload(playerId?: string): Promise<void> {
		const id = playerId ?? this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		await this.loader.preloadNext(id);
		if (this.bus) this.bus.publish(id, "preloadStateChanged", { requestedTrack: null, valid: false });
	}

	/**
	 * Compatibility hook for PlaybackOrchestrator's preload fast-path.
	 * Promotion remains owned by TrackLoader.loadWithRecovery(), which already
	 * consumes a valid preload before resolving a fresh stream. Returning null
	 * here avoids consuming the slot before a PlaybackSession exists.
	 */
	public peek(_playerId: string, _track: Track): TrackLoadResult | null {
		return null;
	}

	/** Bus input entry point; keeps preload ownership inside this controller. */
	private async handleRequest(
		playerId: string,
		event: { type: "[Player]->[Preload]:request"; requestId: string; track: Track },
	): Promise<void> {
		if (this.loader.hasPreload(playerId, event.track)) {
			if (this.bus) this.bus.emitOutput({ type: "[Preload]->[Player]:ready", requestId: event.requestId, playerId, track: event.track });
			return;
		}

		if (this.bus) this.bus.emitOutput({ type: "[Preload]->[Player]:loading", requestId: event.requestId, playerId, track: event.track });
		try {
			await this.loader.preloadNext(playerId);
			const valid = this.loader.hasPreload(playerId, event.track);
			if (!valid) throw new Error(`Preload did not produce the requested track: ${event.track.title}`);
			if (this.bus) this.bus.emitOutput({ type: "[Preload]->[Player]:ready", requestId: event.requestId, playerId, track: event.track });
		} catch (error) {
			if (this.bus) {
				this.bus.emitOutput({
					type: "[Preload]->[Player]:failed",
					requestId: event.requestId,
					playerId,
					track: event.track,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	public request(playerId: string, track: Track): Promise<Track>;
	public request(track: Track): Promise<Track>;
	public request(arg1: string | Track, arg2?: Track): Promise<Track> {
		const isFirstArgString = typeof arg1 === "string";
		const playerId = isFirstArgString ? arg1 : (this.defaultPlayerId ?? this.attached.values().next().value ?? "default");
		const track = (isFirstArgString ? arg2 : arg1) as Track;
		if (!this.bus) return Promise.resolve(track);
		return this.bus
			.request(playerId, { type: "[Player]->[Preload]:request", requestId: createPlayerRequestId(), track })
			.then((event) => event.track);
	}

	public takePreloaded(playerId: string, track: Track): PromotedPreload | null;
	public takePreloaded(track: Track): PromotedPreload | null;
	public takePreloaded(arg1: string | Track, arg2?: Track): PromotedPreload | null {
		const isFirstArgString = typeof arg1 === "string";
		const playerId = isFirstArgString ? arg1 : (this.defaultPlayerId ?? this.attached.values().next().value ?? "default");
		const track = (isFirstArgString ? arg2 : arg1) as Track;
		const promoted = this.manager.takePreloaded(playerId, track);
		if (promoted && this.bus) this.bus.publish(playerId, "preloadPromoted", track);
		return promoted;
	}
	public cancel(playerId?: string): void {
		const id = playerId ?? this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		this.loader.cancelPreload(id);
		if (this.bus) this.bus.publish(id, "preloadCancelled");
	}
	public async cancelSafely(playerId?: string): Promise<void> {
		const id = playerId ?? this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		await this.loader.cancelPreloadSafely(id);
		if (this.bus) this.bus.publish(id, "preloadCancelled");
	}
	public clear(playerId?: string): void {
		const id = playerId ?? this.defaultPlayerId ?? this.attached.values().next().value ?? "default";
		this.manager.clearPreloadSlot(id);
	}
}
