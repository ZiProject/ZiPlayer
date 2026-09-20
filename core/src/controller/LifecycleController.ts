import { AudioPlayerStatus } from "@discordjs/voice";
import { createPlayerRequestId, type Bus } from "../structures/Bus";
import type { LifecycleControllerOptions } from "../types";

/** Per-player idle/leave policy worker, owned by the shared `LifecycleController` below. */
class LifecycleWorker {
	private readonly leaveOnEnd: boolean;
	private readonly leaveOnEmpty: boolean;
	private readonly leaveTimeout: number;
	private readonly debug?: (...args: any[]) => void;
	private leaveTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	private isPlaying = false;
	private readonly unsubscribe: Array<() => void> = [];

	constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
		options: LifecycleControllerOptions["options"],
		debug?: (...args: any[]) => void,
	) {
		this.leaveOnEnd = options.leaveOnEnd ?? true;
		this.leaveOnEmpty = options.leaveOnEmpty ?? true;
		this.leaveTimeout = Math.max(0, options.leaveTimeout ?? 100000);
		this.debug = debug;

		this.unsubscribe.push(
			this.bus.subscribe(this.playerId, "TRACK_STARTED", () => {
				this.isPlaying = true;
				this.clearLeaveTimeout();
			}),
			this.bus.subscribe(this.playerId, "TRACK_LOADING", () => this.clearLeaveTimeout()),
			this.bus.subscribe(this.playerId, "trackRequested", () => this.clearLeaveTimeout()),
			this.bus.subscribe(this.playerId, "stateChanged", (_event) => {
				const status = _event.newState.status;
				this.isPlaying = status === AudioPlayerStatus.Playing;
				if (status !== AudioPlayerStatus.Idle) this.clearLeaveTimeout();
			}),
			this.bus.subscribe(this.playerId, "TRACK_END", () => {
				this.isPlaying = false;
				if (this.leaveOnEnd) this.scheduleLeave("track-end");
			}),
			this.bus.subscribe(this.playerId, "queueChanged", (event) => {
				// An empty queue is not equivalent to an idle player: the current
				// track may still be playing after the queue has been consumed.
				if (this.leaveOnEmpty && event.queue.length === 0) {
					if (this.isPlaying) {
						this.clearLeaveTimeout();
						this.debug?.(`[LifecycleController] keeping connection: queue-empty while playing`);
						return;
					}
					this.scheduleLeave("queue-empty");
				} else if (event.queue.length > 0) this.clearLeaveTimeout();
			}),
			this.bus.onOutput("[Connection]->[Player]:connected", () => this.clearLeaveTimeout()),
			this.bus.onOutput("[Connection]->[Player]:connecting", () => this.clearLeaveTimeout()),
		);
	}

	scheduleLeave(reason: "track-end" | "queue-empty" | "manual" = "manual"): void {
		if (this.disposed) return;
		this.clearLeaveTimeout();
		if (reason === "queue-empty" && this.isPlaying) {
			this.debug?.(`[LifecycleController] ignoring leave (${reason}) while playback is active`);
			return;
		}
		if (this.leaveTimeout === 0) {
			void this.disconnect(reason);
			return;
		}
		this.debug?.(`[LifecycleController] scheduling leave in ${this.leaveTimeout}ms (${reason})`);
		this.leaveTimer = setTimeout(() => {
			this.leaveTimer = null;
			// Playback may have started after the queue-empty event and before
			// the timeout fired. Re-check the lifecycle condition at the edge.
			if (reason === "queue-empty" && this.isPlaying) {
				this.debug?.(`[LifecycleController] cancelling leave (${reason}): playback is active`);
				return;
			}
			void this.disconnect(reason);
		}, this.leaveTimeout);
	}

	clearLeaveTimeout(): void {
		if (!this.leaveTimer) return;
		clearTimeout(this.leaveTimer);
		this.leaveTimer = null;
	}

	async leave(reason = "manual"): Promise<void> {
		if (this.disposed) return;
		this.clearLeaveTimeout();
		await this.disconnect(reason);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearLeaveTimeout();
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
	}

	private async disconnect(reason: string): Promise<void> {
		if (this.disposed) return;
		try {
			await this.bus.request(
				this.playerId,
				{ type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId(), reason },
				{ timeoutMs: Math.max(5000, this.leaveTimeout || 5000) },
			);
		} catch (error) {
			this.debug?.(`[LifecycleController] disconnect failed:`, error);
		}
	}
}

/** Shared, singleton controller: owns idle/leave policy and lifecycle cleanup outside
 *  the Player facade, keyed by playerId. */
export class LifecycleController {
	private readonly workers = new Map<string, LifecycleWorker>();

	public constructor(private readonly bus: Bus) {
		bus.registerRpc<{ reason?: "track-end" | "queue-empty" | "manual" }, void>("lifecycle.scheduleLeave", ({ reason }, ctx) =>
			this.workers.get(ctx.playerId)?.scheduleLeave(reason),
		);
		bus.registerRpc<void, void>("lifecycle.clearLeaveTimeout", (_req, ctx) =>
			this.workers.get(ctx.playerId)?.clearLeaveTimeout(),
		);
	}

	attach(playerId: string, options: LifecycleControllerOptions["options"], debug?: (...args: any[]) => void): void {
		this.workers.set(playerId, new LifecycleWorker(this.bus, playerId, options, debug));
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}

	public scheduleLeave(playerId: string, reason: "track-end" | "queue-empty" | "manual" = "manual"): void {
		this.workers.get(playerId)?.scheduleLeave(reason);
	}
	public clearLeaveTimeout(playerId: string): void {
		this.workers.get(playerId)?.clearLeaveTimeout();
	}
	public async leave(playerId: string, reason = "manual"): Promise<void> {
		await this.workers.get(playerId)?.leave(reason);
	}
}
