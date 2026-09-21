import type { AudioResource } from "@discordjs/voice";
import type { Track, TrackLoadResult, PromotedPreload, StreamInfo, StreamSlot } from "../types";
import type { Bus } from "../structures/Bus";
import { createPlayerRequestId } from "../structures/Bus";
import type { TrackLoader } from "../structures/TrackLoader";
import type { PreloadManager } from "../structures/PreloadManager";
import type { PreloadControllerOptions } from "../types";
import { BUS_EVENT, BUS_OUTPUT, BUS_REQUEST, CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

export interface PreloadState {
	preload?: PromotedPreload | null;
	generation?: number;
	abortController?: AbortController | null;
}

/**
 * Owns preload lifecycle for every player.
 *
 * Shared, singleton — created once in PlayerManager constructor. Attachment is tracked
 * in `states = new Map<string, PreloadState>()` (opened by `attach(playerId)`, released by `detach(playerId)`); the
 * actual preload slot lives in the (also shared) `PreloadManager` this controller was
 * constructed with. Every `preload.*` RPC/query below, plus the
 * `"[Player]->[Preload]:request"` input, is registered exactly once, in the constructor,
 * and routes by `ctx.playerId` / `event.playerId`.
 */
export class PreloadController {
	private readonly bus?: Bus;
	private readonly loader: TrackLoader;
	private readonly manager: PreloadManager;
	private readonly states = new Map<string, PreloadState>();

	public constructor(bus: Bus, options: PreloadControllerOptions) {
		this.bus = bus;
		this.loader = options.loader;
		this.manager = options.manager;

		if (bus) {
			bus.registerRpc<{ track: Track }, AudioResource | null>(CONTROLLER_RPC.playbackPromotePreload, ({ track }, ctx) =>
				this.promotePreload(ctx.playerId, track),
			);
			bus.registerRpc<void, void>(PLAYER_RPC.preloadNext, (_req, ctx) => this.preload(ctx.playerId));
			bus.registerRpc<void, void>(PLAYER_RPC.preloadCancel, (_req, ctx) => this.cancel(ctx.playerId));
			bus.registerRpc<void, void>(PLAYER_RPC.preloadCancelSafe, (_req, ctx) => this.cancelSafely(ctx.playerId));
			bus.registerRpc<void, void>(PLAYER_RPC.preloadClear, (_req, ctx) => this.clear(ctx.playerId));
			bus.registerRpc<{ track: Track }, boolean>(PLAYER_RPC.preloadHas, ({ track }, ctx) => this.has(ctx.playerId, track));
			bus.registerRpc<{ track: Track }, PromotedPreload | null>(PLAYER_RPC.preloadPromote, ({ track }, ctx) =>
				this.takePreloaded(ctx.playerId, track),
			);
			bus.registerQuery(PLAYER_QUERY.preloadState, (playerId) => this.getState(playerId));
			bus.registerRpc(PLAYER_RPC.preloadState, (_req, ctx) => this.getState(ctx.playerId));
			bus.onInput(BUS_REQUEST.preloadRequest, (event) => {
				if (!this.states.has(event.playerId)) return;
				void this.handleRequest(event.playerId, event);
			});
		}
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Marks `playerId` as attached; the preload slot itself lives in `PreloadManager`. */
	public attach(playerId: string): void {
		if (this.states.has(playerId)) return;
		this.states.set(playerId, {
			preload: null,
			generation: 0,
			abortController: new AbortController(),
		});
	}

	/** Releases `playerId`: stops routing input events to it and cancels any in-flight preload. */
	public detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		state.abortController?.abort();
		this.states.delete(playerId);
		this.loader.cancelPreload(playerId);
	}

	/** Global shutdown: releases every player. */
	public dispose(): void {
		for (const playerId of [...this.states.keys()]) this.detach(playerId);
	}

	public has(playerId: string, track: Track): boolean {
		return this.loader.hasPreload(playerId, track);
	}
	public aggregateSnapshot(): { active: number } {
		let active = 0;
		for (const state of this.states.values()) {
			if (state.preload || state.generation) active++;
		}
		return { active };
	}

	// ---------------------------------------------------------------------
	// Preload operations (all keyed by playerId)
	// ---------------------------------------------------------------------

	public promotePreload(playerId: string, track: Track): AudioResource | null {
		if (!this.bus) return null;
		const session = this.bus.querySync(playerId, PLAYER_QUERY.playbackSessionInternal);
		if (!session) return null;
		const promoted = this.bus.requestRpcSync<{ track: Track }, PromotedPreload | null>(playerId, PLAYER_RPC.preloadPromote, {
			track,
		});
		if (!promoted) return null;
		const streamInfo: StreamInfo = promoted.streamInfo ?? { stream: promoted.stream as any, type: "arbitrary" };
		const resource = this.bus.requestRpcSync<
			{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
			AudioResource
		>(playerId, PLAYER_RPC.resourceCreate, {
			stream: (streamInfo.stream ?? promoted.stream) as import("stream").Readable,
			track: promoted.track,
			inputType: streamInfo.inputType,
		});
		session.setResource(resource);
		this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackPlay, { resource, session });
		session.markPlaying(0);
		this.bus.event(playerId, { type: BUS_EVENT.playbackStateChanged, session: session.snapshot() });
		return resource;
	}

	public getState(playerId: string): { hasSlot: boolean; currentSlot: StreamSlot } {
		const currentSlot = this.manager.slotState(playerId);
		return {
			hasSlot: Boolean(currentSlot.track || currentSlot.streamInfo || currentSlot.streamId || currentSlot.isLoading),
			currentSlot,
		};
	}

	public async preload(playerId: string): Promise<void> {
		await this.loader.preloadNext(playerId);
		if (this.bus) this.bus.publish(playerId, BUS_EVENT.preloadStateChanged, { requestedTrack: null, valid: false });
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
		event: { type: typeof BUS_REQUEST.preloadRequest; requestId: string; track: Track },
	): Promise<void> {
		if (this.loader.hasPreload(playerId, event.track)) {
			if (this.bus)
				this.bus.emitOutput({ type: BUS_OUTPUT.preloadReady, requestId: event.requestId, playerId, track: event.track });
			return;
		}

		if (this.bus)
			this.bus.emitOutput({ type: BUS_OUTPUT.preloadLoading, requestId: event.requestId, playerId, track: event.track });
		try {
			await this.loader.preloadNext(playerId);
			const valid = this.loader.hasPreload(playerId, event.track);
			if (!valid) throw new Error(`Preload did not produce the requested track: ${event.track.title}`);
			if (this.bus)
				this.bus.emitOutput({ type: BUS_OUTPUT.preloadReady, requestId: event.requestId, playerId, track: event.track });
		} catch (error) {
			if (this.bus) {
				this.bus.emitOutput({
					type: BUS_OUTPUT.preloadFailed,
					requestId: event.requestId,
					playerId,
					track: event.track,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	public request(playerId: string, track: Track): Promise<Track> {
		if (!this.bus) return Promise.resolve(track);
		return this.bus
			.request(playerId, { type: BUS_REQUEST.preloadRequest, requestId: createPlayerRequestId(), track })
			.then((event) => event.track);
	}

	public takePreloaded(playerId: string, track: Track): PromotedPreload | null {
		const promoted = this.manager.takePreloaded(playerId, track);
		if (promoted && this.bus) this.bus.publish(playerId, BUS_EVENT.preloadPromoted, track);
		return promoted;
	}
	public cancel(playerId: string): void {
		this.loader.cancelPreload(playerId);
		if (this.bus) this.bus.publish(playerId, BUS_EVENT.preloadCancelled);
	}
	public async cancelSafely(playerId: string): Promise<void> {
		await this.loader.cancelPreloadSafely(playerId);
		if (this.bus) this.bus.publish(playerId, BUS_EVENT.preloadCancelled);
	}
	public clear(playerId: string): void {
		this.manager.clearPreloadSlot(playerId);
	}
}
