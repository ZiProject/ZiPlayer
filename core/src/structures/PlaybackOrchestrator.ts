import type { Bus, PlayerAction } from "./Bus";
import { PlaybackSession } from "./PlaybackSession";
import { PlaybackSessionController } from "../controller/PlaybackSessionController";
import {
	PlaybackMode,
	type PlayerMessageContext,
	type Track,
	type PlaybackOrchestratorOptions,
	type PlaybackOrchestratorAttachOptions,
} from "../types";
import { CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC, BUS_EVENT, PLAYER_ACTION } from "./BusContract";
import { PlaybackStartController } from "../controller/PlaybackStartController";
import { PlaybackPreparationController } from "../controller/PlaybackPreparationController";
import { PlaybackSeekController } from "../controller/PlaybackSeekController";
import { PlaybackSkipController } from "../controller/PlaybackSkipController";
import { PlaybackTrackEndController } from "../controller/PlaybackTrackEndController";
import { PlaybackPlayController } from "../controller/PlaybackPlayController";

interface OrchestratorCallbacks {
	matchesContext: (session: PlaybackSession, context: PlayerMessageContext) => boolean;
	transitionEnabled: (playerId: string) => boolean;
	stopPlayback: (playerId: string, signal: AbortSignal, cancelPreload?: boolean) => void;
	nextThroughBus: (playerId: string, ignoreLoop: boolean, context: PlayerMessageContext) => Promise<Track | null>;
	publishState: (playerId: string) => void;
	queueSnapshot: (playerId: string) => Track[];
	setQueueRelated: (playerId: string, tracks: Track[]) => void;
}

interface PlaybackOrchestratorState {
	readonly playerId: string;
	readonly start: PlaybackStartController;
	readonly prepare: PlaybackPreparationController;
	readonly play: PlaybackPlayController;
	readonly trackEnd: PlaybackTrackEndController;
	readonly skip: PlaybackSkipController;
	readonly lifecycleAbort: AbortController;
	readonly debug: (message?: any, ...optionalParams: any[]) => void;
	readonly adapters?: PlaybackOrchestratorAttachOptions["adapters"];
	detachTrackEnd: () => void;
	detachQueueEnd: () => void;
	detachQueueChanged: () => void;
	disposed: boolean;
}

/**
 * Owns the playback action state machine (PLAY/PAUSE/RESUME/STOP/SKIP/SEEK), TRACK_END
 * handling, and queue-refill/autoplay orchestration for every player.
 *
 * Shared, singleton — created once in PlayerManager constructor. Per-player runtime
 * data and child-controller references live in an internal state map keyed by playerId.
 */
export class PlaybackOrchestrator {
	private readonly bus: Bus;
	public readonly states = new Map<string, PlaybackOrchestratorState>();
	private readonly sessionController: PlaybackSessionController;
	private readonly seekController: PlaybackSeekController;
	private readonly detachAction: () => void;

