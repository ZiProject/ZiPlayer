import { AudioPlayerStatus } from "@discordjs/voice";
import { createPlayerRequestId, type Bus } from "../structures/Bus";
import { BUS_EVENT, BUS_OUTPUT, BUS_REQUEST, PLAYER_ACTION, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";
import { PlaybackMode, type LifecycleControllerOptions } from "../types";

/** Per-player idle/leave policy worker, owned by the shared `LifecycleController` below. */
class LifecycleWorker {
	private readonly leaveOnEnd: boolean;
	private readonly leaveOnEmpty: boolean;
	private readonly pauseOnEmpty: boolean;
	private readonly leaveTimeout: number;
	private readonly debug?: (...args: any[]) => void;
	private leaveTimer: NodeJS.Timeout | null = null;
	private voiceEmptyTimer: NodeJS.Timeout | null = null;
	private voiceChannel: any = null;
	private voiceStateClient: any = null;
	private voiceStateListener: ((oldState: any, newState: any) => void) | null = null;
	private autoPaused = false;
	private pauseTransition: Promise<void> = Promise.resolve();
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
		this.pauseOnEmpty = options.pauseOnEmpty ?? false;
		this.leaveTimeout = Math.max(0, options.leaveTimeout ?? 100000);
		this.debug = debug;

		this.unsubscribe.push(
			this.bus.subscribe(this.playerId, BUS_EVENT.trackStarted, () => {
				this.isPlaying = true;
				this.clearLeaveTimeout();
			}),
			this.bus.subscribe(this.playerId, BUS_EVENT.trackLoading, () => this.clearLeaveTimeout()),
			this.bus.subscribe(this.playerId, BUS_EVENT.trackRequested, () => this.clearLeaveTimeout()),
			this.bus.subscribe(this.playerId, BUS_EVENT.stateChanged, (_event) => {
				const status = _event.newState.status;
				this.isPlaying = status === AudioPlayerStatus.Playing;
				if (status !== AudioPlayerStatus.Idle) this.clearLeaveTimeout();
			}),
			this.bus.subscribe(this.playerId, BUS_EVENT.trackEnd, () => {
				this.isPlaying = false;
			}),
			this.bus.subscribe(this.playerId, BUS_EVENT.queueEnd, () => {
				if (this.leaveOnEnd) this.scheduleLeave("queue-end");
			}),
			this.bus.subscribe(this.playerId, BUS_EVENT.forwardModeStart, () => {
				this.clearLeaveTimeout();
				this.clearVoiceEmptyTimeout();
				this.debug?.("[LifecycleController] clearing leave timer: forward mode started");
			}),
			this.bus.subscribe(this.playerId, BUS_EVENT.forwardModeEnd, () => this.updateVoiceEmptyTimeout()),
			this.bus.onOutput(BUS_OUTPUT.connectionConnected, (event) => {
				if (event.playerId !== this.playerId) return;
				this.clearLeaveTimeout();
				this.watchVoiceChannel(event.channel);
			}),
			this.bus.onOutput(BUS_OUTPUT.connectionConnecting, (event) => {
				if (event.playerId !== this.playerId) return;
				this.clearLeaveTimeout();
				this.stopWatchingVoiceChannel();
			}),
			this.bus.onOutput(BUS_OUTPUT.connectionDisconnected, (event) => {
				if (event.playerId === this.playerId) this.stopWatchingVoiceChannel();
			}),
		);
	}

	private watchVoiceChannel(channel: any): void {
		this.stopWatchingVoiceChannel();
		if (!this.leaveOnEmpty && !this.pauseOnEmpty) return;
		const client = channel?.guild?.client;
		if (typeof client?.on !== "function") return;

		this.voiceChannel = channel;
		this.voiceStateClient = client;
		this.voiceStateListener = (oldState, newState) => {
			if (oldState?.guild?.id !== channel.guildId && newState?.guild?.id !== channel.guildId) return;
			if (oldState?.channelId !== channel.id && newState?.channelId !== channel.id) return;
			this.updateVoiceEmptyTimeout();
		};
		client.on("voiceStateUpdate", this.voiceStateListener);
		this.updateVoiceEmptyTimeout();
	}

	private stopWatchingVoiceChannel(): void {
		this.clearVoiceEmptyTimeout();
		if (this.voiceStateClient && this.voiceStateListener) {
			this.voiceStateClient.off?.("voiceStateUpdate", this.voiceStateListener);
			this.voiceStateClient.removeListener?.("voiceStateUpdate", this.voiceStateListener);
		}
		this.voiceChannel = null;
		this.voiceStateClient = null;
		this.voiceStateListener = null;
	}

	private updateVoiceEmptyTimeout(): void {
		const hasHuman = this.hasHumanVoiceMember();
		if (hasHuman === null) return;
		this.reconcilePauseOnEmpty();
		if (hasHuman) {
			this.clearVoiceEmptyTimeout();
			return;
		}
		this.clearVoiceEmptyTimeout();
		if (!this.leaveOnEmpty || this.leaveTimeout <= 0 || this.isForward()) return;
		this.debug?.(`[LifecycleController] scheduling voice-empty leave in ${this.leaveTimeout}ms`);
		this.voiceEmptyTimer = setTimeout(() => {
			this.voiceEmptyTimer = null;
			if (this.disposed || this.isForward()) return;
			if (this.hasHumanVoiceMember() !== false) return;
			void this.disconnect("leave-timeout");
		}, this.leaveTimeout);
	}

	private hasHumanVoiceMember(): boolean | null {
		const members = this.voiceChannel?.members;
		if (!members || typeof members.values !== "function") return null;
		return Array.from(members.values()).some((member: any) => !member.user?.bot);
	}

	private isPlaybackPaused(): boolean {
		if (this.bus.querySync(this.playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.REMOTE) {
			return this.bus.querySync(this.playerId, PLAYER_QUERY.remotePaused) ?? false;
		}
		return this.bus.querySync(this.playerId, PLAYER_QUERY.isPaused);
	}

	private isPlaybackActive(): boolean {
		if (this.bus.querySync(this.playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.REMOTE) {
			return Boolean(this.bus.querySync(this.playerId, PLAYER_QUERY.currentTrack)) && !this.isPlaybackPaused();
		}
		return this.bus.querySync(this.playerId, PLAYER_QUERY.isPlaying);
	}

	private reconcilePauseOnEmpty(): void {
		if (!this.pauseOnEmpty) return;
		this.pauseTransition = this.pauseTransition
			.then(async () => {
				if (this.disposed || this.isForward()) return;
				const hasHuman = this.hasHumanVoiceMember();
				if (hasHuman === null) return;

				if (!hasHuman) {
					if (this.autoPaused || !this.isPlaybackActive() || this.isPlaybackPaused()) return;
					await this.bus.action(this.playerId, { type: PLAYER_ACTION.pause });
					this.autoPaused = this.isPlaybackPaused();
					return;
				}

				if (!this.autoPaused) return;
				this.autoPaused = false;
				if (this.isPlaybackPaused()) {
					await this.bus.action(this.playerId, { type: PLAYER_ACTION.resume });
				}
			})
			.catch((error) => this.debug?.("[LifecycleController] pauseOnEmpty action failed:", error));
	}

	private clearVoiceEmptyTimeout(): void {
		if (!this.voiceEmptyTimer) return;
		clearTimeout(this.voiceEmptyTimer);
		this.voiceEmptyTimer = null;
	}

	private isForward(): boolean {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.FORWARD;
	}

	scheduleLeave(reason: "queue-end" | "queue-empty" | "track-end" | "manual" = "manual"): void {
		if (this.disposed) return;
		this.clearLeaveTimeout();
		if (this.leaveTimeout <= 0) {
			this.debug?.(`[LifecycleController] leaveTimeout is 0 (disabled), not scheduling leave (${reason})`);
			return;
		}
		if (this.isForward()) {
			this.debug?.(`[LifecycleController] ignoring leave (${reason}): forward mode`);
			return;
		}
		if (this.isPlaying) {
			this.debug?.(`[LifecycleController] ignoring leave (${reason}) while playback is active`);
			return;
		}
		this.debug?.(`[LifecycleController] scheduling leave in ${this.leaveTimeout}ms (${reason})`);
		this.leaveTimer = setTimeout(() => {
			this.leaveTimer = null;
			if (this.isForward()) {
				this.debug?.(`[LifecycleController] cancelling leave (${reason}): forward mode active`);
				return;
			}
			const queue = this.bus.querySync(this.playerId, PLAYER_QUERY.queue) ?? [];
			if (this.isPlaying || queue.length > 0) {
				this.debug?.(`[LifecycleController] cancelling leave (${reason}): player is playing or has queued tracks`);
				return;
			}
			void this.disconnect("leave-timeout");
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
		this.stopWatchingVoiceChannel();
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
	}

	private async disconnect(reason: string): Promise<void> {
		if (this.disposed) return;
		try {
			await this.bus.request(
				this.playerId,
				{ type: BUS_REQUEST.connectionDisconnect, requestId: createPlayerRequestId(), reason },
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
		bus.registerRpc<{ reason?: "track-end" | "queue-empty" | "manual" }, void>(
			PLAYER_RPC.lifecycleScheduleLeave,
			({ reason }, ctx) => this.workers.get(ctx.playerId)?.scheduleLeave(reason),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.lifecycleClearLeaveTimeout, (_req, ctx) =>
			this.workers.get(ctx.playerId)?.clearLeaveTimeout(),
		);
	}

	attach(playerId: string, options: LifecycleControllerOptions["options"], debug?: (...args: any[]) => void): void {
		if (this.workers.has(playerId)) this.detach(playerId);
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
