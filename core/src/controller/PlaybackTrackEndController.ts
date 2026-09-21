import { createPlayerRequestId } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, PlaybackSessionSnapshot, Track } from "../types";
import type { Bus } from "../structures/Bus";
import type { PlaybackTrackEndControllerOptions } from "../types";
import { PlayerActionPriority } from "../types";
import { CONTROLLER_RPC } from "../structures/BusContract";

/**
 * Owns TRACK_END, queue refill, autoplay fallback, and queue-end transitions.
 * Talks to sibling playback controllers only through Bus queries/RPCs —
 * never by holding a direct reference to them.
 *
 * Per-player worker — created by the shared `PlaybackOrchestrator` in `attach(playerId, ...)`
 * and discarded in `detach(playerId)`. Registers no RPC of its own: `playback.transitionLock`
 * is registered exactly once, in `PlaybackOrchestrator`'s constructor, and routed to the
 * right worker via `ctx.playerId`.
 */
export class PlaybackTrackEndController {
	private readonly playerId: string;
	private readonly bus: Bus;
	private readonly nextThroughBus: PlaybackTrackEndControllerOptions["nextThroughBus"];
	private readonly stopPlayback: PlaybackTrackEndControllerOptions["stopPlayback"];
	private readonly publishState: PlaybackTrackEndControllerOptions["publishState"];
	private readonly queueSnapshot: PlaybackTrackEndControllerOptions["queueSnapshot"];
	private readonly lifecycleSignal: AbortSignal;
	private trackEndTransition = false;
	private waitingForQueue = false;
	private queueStartPromise: Promise<void> | null = null;
	private queueStartGeneration = 0;
	private readonly detachRpcs: Array<() => void> = [];

	public constructor(playerId: string, options: PlaybackTrackEndControllerOptions) {
		this.playerId = playerId;
		this.bus = options.bus;
		this.nextThroughBus = options.nextThroughBus;
		this.stopPlayback = options.stopPlayback;
		this.publishState = options.publishState;
		this.queueSnapshot = options.queueSnapshot;
		this.lifecycleSignal = options.lifecycleSignal;
	}

	private currentSession(): PlaybackSession | null {
		return this.bus.querySync(this.playerId, "playbackSessionInternal") ?? null;
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

	public setTrackEndTransition(active: boolean): void {
		if (!this.lifecycleSignal.aborted) this.trackEndTransition = active;
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
		const current = this.currentSession();
		if (!current || current.id !== snapshot.id || current.status === "ended" || current.status === "stopped") return;
		if (this.trackEndTransition) return;
		this.trackEndTransition = true;
		try {
			if (!current.isActive()) return;
			const from = current.track;
			const endedSession = current;
			const context = this.createContext("PlaybackTrackEndController:track-end");
			let next = await this.nextThroughBus(false, context);
			if (next) {
				endedSession.markEnded();
				this.waitingForQueue = false;
				await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackStart, { track: next, context, from });
				return;
			}
			if (this.bus.querySync(this.playerId, "queueAutoPlay")) {
				const candidate = await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackPrepareAutoplay, {
					session: endedSession,
					context,
				});
				const stillCurrent = this.currentSession();
				if (candidate && stillCurrent?.id === snapshot.id && stillCurrent.isActive()) {
					endedSession.markEnded();
					this.bus.requestRpcSync(this.playerId, "queue.willNext", { track: null });
					if (!this.bus.querySync(this.playerId, "queueNextTrack"))
						this.bus.requestRpcSync(this.playerId, "queue.addMultiple", { tracks: [candidate] });
					next = await this.nextThroughBus(false, context);
					if (next) {
						this.waitingForQueue = false;
						await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackStart, { track: next, context, from });
						return;
					}
				}
			}
			const finalSession = this.currentSession();
			if (!finalSession || finalSession.id !== snapshot.id || !finalSession.isActive()) return;
			endedSession.markEnded();
			this.stopPlayback(context.signal);
			this.publishState();
			this.waitingForQueue = true;
			this.bus.event(this.playerId, { type: "queueEnd" });
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
			const from = this.currentSession()?.track ?? null;
			const context = this.createContext("PlaybackTrackEndController:queue-refill");
			const next = await this.nextThroughBus(false, context);
			if (!next || context.signal.aborted) return;
			this.waitingForQueue = false;
			await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackStart, { track: next, context, from });
		} finally {
			this.trackEndTransition = false;
		}
	}

	private createContext(source: string): PlayerMessageContext {
		return {
			playerId: this.playerId,
			requestId: createPlayerRequestId(),
			source,
			signal: this.lifecycleSignal,
			timestamp: Date.now(),
			priority: PlayerActionPriority.NORMAL,
		};
	}
}
