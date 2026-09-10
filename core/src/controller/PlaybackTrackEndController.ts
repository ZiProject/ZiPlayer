import { createPlayerRequestId } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackPreparationController } from "./PlaybackPreparationController";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlaybackStartController } from "./PlaybackStartController";
import type { PlayerMessageContext, PlaybackSessionSnapshot, Track } from "../types";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackTrackEndControllerOptions } from "../types";
import { PlayerActionPriority } from "../types";

/** Owns TRACK_END, queue refill, autoplay fallback, and queue-end transitions. */
export class PlaybackTrackEndController {
	private readonly bus: PlayerBus;
	private readonly sessionController: PlaybackSessionController;
	private readonly preparationController: PlaybackPreparationController;
	private readonly startController: PlaybackStartController;
	private readonly nextThroughBus: PlaybackTrackEndControllerOptions["nextThroughBus"];
	private readonly stopPlayback: PlaybackTrackEndControllerOptions["stopPlayback"];
	private readonly publishState: PlaybackTrackEndControllerOptions["publishState"];
	private readonly queueSnapshot: PlaybackTrackEndControllerOptions["queueSnapshot"];
	private readonly lifecycleSignal: AbortSignal;
	private trackEndTransition = false;
	private waitingForQueue = false;
	private queueStartPromise: Promise<void> | null = null;
	private queueStartGeneration = 0;

	public constructor(options: PlaybackTrackEndControllerOptions) {
		this.bus = options.bus;
		this.sessionController = options.sessionController;
		this.preparationController = options.preparationController;
		this.startController = options.startController;
		this.nextThroughBus = options.nextThroughBus;
		this.stopPlayback = options.stopPlayback;
		this.publishState = options.publishState;
		this.queueSnapshot = options.queueSnapshot;
		this.lifecycleSignal = options.lifecycleSignal;
	}

	public get isTransitioning(): boolean {
		return this.trackEndTransition;
	}
	public get isWaitingForQueue(): boolean {
		return this.waitingForQueue;
	}

	public onQueueEnd(): void {
		if (!this.lifecycleSignal.aborted) this.waitingForQueue = true;
	}

	public setWaitingForQueue(waiting: boolean): void {
		if (!this.lifecycleSignal.aborted) this.waitingForQueue = waiting;
	}

	public async waitForQueue(signal: AbortSignal): Promise<void> {
		if (!this.queueStartPromise) return;
		await Promise.race([
			this.queueStartPromise,
			new Promise<void>((resolve) => {
				if (signal.aborted || this.lifecycleSignal.aborted) return resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
		]);
	}

	public onQueueChanged(): void {
		if (this.lifecycleSignal.aborted || !this.waitingForQueue || this.trackEndTransition || this.queueStartPromise) return;
		if (!this.queueSnapshot().length) return;
		const generation = ++this.queueStartGeneration;
		this.queueStartPromise = this.startQueuedTrackAfterEnd().finally(() => {
			if (generation === this.queueStartGeneration) this.queueStartPromise = null;
		});
	}

	public async onTrackEnd(snapshot: PlaybackSessionSnapshot): Promise<void> {
		if (
			!this.sessionController.current ||
			this.sessionController.current.id !== snapshot.id ||
			this.sessionController.current.status === "ended" ||
			this.sessionController.current.status === "stopped"
		)
			return;
		if (this.trackEndTransition) return;
		this.trackEndTransition = true;
		try {
			if (!this.sessionController.current || !this.sessionController.current.isActive()) return;
			const from = this.sessionController.current.track;
			const endedSession = this.sessionController.current;
			const context = this.createContext("PlaybackTrackEndController:track-end");
			let next = await this.nextThroughBus(false, context);
			if (next) {
				endedSession.markEnded();
				this.waitingForQueue = false;
				await this.startController.start(next, context, from);
				return;
			}
			if (this.bus.querySync("queueAutoPlay")) {
				const candidate = await this.preparationController.prepareAutoplay(endedSession, context);
				if (candidate && this.sessionController.current?.id === snapshot.id && this.sessionController.current.isActive()) {
					endedSession.markEnded();
					this.bus.requestRpcSync("queue.willNext", { track: null });
					if (!this.bus.querySync("queueNextTrack")) this.bus.requestRpcSync("queue.addMultiple", { tracks: [candidate] });
					next = await this.nextThroughBus(false, context);
					if (next) {
						this.waitingForQueue = false;
						await this.startController.start(next, context, from);
						return;
					}
				}
			}
			if (
				!this.sessionController.current ||
				this.sessionController.current.id !== snapshot.id ||
				!this.sessionController.current.isActive()
			)
				return;
			endedSession.markEnded();
			this.stopPlayback(context.signal);
			this.publishState();
			this.waitingForQueue = true;
			this.bus.event({ type: "queueEnd" });
		} finally {
			this.trackEndTransition = false;
		}
	}

	public dispose(): void {
		this.queueStartGeneration++;
		this.queueStartPromise = null;
		this.trackEndTransition = false;
		this.waitingForQueue = false;
	}

	private async startQueuedTrackAfterEnd(): Promise<void> {
		if (this.lifecycleSignal.aborted || !this.waitingForQueue || this.trackEndTransition || !this.queueSnapshot().length) return;
		this.trackEndTransition = true;
		try {
			const from = this.sessionController.current?.track ?? null;
			const context = this.createContext("PlaybackTrackEndController:queue-refill");
			const next = await this.nextThroughBus(false, context);
			if (!next || context.signal.aborted) return;
			this.waitingForQueue = false;
			await this.startController.start(next, context, from);
		} finally {
			this.trackEndTransition = false;
		}
	}

	private createContext(source: string): PlayerMessageContext {
		return {
			requestId: createPlayerRequestId(),
			source,
			signal: this.lifecycleSignal,
			timestamp: Date.now(),
			priority: PlayerActionPriority.NORMAL,
		};
	}
}
