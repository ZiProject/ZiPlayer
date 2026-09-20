import type { Bus, PlayerAction } from "./Bus";
import { PlaybackSession } from "./PlaybackSession";
import { PlaybackSessionController } from "../controller/PlaybackSessionController";
import type { PlayerMessageContext, Track, PlaybackOrchestratorOptions, PlaybackOrchestratorAttachOptions } from "../types";
import { CONTROLLER_RPC } from "../controller/ControllerBusContract";
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

/** Per-player worker: owns start/prepare/play/trackEnd/skip controllers and player bus subscriptions. */
export class PlaybackOrchestratorWorker {
	readonly start: PlaybackStartController;
	readonly prepare: PlaybackPreparationController;
	readonly play: PlaybackPlayController;
	readonly trackEnd: PlaybackTrackEndController;
	readonly skip: PlaybackSkipController;
	readonly lifecycleAbort: AbortController;
	readonly debug: (message?: any, ...optionalParams: any[]) => void;
	readonly adapters?: PlaybackOrchestratorAttachOptions["adapters"];
	private readonly detachTrackEnd: () => void;
	private readonly detachQueueEnd: () => void;
	private readonly detachQueueChanged: () => void;
	public disposed = false;

	public constructor(
		readonly playerId: string,
		private readonly bus: Bus,
		private readonly sessionController: PlaybackSessionController,
		attachOptions: PlaybackOrchestratorAttachOptions = {},
		callbacks: OrchestratorCallbacks,
	) {
		this.lifecycleAbort = new AbortController();
		this.debug = attachOptions.debug ?? (() => undefined);
		this.adapters = attachOptions.adapters;

		this.prepare = new PlaybackPreparationController(playerId, {
			bus: this.bus,
			isCurrentSession: (session, context) => callbacks.matchesContext(session, context),
			queueSnapshot: () => callbacks.queueSnapshot(playerId),
			setQueueRelated: (tracks) => callbacks.setQueueRelated(playerId, tracks),
		});

		this.start = new PlaybackStartController(playerId, {
			bus: this.bus,
			sessionController: this.sessionController,
			transitionEnabled: () => callbacks.transitionEnabled(playerId),
			stopPlayback: (signal, cancelPreload) => callbacks.stopPlayback(playerId, signal, cancelPreload),
			prepareTrack: (session, context) => this.prepare.prepareTrack(session, context),
			adapters: this.adapters,
		});

		this.trackEnd = new PlaybackTrackEndController(playerId, {
			bus: this.bus,
			nextThroughBus: (ignoreLoop, context) => callbacks.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => callbacks.stopPlayback(playerId, signal),
			publishState: () => callbacks.publishState(playerId),
			queueSnapshot: () => callbacks.queueSnapshot(playerId),
			lifecycleSignal: this.lifecycleAbort.signal,
		});

		this.skip = new PlaybackSkipController({
			bus: this.bus,
			playerId,
			nextThroughBus: (ignoreLoop, context) => callbacks.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => callbacks.stopPlayback(playerId, signal),
			publishState: () => callbacks.publishState(playerId),
			setWaitingForQueue: (waiting) => this.trackEnd.setWaitingForQueue(waiting),
		});

		this.play = new PlaybackPlayController(playerId, {
			bus: this.bus,
			isWaitingForQueue: () => this.trackEnd.isWaitingForQueue,
			debug: this.debug,
			lifecycleSignal: this.lifecycleAbort.signal,
			adapters: this.adapters,
		});

		this.detachTrackEnd = this.bus.subscribe(playerId, "TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			const current = this.sessionController.current(playerId);
			if (!current || current.id !== session.id) return;
			void this.trackEnd.onTrackEnd(session);
		});
		this.detachQueueEnd = this.bus.subscribe(playerId, "queueEnd", () => this.trackEnd.onQueueEnd());
		this.detachQueueChanged = this.bus.subscribe(playerId, "queueChanged", () => this.trackEnd.onQueueChanged());
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.detachTrackEnd();
		this.detachQueueEnd();
		this.detachQueueChanged();
		this.sessionController.clear(this.playerId);
		await this.trackEnd.dispose();
		await this.play.dispose();
		await this.prepare.dispose();
		await this.start.dispose();
	}
}

