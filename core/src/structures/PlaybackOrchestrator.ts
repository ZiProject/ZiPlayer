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

/** Everything the orchestrator keeps for ONE player. Lives only inside `PlaybackOrchestrator.workers`. */
interface OrchestratorWorker {
	readonly playerId: string;
	readonly lifecycleAbort: AbortController;
	readonly debug: (message?: any, ...optionalParams: any[]) => void;
	readonly adapters: PlaybackOrchestratorAttachOptions["adapters"];
	readonly preparationController: PlaybackPreparationController;
	readonly startController: PlaybackStartController;
	readonly skipController: PlaybackSkipController;
	readonly trackEndController: PlaybackTrackEndController;
	readonly playController: PlaybackPlayController;
	readonly detachTrackEnd: () => void;
	readonly detachQueueEnd: () => void;
	readonly detachQueueChanged: () => void;
	disposed: boolean;
}

/**
 * Owns the playback action state machine (PLAY/PAUSE/RESUME/STOP/SKIP/SEEK), TRACK_END
 * handling, and queue-refill/autoplay orchestration for every player.
 *
 * Shared, singleton — created once in `ensureSharedControllers()`. Each player's sub-workers
 * (Start/Preparation/Play/TrackEnd/Skip), lifecycle-abort signal and bus subscriptions live
 * in an internal `Map<playerId, OrchestratorWorker>` (opened by `attach(playerId, ...)`,
 * released by `detach(playerId)`). `onAction`, `playback.start`, `playback.prepareAutoplay`,
 * `playback.createRelatedTracks`, `play` and `playback.transitionLock` are all registered
 * exactly once, in the constructor, and route to the right worker via `ctx.playerId` /
 * `context.playerId`.
 *
 * `PlaybackSeekController` needs no per-player state (it only reads the shared
 * `PlaybackSessionController` and the `playerId` passed on every call), so a single instance
 * is shared by every worker instead of being recreated per player.
 */
export class PlaybackOrchestrator {
	private readonly bus: Bus;
	private readonly workers = new Map<string, OrchestratorWorker>();
	private readonly sessionController: PlaybackSessionController;
	private readonly seekController: PlaybackSeekController;
	private readonly detachAction: () => void;
	private defaultPlayerId?: string;

