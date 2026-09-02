import { AudioPlayerStatus } from "@discordjs/voice";
import { createPlayerRequestId, type PlayerBus } from "../structures/PlayerBus";
import type { PlayerOptions } from "../types";

export interface LifecycleControllerOptions {
	bus: PlayerBus;
	options: Pick<PlayerOptions, "leaveOnEnd" | "leaveOnEmpty" | "leaveTimeout">;
	debug?: (...args: any[]) => void;
}

/** Owns idle/leave policy and lifecycle cleanup outside the Player facade. */
export class LifecycleController {
	private readonly bus: PlayerBus;
	private readonly leaveOnEnd: boolean;
	private readonly leaveOnEmpty: boolean;
	private readonly leaveTimeout: number;
	private readonly debug?: (...args: any[]) => void;
	private leaveTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	private isPlaying = false;
	private unsubscribe: Array<() => void> = [];

	public constructor(options: LifecycleControllerOptions) {
		this.bus = options.bus;
		this.leaveOnEnd = options.options.leaveOnEnd ?? true;
		this.leaveOnEmpty = options.options.leaveOnEmpty ?? true;
		this.leaveTimeout = Math.max(0, options.options.leaveTimeout ?? 100000);
		this.debug = options.debug;

		this.unsubscribe.push(
			this.bus.subscribe("TRACK_STARTED", () => {
				this.isPlaying = true;
				this.clearLeaveTimeout();
			}),
			this.bus.subscribe("TRACK_LOADING", () => this.clearLeaveTimeout()),
			this.bus.subscribe("trackRequested", () => this.clearLeaveTimeout()),
			this.bus.subscribe("stateChanged", (_event) => {
				const status = _event.newState.status;
				this.isPlaying = status === AudioPlayerStatus.Playing;
				if (status !== AudioPlayerStatus.Idle) this.clearLeaveTimeout();
			}),
			this.bus.subscribe("TRACK_END", () => {
				this.isPlaying = false;
				if (this.leaveOnEnd) this.scheduleLeave("track-end");
			}),
			this.bus.subscribe("queueChanged", (event) => {
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

	public scheduleLeave(reason: "track-end" | "queue-empty" | "manual" = "manual"): void {
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

	public clearLeaveTimeout(): void {
		if (!this.leaveTimer) return;
		clearTimeout(this.leaveTimer);
		this.leaveTimer = null;
	}

	public async leave(reason = "manual"): Promise<void> {
		if (this.disposed) return;
		this.clearLeaveTimeout();
		await this.disconnect(reason);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearLeaveTimeout();
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
	}

	private async disconnect(reason: string): Promise<void> {
		if (this.disposed) return;
		try {
			await this.bus.request(
				{
					type: "[Player]->[Connection]:disconnect",
					requestId: createPlayerRequestId(),
					reason,
				},
				{ timeoutMs: Math.max(5000, this.leaveTimeout || 5000) },
			);
		} catch (error) {
			this.debug?.(`[LifecycleController] disconnect failed:`, error);
		}
	}
}