/**
 * Owns the playback action state machine (PLAY/PAUSE/RESUME/STOP/SKIP/SEEK), TRACK_END
 * handling, and queue-refill/autoplay orchestration for every player.
 *
 * Shared, singleton — created once in PlayerManager constructor. Each player's worker
 * lives in an internal `Map<playerId, PlaybackOrchestratorWorker>` (opened by `attach(playerId, ...)`,
 * released by `detach(playerId)`).
 */
export class PlaybackOrchestrator {
	private readonly bus: Bus;
	private readonly workers = new Map<string, PlaybackOrchestratorWorker>();
	private readonly sessionController: PlaybackSessionController;
	private readonly seekController: PlaybackSeekController;
	private readonly detachAction: () => void;

	public constructor(
		bus: Bus,
		private readonly options: PlaybackOrchestratorOptions,
	) {
		this.bus = bus;
		this.sessionController = options.sessionController;
		this.seekController = new PlaybackSeekController(bus, this.sessionController);

		this.detachAction = bus.onAction((a, c) => {
			const worker = this.workers.get(c.playerId);
			if (!worker || worker.disposed) return;
			return this.handleAction(worker, a, c);
		});

		bus.registerRpc<{ track: Track; context: PlayerMessageContext; from: Track | null }, Promise<void>>(
			CONTROLLER_RPC.playbackStart,
			({ track, context, from }, ctx) => {
				const worker = this.workers.get(ctx.playerId);
				return worker ? worker.start.start(track, context, from) : Promise.resolve();
			},
		);
		bus.registerRpc<{ session: PlaybackSession; context: PlayerMessageContext }, Promise<Track | null>>(
			CONTROLLER_RPC.playbackPrepareAutoplay,
			({ session, context }, ctx) => {
				const worker = this.workers.get(ctx.playerId);
				return worker ? worker.prepare.prepareAutoplay(session, context) : Promise.resolve(null);
			},
		);
		bus.registerRpc<{ track?: Track | null }, Promise<Track[]>>(CONTROLLER_RPC.playbackCreateRelatedTracks, ({ track }, ctx) => {
			const worker = this.workers.get(ctx.playerId);
			return worker ? worker.prepare.createRelatedTracks(track) : Promise.resolve([]);
		});
		bus.registerRpc<{ query: import("../types").SearchResult | Track | string | null; requestedBy?: string }, boolean>(
			CONTROLLER_RPC.play,
			(request, context) => {
				const worker = this.workers.get(context.playerId);
				if (!worker) return Promise.resolve(false);
				return worker.play.play(request.query, request.requestedBy, context);
			},
		);
		bus.registerRpc<{ active: boolean }, void>(CONTROLLER_RPC.playbackTransitionLock, ({ active }, ctx) =>
			this.workers.get(ctx.playerId)?.trackEnd.setTrackEndTransition(active),
		);
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Opens a worker for `playerId`. Re-attaching replaces (and releases) the old worker. */
	public attach(playerId: string, options: PlaybackOrchestratorAttachOptions = {}): void {
		if (this.workers.has(playerId)) return;
		this.workers.set(
			playerId,
			new PlaybackOrchestratorWorker(
				playerId,
				this.bus,
				this.sessionController,
				options,
				{
					matchesContext: (session, context) => this.matchesContext(session, context),
					transitionEnabled: (pId) => this.transitionEnabled(pId),
					stopPlayback: (pId, signal, cancelPreload) => this.stopPlayback(pId, signal, cancelPreload),
					nextThroughBus: (pId, ignoreLoop, context) => this.nextThroughBus(pId, ignoreLoop, context),
					publishState: (pId) => this.publishState(pId),
					queueSnapshot: (pId) => this.queueSnapshot(pId),
					setQueueRelated: (pId, tracks) => this.setQueueRelated(pId, tracks),
				},
			),
		);
	}

	/** Releases `playerId`'s worker: aborts its lifecycle signal, drops bus subscriptions and clears its session. */
	public async detach(playerId: string): Promise<void> {
		const worker = this.workers.get(playerId);
		if (!worker) return;
		this.workers.delete(playerId);
		await worker.dispose();
	}

	/**
	 * Global shutdown: releases every player's worker and the shared `onAction` subscription.
	 *
	 * Resolves only once every worker finished its async cleanup, so callers can await it before
	 * disposing the Bus. All detaches start immediately (each drops its bus subscriptions
	 * synchronously) and run concurrently; one failing worker never blocks the others. The
	 * shared `onAction` subscription is always released, and failures are rethrown afterwards.
	 */
	public async dispose(): Promise<void> {
		const playerIds = [...this.workers.keys()];
		const results = await Promise.allSettled(playerIds.map((playerId) => this.detach(playerId)));
		this.detachAction();
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length > 0) throw new AggregateError(errors, "PlaybackOrchestrator failed to dispose some workers");
	}