	constructor(bus: Bus, options: PlaybackOrchestratorOptions);
	constructor(playerId: string, bus: Bus, options: PlaybackOrchestratorOptions);
	constructor(
		busOrPlayerId: Bus | string,
		optionsOrBus: PlaybackOrchestratorOptions | Bus,
		maybeOptions?: PlaybackOrchestratorOptions,
	) {
		const isLegacy = typeof busOrPlayerId === "string";
		const bus = (isLegacy ? optionsOrBus : busOrPlayerId) as Bus;
		const options = (isLegacy ? maybeOptions : optionsOrBus) as PlaybackOrchestratorOptions;
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
				return worker ? worker.startController.start(track, context, from) : Promise.resolve();
			},
		);
		bus.registerRpc<{ session: PlaybackSession; context: PlayerMessageContext }, Promise<Track | null>>(
			CONTROLLER_RPC.playbackPrepareAutoplay,
			({ session, context }, ctx) => {
				const worker = this.workers.get(ctx.playerId);
				return worker ? worker.preparationController.prepareAutoplay(session, context) : Promise.resolve(null);
			},
		);
		bus.registerRpc<{ track?: Track | null }, Promise<Track[]>>(CONTROLLER_RPC.playbackCreateRelatedTracks, ({ track }, ctx) => {
			const worker = this.workers.get(ctx.playerId);
			return worker ? worker.preparationController.createRelatedTracks(track) : Promise.resolve([]);
		});
		bus.registerRpc<{ query: import("../types").SearchResult | Track | string | null; requestedBy?: string }, boolean>(
			CONTROLLER_RPC.play,
			(request, context) => {
				const worker = this.workers.get(context.playerId);
				if (!worker) return Promise.resolve(false);
				return worker.playController.play(request.query, request.requestedBy, context);
			},
		);
		bus.registerRpc<{ active: boolean }, void>(CONTROLLER_RPC.playbackTransitionLock, ({ active }, ctx) =>
			this.workers.get(ctx.playerId)?.trackEndController.setTrackEndTransition(active),
		);

		if (isLegacy && typeof busOrPlayerId === "string") {
			this.defaultPlayerId = busOrPlayerId;
			this.attach(busOrPlayerId);
		}
	}

	// ---------------------------------------------------------------------
	// Per-player lifecycle
	// ---------------------------------------------------------------------

	/** Opens a worker for `playerId`. Re-attaching replaces (and releases) the old worker. */
	public attach(playerId: string, options: PlaybackOrchestratorAttachOptions = {}): void {
		if (this.workers.has(playerId)) this.detach(playerId);
		const lifecycleAbort = new AbortController();
		const debug = options.debug ?? (() => undefined);
		const adapters = options.adapters;

		const preparationController = new PlaybackPreparationController(playerId, {
			bus: this.bus,
			isCurrentSession: (session, context) => this.matchesContext(session, context),
			queueSnapshot: () => this.queueSnapshot(playerId),
			setQueueRelated: (tracks) => this.setQueueRelated(playerId, tracks),
		});
		const startController = new PlaybackStartController(playerId, {
			bus: this.bus,
			sessionController: this.sessionController,
			transitionEnabled: () => this.transitionEnabled(playerId),
			stopPlayback: (signal, cancelPreload) => this.stopPlayback(playerId, signal, cancelPreload),
			prepareTrack: (session, context) => preparationController.prepareTrack(session, context),
			adapters,
		});
		const trackEndController = new PlaybackTrackEndController(playerId, {
			bus: this.bus,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(playerId, signal),
			publishState: () => this.publishState(playerId),
			queueSnapshot: () => this.queueSnapshot(playerId),
			lifecycleSignal: lifecycleAbort.signal,
		});
		const skipController = new PlaybackSkipController({
			bus: this.bus,
			playerId,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(playerId, ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(playerId, signal),
			publishState: () => this.publishState(playerId),
			setWaitingForQueue: (waiting) => trackEndController.setWaitingForQueue(waiting),
		});
		const playController = new PlaybackPlayController(playerId, {
			bus: this.bus,
			isWaitingForQueue: () => trackEndController.isWaitingForQueue,
			debug,
			lifecycleSignal: lifecycleAbort.signal,
			adapters,
		});

		const detachTrackEnd = this.bus.subscribe(playerId, "TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			const current = this.sessionController.current(playerId);
			if (!current || current.id !== session.id) return;
			void trackEndController.onTrackEnd(session);
		});
		const detachQueueEnd = this.bus.subscribe(playerId, "queueEnd", () => trackEndController.onQueueEnd());
		const detachQueueChanged = this.bus.subscribe(playerId, "queueChanged", () => trackEndController.onQueueChanged());

		this.workers.set(playerId, {
			playerId,
			lifecycleAbort,
			debug,
			adapters,
			preparationController,
			startController,
			skipController,
			trackEndController,
			playController,
			detachTrackEnd,
			detachQueueEnd,
			detachQueueChanged,
			disposed: false,
		});
	}

	/** Releases `playerId`'s worker: aborts its lifecycle signal, drops bus subscriptions and clears its session. */
	public detach(playerId: string): void {
		const worker = this.workers.get(playerId);
		if (!worker) return;
		this.workers.delete(playerId);
		worker.disposed = true;
		worker.lifecycleAbort.abort();
		worker.detachTrackEnd();
		worker.detachQueueEnd();
		worker.detachQueueChanged();
		this.sessionController.clear(playerId);
		worker.trackEndController.dispose();
		worker.playController.dispose();
		worker.preparationController.dispose();
		worker.startController.dispose();
	}

	/** Global shutdown: releases every player's worker and the shared `onAction` subscription. */
	public dispose(): void {
		for (const playerId of [...this.workers.keys()]) this.detach(playerId);
		this.detachAction();
	}

	public has(playerId: string): boolean {
		return this.workers.has(playerId);
	}

	public get currentSession(): PlaybackSession | null {
		const id = this.defaultPlayerId ?? this.workers.keys().next().value;
		return id ? this.sessionController.current(id) : null;
	}

	public getCurrentSession(playerId: string): PlaybackSession | null {
		return this.sessionController.current(playerId);
	}

	public get transitionPolicy() {
		const id = this.defaultPlayerId ?? this.workers.keys().next().value;
		return id ? this.bus.querySync(id, "transitionSettings") : undefined;
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

	private async handleAction(worker: OrchestratorWorker, a: PlayerAction, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const playerId = worker.playerId;
		switch (a.type) {
			case "PLAY":
				if (a.track) await worker.startController.start(a.track, context);
				break;
			case "SEEK":
				await this.seekController.seek(a.position, context);
				break;
			case "SKIP":
				await worker.skipController.skip(context);
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