	public constructor(bus: Bus, options: PlaybackOrchestratorOptions) {
		this.bus = bus;
		this.sessionController = options.sessionController;
		this.seekController = new PlaybackSeekController(bus, this.sessionController);

		this.detachAction = bus.onAction((a, c) => {
			const state = this.states.get(c.playerId);
			if (!state || state.disposed) return;
			return this.handleAction(state, a, c);
		});

		bus.registerRpc<{ track: Track; context: PlayerMessageContext; from: Track | null }, Promise<void>>(
			CONTROLLER_RPC.playbackStart,
			({ track, context, from }, ctx) => {
				const state = this.states.get(ctx.playerId);
				return state ? state.start.start(track, context, from) : Promise.resolve();
			},
		);
		bus.registerRpc<{ session: PlaybackSession; context: PlayerMessageContext }, Promise<Track | null>>(
			CONTROLLER_RPC.playbackPrepareAutoplay,
			({ session, context }, ctx) => {
				const state = this.states.get(ctx.playerId);
				return state ? state.prepare.prepareAutoplay(session, context) : Promise.resolve(null);
			},
		);
		bus.registerRpc<{ track?: Track | null }, Promise<Track[]>>(CONTROLLER_RPC.playbackCreateRelatedTracks, ({ track }, ctx) => {
			const state = this.states.get(ctx.playerId);
			return state ? state.prepare.createRelatedTracks(track) : Promise.resolve([]);
		});
		bus.registerRpc<
			{ query: import("../types").SearchResult | Track | string | null; requestedBy?: string; plugin?: string | string[] },
			any
		>(CONTROLLER_RPC.play, (request, context) => {
			const state = this.states.get(context.playerId);
			if (!state) return Promise.resolve(false);
			return state.play.play(request.query, request.requestedBy, context, request.plugin);
		});
		bus.registerRpc<{ active: boolean }, void>(CONTROLLER_RPC.playbackTransitionLock, ({ active }, ctx) =>
			this.states.get(ctx.playerId)?.trackEnd.setTrackEndTransition(active),
		);
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Opens state for `playerId`; duplicate attach calls leave the existing state intact. */
	public attach(playerId: string, options: PlaybackOrchestratorAttachOptions = {}): void {
		if (this.states.has(playerId)) return;
		const callbacks: OrchestratorCallbacks = {
			matchesContext: (session, context) => this.matchesContext(session, context),
			transitionEnabled: (pId) => this.transitionEnabled(pId),
			stopPlayback: (pId, signal, cancelPreload) => this.stopPlayback(pId, signal, cancelPreload),
			nextThroughBus: (pId, ignoreLoop, context) => this.nextThroughBus(pId, ignoreLoop, context),
			publishState: (pId) => this.publishState(pId),
			queueSnapshot: (pId) => this.queueSnapshot(pId),
			setQueueRelated: (pId, tracks) => this.setQueueRelated(pId, tracks),
		};
		const lifecycleAbort = new AbortController();
		const debug = options.debug ?? (() => undefined);
		const adapters = options.adapters;
		const prepare = new PlaybackPreparationController(playerId, {
			bus: this.bus,
			isCurrentSession: callbacks.matchesContext,
			queueSnapshot: () => callbacks.queueSnapshot(playerId),
			setQueueRelated: (tracks) => callbacks.setQueueRelated(playerId, tracks),
			debug,
		});
		const trackEnd = new PlaybackTrackEndController(playerId, {
			bus: this.bus,
			nextThroughBus: (ignoreLoop, context) => callbacks.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => callbacks.stopPlayback(playerId, signal),
			publishState: () => callbacks.publishState(playerId),
			queueSnapshot: () => callbacks.queueSnapshot(playerId),
			lifecycleSignal: lifecycleAbort.signal,
		});
		const start = new PlaybackStartController(playerId, {
			bus: this.bus,
			sessionController: this.sessionController,
			transitionEnabled: () => callbacks.transitionEnabled(playerId),
			stopPlayback: (signal, cancelPreload) => callbacks.stopPlayback(playerId, signal, cancelPreload),
			prepareTrack: (session, context) => prepare.prepareTrack(session, context),
			adapters,
		});
		const skip = new PlaybackSkipController({
			bus: this.bus,
			playerId,
			nextThroughBus: (ignoreLoop, context) => callbacks.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => callbacks.stopPlayback(playerId, signal),
			publishState: () => callbacks.publishState(playerId),
			setWaitingForQueue: (waiting) => trackEnd.setWaitingForQueue(waiting),
		});
		const play = new PlaybackPlayController(playerId, {
			bus: this.bus,
			isWaitingForQueue: () => trackEnd.isWaitingForQueue,
			debug,
			lifecycleSignal: lifecycleAbort.signal,
			adapters,
		});
		const state: PlaybackOrchestratorState = {
			playerId,
			start,
			prepare,
			play,
			trackEnd,
			skip,
			lifecycleAbort,
			debug,
			adapters,
			disposed: false,
			detachTrackEnd: () => {},
			detachQueueEnd: () => {},
			detachQueueChanged: () => {},
		};
		state.detachTrackEnd = this.bus.subscribe(playerId, BUS_EVENT.trackEnd, (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			const current = this.sessionController.current(playerId);
			if (!current || current.id !== session.id) return;
			void state.trackEnd.onTrackEnd(session);
		});
		state.detachQueueEnd = this.bus.subscribe(playerId, BUS_EVENT.queueEnd, () => state.trackEnd.onQueueEnd());
		state.detachQueueChanged = this.bus.subscribe(playerId, BUS_EVENT.queueChanged, () => state.trackEnd.onQueueChanged());
		this.states.set(playerId, state);
	}

	/** Releases per-player state, aborts in-flight work, removes subscriptions and clears the session. */
	public async detach(playerId: string): Promise<void> {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		await this.disposeState(state);
	}

	/**
	 * Global shutdown: releases every player's state and the shared `onAction` subscription.
	 *
	 * Resolves only once every state finished its async cleanup, so callers can await it before
	 * disposing the Bus. All detaches start immediately (each drops its bus subscriptions
	 * synchronously) and run concurrently; one failing state never blocks the others. The
	 * shared `onAction` subscription is always released, and failures are rethrown afterwards.
	 */
	public async dispose(): Promise<void> {
		const playerIds = [...this.states.keys()];
		const results = await Promise.allSettled(playerIds.map((playerId) => this.detach(playerId)));
		this.detachAction();
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length > 0) throw new AggregateError(errors, "PlaybackOrchestrator failed to dispose some player states");
	}

	public has(playerId: string): boolean {
		return this.states.has(playerId);
	}

	private async disposeState(state: PlaybackOrchestratorState): Promise<void> {
		if (state.disposed) return;
		state.disposed = true;
		state.lifecycleAbort.abort();
		state.detachTrackEnd();
		state.detachQueueEnd();
		state.detachQueueChanged();
		this.sessionController.clear(state.playerId);
		await state.trackEnd.dispose();
		await state.play.dispose();
		await state.prepare.dispose();
		await state.start.dispose();
	}

	public getCurrentSession(playerId: string): PlaybackSession | null {
		return this.sessionController.current(playerId);
	}

