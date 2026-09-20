import type { Bus, PlayerAction } from "./Bus";
import { PlaybackSession } from "./PlaybackSession";
import { PlaybackSessionController } from "../controller/PlaybackSessionController";
import type { PlayerMessageContext, Track, PlaybackOrchestratorOptions } from "../types";
import { CONTROLLER_RPC } from "../controller/ControllerBusContract";
import { PlaybackStartController } from "../controller/PlaybackStartController";
import { PlaybackPreparationController } from "../controller/PlaybackPreparationController";
import { PlaybackSeekController } from "../controller/PlaybackSeekController";
import { PlaybackSkipController } from "../controller/PlaybackSkipController";
import { PlaybackTrackEndController } from "../controller/PlaybackTrackEndController";
import { PlaybackPlayController } from "../controller/PlaybackPlayController";

export class PlaybackOrchestrator {
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	private readonly sessionController: PlaybackSessionController;
	private readonly detachAction: () => void;
	private readonly detachTrackEnd: () => void;
	private readonly detachQueueChanged: () => void;
	private readonly detachQueueEnd: () => void;
	private readonly detachRpcs: Array<() => void> = [];
	private readonly debug: (message?: any, ...optionalParams: any[]) => void;
	private readonly adapters: PlaybackOrchestratorOptions["adapters"];
	private readonly preparationController: PlaybackPreparationController;
	private readonly startController: PlaybackStartController;
	private readonly seekController: PlaybackSeekController;
	private readonly skipController: PlaybackSkipController;
	private readonly trackEndController: PlaybackTrackEndController;
	private readonly playController: PlaybackPlayController;

	constructor(
		private readonly playerId: string,
		private readonly bus: Bus,
		options: PlaybackOrchestratorOptions & { sessionController: PlaybackSessionController },
	) {
		this.debug = options.debug ?? (() => undefined);
		this.adapters = options.adapters;
		this.sessionController = options.sessionController;
		this.preparationController = new PlaybackPreparationController(playerId, {
			bus,
			isCurrentSession: (session, context) => this.matchesContext(session, context),
			queueSnapshot: () => this.queueSnapshot(),
			setQueueRelated: (tracks) => this.setQueueRelated(tracks),
		});
		this.startController = new PlaybackStartController(playerId, {
			bus,
			sessionController: this.sessionController,
			transitionEnabled: () => this.transitionEnabled(),
			stopPlayback: (signal, cancelPreload) => this.stopPlayback(signal, cancelPreload),
			prepareTrack: (session, context) => this.preparationController.prepareTrack(session, context),
			adapters: this.adapters,
		});
		this.seekController = new PlaybackSeekController(bus, this.sessionController);
		this.trackEndController = new PlaybackTrackEndController(playerId, {
			bus,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(signal),
			publishState: () => this.publishState(),
			queueSnapshot: () => this.queueSnapshot(),
			lifecycleSignal: this.lifecycleAbort.signal,
		});
		this.skipController = new PlaybackSkipController({
			bus,
			playerId,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(signal),
			publishState: () => this.publishState(),
			setWaitingForQueue: (waiting) => this.trackEndController.setWaitingForQueue(waiting),
		});
		this.playController = new PlaybackPlayController(playerId, {
			bus,
			isWaitingForQueue: () => this.trackEndController.isWaitingForQueue,
			debug: this.debug,
			lifecycleSignal: this.lifecycleAbort.signal,
			adapters: this.adapters,
		});
		this.detachAction = bus.onAction((a, c) => {
			if (c.playerId === this.playerId) return this.handleAction(a, c);
		});
		this.detachTrackEnd = bus.subscribe(playerId, "TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			const current = this.sessionController.current(this.playerId);
			if (!current || current.id !== session.id) return;
			void this.trackEndController.onTrackEnd(session);
		});
		this.detachQueueEnd = bus.subscribe(playerId, "queueEnd", () => {
			this.trackEndController.onQueueEnd();
		});
		this.detachQueueChanged = bus.subscribe(playerId, "queueChanged", () => {
			this.trackEndController.onQueueChanged();
		});
		this.detachRpcs.push();
	}

	get currentSession() {
		return this.sessionController.current(this.playerId);
	}

	get transitionPolicy() {
		return this.bus.querySync(this.playerId, "transitionSettings");
	}

	private transitionEnabled(): boolean {
		const settings = this.bus.querySync(this.playerId, "transitionSettings");
		return !!settings && settings.enabled !== false;
	}

	private isCurrentSession(sessionId: number): boolean {
		const current = this.sessionController.current(this.playerId);
		return !!current && current.owns(sessionId);
	}

	private queueSnapshot(): Track[] {
		return this.bus.querySync(this.playerId, "queue") ?? [];
	}

	private queueState(): any {
		return this.bus.querySync(this.playerId, "queueSerialized");
	}

	private setQueueRelated(tracks: Track[]): void {
		const state = this.queueState();
		if (!state || typeof state !== "object") return;
		state.relatedTracks = tracks;
		this.bus.requestRpcSync(this.playerId, "queue.restore", { state });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.detachAction();
		this.detachTrackEnd();
		this.detachQueueChanged();
		this.detachQueueEnd();
		for (const d of this.detachRpcs.splice(0)) d();
		this.sessionController.clear(this.playerId);
		this.trackEndController.dispose();
		this.playController.dispose();
		this.preparationController.dispose();
		this.startController.dispose();
	}

	private async handleAction(a: PlayerAction, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		switch (a.type) {
			case "PLAY":
				if (a.track) await this.startController.start(a.track, context);
				break;
			case "SEEK":
				await this.seekController.seek(a.position, context);
				break;
			case "SKIP":
				await this.skipController.skip(context);
				break;
			case "PAUSE": {
				const session = this.sessionController.current(this.playerId);
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackPause, {})
				) {
					session.markPaused();
					this.publishState();
					this.bus.event(this.playerId, { type: "playerPause", track: session.track });
				}
				break;
			}
			case "RESUME": {
				const session = this.sessionController.current(this.playerId);
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackResume, {})
				) {
					session.markPlaying();
					this.publishState();
					this.bus.event(this.playerId, { type: "playerResume", track: session.track });
				}
				break;
			}
			case "STOP": {
				const session = this.sessionController.current(this.playerId);
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(context.signal);
				if (session?.isActive()) session.markStopped();
				this.publishState();
				this.bus.event(this.playerId, { type: "playerStop" });
				break;
			}
		}
	}

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return session.ownsContext(context.sessionId);
	}

	private stopPlayback(_s: AbortSignal, cancelPreload = true): void {
		this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackStop, {});
		if (!cancelPreload) return;
		if (this.bus.hasRpc("preload.cancel")) {
			this.bus.requestRpcSync(this.playerId, "preload.cancel", {});
		} else {
			this.adapters?.cancelPreload?.();
		}
	}

	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		const previousCurrent = this.bus.querySync(this.playerId, "queueCurrent") ?? null;
		await this.bus.action(this.playerId, { type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		const next = await this.bus.query(this.playerId, "queueCurrent");
		if (context.signal.aborted) {
			await this.bus.requestRpc(this.playerId, "queue.restoreNext", { previousCurrent, nextTrack: next });
			return null;
		}
		return next;
	}

	private publishState(): void {
		this.bus.event(this.playerId, {
			type: "playbackStateChanged",
			session: this.sessionController.current(this.playerId)?.snapshot() ?? null,
		});
	}
}
