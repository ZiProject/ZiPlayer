import type { PlayerBus, PlayerAction } from "./PlayerBus";
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
	private readonly preparationController: PlaybackPreparationController;
	private readonly startController: PlaybackStartController;
	private readonly seekController: PlaybackSeekController;
	private readonly skipController: PlaybackSkipController;
	private readonly trackEndController: PlaybackTrackEndController;
	private readonly playController: PlaybackPlayController;

	constructor(
		private readonly bus: PlayerBus,
		options: PlaybackOrchestratorOptions = {},
	) {
		this.debug = options.debug ?? (() => undefined);
		this.sessionController = options.sessionController ?? new PlaybackSessionController(bus);
		this.preparationController = new PlaybackPreparationController({
			bus,
			isCurrentSession: (session, context) => this.matchesContext(session, context),
			queueSnapshot: () => this.queueSnapshot(),
			setQueueRelated: (tracks) => this.setQueueRelated(tracks),
		});
		this.startController = new PlaybackStartController({
			bus,
			sessionController: this.sessionController,
			transitionEnabled: () => this.transitionEnabled(),
			stopPlayback: (signal, cancelPreload) => this.stopPlayback(signal, cancelPreload),
			prepareTrack: (session, context) => this.preparationController.prepareTrack(session, context),
		});
		this.seekController = new PlaybackSeekController(bus, this.sessionController);
		this.trackEndController = new PlaybackTrackEndController({
			bus,
			sessionController: this.sessionController,
			preparationController: this.preparationController,
			startController: this.startController,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(signal),
			publishState: () => this.publishState(),
			queueSnapshot: () => this.queueSnapshot(),
			lifecycleSignal: this.lifecycleAbort.signal,
		});
		this.skipController = new PlaybackSkipController({
			bus,
			sessionController: this.sessionController,
			preparationController: this.preparationController,
			startController: this.startController,
			nextThroughBus: (ignoreLoop, context) => this.nextThroughBus(ignoreLoop, context),
			stopPlayback: (signal) => this.stopPlayback(signal),
			publishState: () => this.publishState(),
			setWaitingForQueue: (waiting) => this.trackEndController.setWaitingForQueue(waiting),
			setTrackEndTransition: () => undefined,
		});
		this.playController = new PlaybackPlayController({
			bus,
			sessionController: this.sessionController,
			skipController: this.skipController,
			isWaitingForQueue: () => this.trackEndController.isWaitingForQueue,
			debug: this.debug,
			lifecycleSignal: this.lifecycleAbort.signal,
		});
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c));
		this.detachTrackEnd = bus.subscribe("TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			if (!this.sessionController.current || this.sessionController.current.id !== session.id) return;
			void this.trackEndController.onTrackEnd(session);
		});
		this.detachQueueEnd = bus.subscribe("queueEnd", () => {
			this.trackEndController.onQueueEnd();
		});
		this.detachQueueChanged = bus.subscribe("queueChanged", () => {
			this.trackEndController.onQueueChanged();
		});
		this.detachRpcs.push();
	}

	get currentSession() {
		return this.sessionController.current;
	}

	get transitionPolicy() {
		return this.bus.querySync("transitionSettings");
	}

	private transitionEnabled(): boolean {
		const settings = this.bus.querySync("transitionSettings");
		return !!settings && settings.enabled !== false;
	}

	private isCurrentSession(sessionId: number): boolean {
		return !!this.sessionController.current && this.sessionController.current.owns(sessionId);
	}

	private queueSnapshot(): Track[] {
		return this.bus.querySync("queue") ?? [];
	}

	private queueState(): any {
		return this.bus.querySync("queueSerialized");
	}

	private setQueueRelated(tracks: Track[]): void {
		const state = this.queueState();
		if (!state || typeof state !== "object") return;
		state.relatedTracks = tracks;
		this.bus.requestRpcSync("queue.restore", { state });
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
		this.sessionController.clear();
		this.trackEndController.dispose();
		this.playController.dispose();
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
				const session = this.sessionController.current;
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(CONTROLLER_RPC.playbackPause, {})
				) {
					session.markPaused();
					this.publishState();
					this.bus.event({ type: "playerPause", track: session.track });
				}
				break;
			}
			case "RESUME": {
				const session = this.sessionController.current;
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(CONTROLLER_RPC.playbackResume, {})
				) {
					session.markPlaying();
					this.publishState();
					this.bus.event({ type: "playerResume", track: session.track });
				}
				break;
			}
			case "STOP": {
				const session = this.sessionController.current;
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(context.signal);
				if (session?.isActive()) session.markStopped();
				this.publishState();
				this.bus.event({ type: "playerStop" });
				break;
			}
		}
	}

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return session.ownsContext(context.sessionId);
	}

	private stopPlayback(_s: AbortSignal, cancelPreload = true): void {
		this.bus.requestRpcSync(CONTROLLER_RPC.playbackStop, {});
		if (cancelPreload) this.bus.requestRpcSync("preload.cancel", {});
	}

	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		const previousCurrent = this.bus.querySync("queueCurrent") ?? null;
		await this.bus.action({ type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		const next = await this.bus.query("queueCurrent");
		if (context.signal.aborted) {
			await this.bus.requestRpc("queue.restoreNext", { previousCurrent, nextTrack: next });
			return null;
		}
		return next;
	}

	private publishState(): void {
		this.bus.event({ type: "playbackStateChanged", session: this.sessionController.current?.snapshot() ?? null });
	}
}