	public getTransitionPolicy(playerId: string) {
		return this.bus.querySync(playerId, PLAYER_QUERY.transitionSettings);
	}

	// ---------------------------------------------------------------------
	// Slot-level implementation
	// ---------------------------------------------------------------------

	private transitionEnabled(playerId: string): boolean {
		const settings = this.bus.querySync(playerId, PLAYER_QUERY.transitionSettings);
		return !!settings && settings.enabled !== false;
	}

	private queueSnapshot(playerId: string): Track[] {
		return this.bus.querySync(playerId, PLAYER_QUERY.queue) ?? [];
	}

	private queueState(playerId: string): any {
		return this.bus.querySync(playerId, PLAYER_QUERY.queueSerialized);
	}

	private setQueueRelated(playerId: string, tracks: Track[]): void {
		const state = this.queueState(playerId);
		if (!state || typeof state !== "object") return;
		state.relatedTracks = tracks;
		this.bus.requestRpcSync(playerId, PLAYER_RPC.queueRestore, { state });
	}

	private async handleAction(state: PlaybackOrchestratorState, a: PlayerAction, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const playerId = state.playerId;
		switch (a.type) {
			case "PLAY":
				if (a.track) await state.start.start(a.track, context);
				break;
			case "SEEK":
				await this.seekController.seek(a.position, context);
				break;
			case "SKIP":
				await state.skip.skip(context, (a as any).index);
				break;
			case "PAUSE": {
				const session = this.sessionController.current(playerId);
				const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
				if (mode === PlaybackMode.REMOTE) {
					const ok = this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackRemotePause, {});
					if (ok) {
						if (session?.isActive()) session.markPaused();
						this.publishState(playerId);
						this.bus.event(playerId, {
							type: BUS_EVENT.playerPause,
							track: session?.track ?? (this.bus.querySync(playerId, PLAYER_QUERY.currentTrack) as Track | null),
						});
					}
					break;
				}
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackPause, {})
				) {
					session.markPaused();
					this.publishState(playerId);
					this.bus.event(playerId, { type: BUS_EVENT.playerPause, track: session.track });
				}
				break;
			}
			case "RESUME": {
				const session = this.sessionController.current(playerId);
				const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
				if (mode === PlaybackMode.REMOTE) {
					const ok = this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackRemoteResume, {});
					if (ok) {
						if (session?.isActive()) session.markPlaying();
						this.publishState(playerId);
						this.bus.event(playerId, {
							type: BUS_EVENT.playerResume,
							track: session?.track ?? (this.bus.querySync(playerId, PLAYER_QUERY.currentTrack) as Track | null),
						});
					}
					break;
				}
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackResume, {})
				) {
					session.markPlaying();
					this.publishState(playerId);
					this.bus.event(playerId, { type: BUS_EVENT.playerResume, track: session.track });
				}
				break;
			}
			case "STOP": {
				const session = this.sessionController.current(playerId);
				const mode = this.bus.querySync(playerId, PLAYER_QUERY.playbackMode);
				if (mode === PlaybackMode.REMOTE) {
					void this.bus.requestRpc(playerId, CONTROLLER_RPC.playbackRemoteStop, {});
				}
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(playerId, context.signal);
				this.bus.requestRpcSync(playerId, PLAYER_RPC.queueClear, undefined);
				if (session?.isActive()) session.markStopped();
				this.publishState(playerId);
				this.bus.event(playerId, { type: BUS_EVENT.playerStop });
				break;
			}
		}
	}

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return session.ownsContext(context.sessionId);
	}

	private stopPlayback(playerId: string, _s: AbortSignal, cancelPreload = true): void {
		this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackStop, {});
		if (!cancelPreload) return;
		if (this.bus.hasRpc(PLAYER_RPC.preloadCancel)) {
			this.bus.requestRpcSync(playerId, PLAYER_RPC.preloadCancel, {});
		} else {
			this.states.get(playerId)?.adapters?.cancelPreload?.();
		}
	}

	private async nextThroughBus(playerId: string, ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		const previousCurrent = this.bus.querySync(playerId, PLAYER_QUERY.queueCurrent) ?? null;
		await this.bus.action(playerId, { type: PLAYER_ACTION.queueNext, ignoreLoop, requestId: context.requestId }, context);
		const next = await this.bus.query(playerId, PLAYER_QUERY.queueCurrent);
		if (context.signal.aborted) {
			await this.bus.requestRpc(playerId, PLAYER_RPC.queueRestoreNext, { previousCurrent, nextTrack: next });
			return null;
		}
		return next;
	}

	private publishState(playerId: string): void {
		this.bus.event(playerId, {
			type: BUS_EVENT.playbackStateChanged,
			session: this.sessionController.current(playerId)?.snapshot() ?? null,
		});
	}
}

export function createPlaybackOrchestrator(bus: Bus, options: PlaybackOrchestratorOptions): PlaybackOrchestrator {
	return Reflect.construct(PlaybackOrchestrator, [bus, options]);
}