	public has(playerId: string): boolean {
		return this.workers.has(playerId);
	}

	public getCurrentSession(playerId: string): PlaybackSession | null {
		return this.sessionController.current(playerId);
	}

	public getTransitionPolicy(playerId: string) {
		return this.bus.querySync(playerId, "transitionSettings");
	}

	// ---------------------------------------------------------------------
	// Slot-level implementation
	// ---------------------------------------------------------------------

	private transitionEnabled(playerId: string): boolean {
		const settings = this.bus.querySync(playerId, "transitionSettings");
		return !!settings && settings.enabled !== false;
	}

	private queueSnapshot(playerId: string): Track[] {
		return this.bus.querySync(playerId, "queue") ?? [];
	}

	private queueState(playerId: string): any {
		return this.bus.querySync(playerId, "queueSerialized");
	}

	private setQueueRelated(playerId: string, tracks: Track[]): void {
		const state = this.queueState(playerId);
		if (!state || typeof state !== "object") return;
		state.relatedTracks = tracks;
		this.bus.requestRpcSync(playerId, "queue.restore", { state });
	}

	private async handleAction(worker: PlaybackOrchestratorWorker, a: PlayerAction, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const playerId = worker.playerId;
		switch (a.type) {
			case "PLAY":
				if (a.track) await worker.start.start(a.track, context);
				break;
			case "SEEK":
				await this.seekController.seek(a.position, context);
				break;
			case "SKIP":
				await worker.skip.skip(context);
				break;
			case "PAUSE": {
				const session = this.sessionController.current(playerId);
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackPause, {})
				) {
					session.markPaused();
					this.publishState(playerId);
					this.bus.event(playerId, { type: "playerPause", track: session.track });
				}
				break;
			}
			case "RESUME": {
				const session = this.sessionController.current(playerId);
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackResume, {})
				) {
					session.markPlaying();
					this.publishState(playerId);
					this.bus.event(playerId, { type: "playerResume", track: session.track });
				}
				break;
			}
			case "STOP": {
				const session = this.sessionController.current(playerId);
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(playerId, context.signal);
				if (session?.isActive()) session.markStopped();
				this.publishState(playerId);
				this.bus.event(playerId, { type: "playerStop" });
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
		if (this.bus.hasRpc("preload.cancel")) {
			this.bus.requestRpcSync(playerId, "preload.cancel", {});
		} else {
			this.workers.get(playerId)?.adapters?.cancelPreload?.();
		}
	}

	private async nextThroughBus(playerId: string, ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		const previousCurrent = this.bus.querySync(playerId, "queueCurrent") ?? null;
		await this.bus.action(playerId, { type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		const next = await this.bus.query(playerId, "queueCurrent");
		if (context.signal.aborted) {
			await this.bus.requestRpc(playerId, "queue.restoreNext", { previousCurrent, nextTrack: next });
			return null;
		}
		return next;
	}

	private publishState(playerId: string): void {
		this.bus.event(playerId, {
			type: "playbackStateChanged",
			session: this.sessionController.current(playerId)?.snapshot() ?? null,
		});
	}
}

export function createPlaybackOrchestrator(bus: Bus, options: PlaybackOrchestratorOptions): PlaybackOrchestrator {
	return Reflect.construct(PlaybackOrchestrator, [bus, options]);
}
