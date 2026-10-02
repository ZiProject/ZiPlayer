import { AudioPlayerStatus } from "@discordjs/voice";
import { createPlayerRequestId, type Bus } from "../structures/Bus";
import { BUS_EVENT, BUS_OUTPUT, BUS_REQUEST, PLAYER_ACTION, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";
import { PlaybackMode, type LifecycleControllerOptions } from "../types";

interface LifecycleState {
	leaveOnEnd: boolean;
	leaveOnEmpty: boolean;
	pauseOnEmpty: boolean;
	leaveTimeout: number;
	debug?: (...args: any[]) => void;
	leaveTimer: NodeJS.Timeout | null;
	voiceEmptyTimer: NodeJS.Timeout | null;
	voiceChannel: any;
	voiceStateClient: any;
	voiceStateListener: ((oldState: any, newState: any) => void) | null;
	autoPaused: boolean;
	pauseTransition: Promise<void>;
	disposed: boolean;
	isPlaying: boolean;
	unsubscribe: Array<() => void>;
}

/** Shared lifecycle controller with timers and subscriptions partitioned by playerId. */
export class LifecycleController {
	public readonly states = new Map<string, LifecycleState>();

	public constructor(private readonly bus: Bus) {
		bus.registerRpc<{ reason?: "track-end" | "queue-empty" | "manual" }, void>(
			PLAYER_RPC.lifecycleScheduleLeave,
			({ reason }, ctx) => this.scheduleLeave(ctx.playerId, reason),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.lifecycleClearLeaveTimeout, (_req, ctx) => this.clearLeaveTimeout(ctx.playerId));
	}

	attach(playerId: string, options: LifecycleControllerOptions["options"], debug?: (...args: any[]) => void): void {
		this.detach(playerId);
		const state: LifecycleState = {
			leaveOnEnd: options.leaveOnEnd ?? true,
			leaveOnEmpty: options.leaveOnEmpty ?? true,
			pauseOnEmpty: options.pauseOnEmpty ?? false,
			leaveTimeout: Math.max(0, options.leaveTimeout ?? 100000),
			debug,
			leaveTimer: null,
			voiceEmptyTimer: null,
			voiceChannel: null,
			voiceStateClient: null,
			voiceStateListener: null,
			autoPaused: false,
			pauseTransition: Promise.resolve(),
			disposed: false,
			isPlaying: false,
			unsubscribe: [],
		};
		this.states.set(playerId, state);
		state.unsubscribe.push(
			this.bus.subscribe(playerId, BUS_EVENT.trackStarted, () => {
				state.isPlaying = true;
				this.clearLeaveTimeout(playerId);
			}),
			this.bus.subscribe(playerId, BUS_EVENT.trackLoading, () => this.clearLeaveTimeout(playerId)),
			this.bus.subscribe(playerId, BUS_EVENT.trackRequested, () => this.clearLeaveTimeout(playerId)),
			this.bus.subscribe(playerId, BUS_EVENT.stateChanged, (event) => {
				state.isPlaying = event.newState.status === AudioPlayerStatus.Playing;
				if (event.newState.status !== AudioPlayerStatus.Idle) this.clearLeaveTimeout(playerId);
			}),
			this.bus.subscribe(playerId, BUS_EVENT.trackEnd, () => {
				state.isPlaying = false;
			}),
			this.bus.subscribe(playerId, BUS_EVENT.queueEnd, () => {
				if (state.leaveOnEnd) this.scheduleLeave(playerId, "queue-end");
			}),
			this.bus.subscribe(playerId, BUS_EVENT.forwardModeStart, () => {
				this.clearLeaveTimeout(playerId);
				this.clearVoiceEmptyTimeout(state);
				state.debug?.("[LifecycleController] clearing leave timer: forward mode started");
			}),
			this.bus.subscribe(playerId, BUS_EVENT.forwardModeEnd, () => this.updateVoiceEmptyTimeout(playerId, state)),
			this.bus.onOutput(BUS_OUTPUT.connectionConnected, (event) => {
				if (event.playerId !== playerId || this.states.get(playerId) !== state) return;
				this.clearLeaveTimeout(playerId);
				this.watchVoiceChannel(playerId, state, event.channel);
			}),
			this.bus.onOutput(BUS_OUTPUT.connectionConnecting, (event) => {
				if (event.playerId !== playerId || this.states.get(playerId) !== state) return;
				this.clearLeaveTimeout(playerId);
				this.stopWatchingVoiceChannel(state);
			}),
			this.bus.onOutput(BUS_OUTPUT.connectionDisconnected, (event) => {
				if (event.playerId === playerId && this.states.get(playerId) === state) this.stopWatchingVoiceChannel(state);
			}),
		);
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.disposed = true;
		this.clearLeaveTimeout(playerId, state);
		this.stopWatchingVoiceChannel(state);
		for (const unsubscribe of state.unsubscribe.splice(0)) unsubscribe();
	}

	public scheduleLeave(playerId: string, reason: "track-end" | "queue-empty" | "manual" | "queue-end" = "manual"): void {
		const state = this.states.get(playerId);
		if (!state || state.disposed) return;
		this.clearLeaveTimeout(playerId, state);
		if (state.leaveTimeout <= 0) {
			state.debug?.(`[LifecycleController] leaveTimeout is 0 (disabled), not scheduling leave (${reason})`);
			return;
		}
		if (this.isForward(playerId)) {
			state.debug?.(`[LifecycleController] ignoring leave (${reason}): forward mode`);
			return;
		}
		if (state.isPlaying) {
			state.debug?.(`[LifecycleController] ignoring leave (${reason}) while playback is active`);
			return;
		}
		state.debug?.(`[LifecycleController] scheduling leave in ${state.leaveTimeout}ms (${reason})`);
		state.leaveTimer = setTimeout(() => {
			state.leaveTimer = null;
			if (this.states.get(playerId) !== state) return;
			if (this.isForward(playerId)) {
				state.debug?.(`[LifecycleController] cancelling leave (${reason}): forward mode active`);
				return;
			}
			const queue = this.bus.querySync(playerId, PLAYER_QUERY.queue) ?? [];
			if (state.isPlaying || queue.length > 0) {
				state.debug?.(`[LifecycleController] cancelling leave (${reason}): player is playing or has queued tracks`);
				return;
			}
			void this.disconnect(playerId, state, "leave-timeout");
		}, state.leaveTimeout);
	}

	public clearLeaveTimeout(playerId: string, state = this.states.get(playerId)): void {
		if (!state?.leaveTimer) return;
		clearTimeout(state.leaveTimer);
		state.leaveTimer = null;
	}

	public async leave(playerId: string, reason = "manual"): Promise<void> {
		const state = this.states.get(playerId);
		if (!state || state.disposed) return;
		this.clearLeaveTimeout(playerId, state);
		await this.disconnect(playerId, state, reason);
	}

	private watchVoiceChannel(playerId: string, state: LifecycleState, channel: any): void {
		this.stopWatchingVoiceChannel(state);
		if (!state.leaveOnEmpty && !state.pauseOnEmpty) return;
		const client = channel?.guild?.client;
		if (typeof client?.on !== "function") return;

		state.voiceChannel = channel;
		state.voiceStateClient = client;
		state.voiceStateListener = (oldState, newState) => {
			if (this.states.get(playerId) !== state) return;
			if (oldState?.guild?.id !== channel.guildId && newState?.guild?.id !== channel.guildId) return;
			if (oldState?.channelId !== channel.id && newState?.channelId !== channel.id) return;
			this.updateVoiceEmptyTimeout(playerId, state);
		};
		client.on("voiceStateUpdate", state.voiceStateListener);
		this.updateVoiceEmptyTimeout(playerId, state);
	}

	private stopWatchingVoiceChannel(state: LifecycleState): void {
		this.clearVoiceEmptyTimeout(state);
		if (state.voiceStateClient && state.voiceStateListener) {
			state.voiceStateClient.off?.("voiceStateUpdate", state.voiceStateListener);
			state.voiceStateClient.removeListener?.("voiceStateUpdate", state.voiceStateListener);
		}
		state.voiceChannel = null;
		state.voiceStateClient = null;
		state.voiceStateListener = null;
	}

	private updateVoiceEmptyTimeout(playerId: string, state: LifecycleState): void {
		const hasHuman = this.hasHumanVoiceMember(state);
		if (hasHuman === null) return;
		this.reconcilePauseOnEmpty(playerId, state);
		if (hasHuman) {
			this.clearVoiceEmptyTimeout(state);
			return;
		}
		this.clearVoiceEmptyTimeout(state);
		if (!state.leaveOnEmpty || state.leaveTimeout <= 0 || this.isForward(playerId)) return;
		state.debug?.(`[LifecycleController] scheduling voice-empty leave in ${state.leaveTimeout}ms`);
		state.voiceEmptyTimer = setTimeout(() => {
			state.voiceEmptyTimer = null;
			if (this.states.get(playerId) !== state || this.isForward(playerId)) return;
			if (this.hasHumanVoiceMember(state) !== false) return;
			void this.disconnect(playerId, state, "leave-timeout");
		}, state.leaveTimeout);
	}

	private hasHumanVoiceMember(state: LifecycleState): boolean | null {
		const members = state.voiceChannel?.members;
		if (!members || typeof members.values !== "function") return null;
		return Array.from(members.values()).some((member: any) => !member.user?.bot);
	}

	private isPlaybackPaused(playerId: string): boolean {
		if (this.bus.querySync(playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.REMOTE) {
			return this.bus.querySync(playerId, PLAYER_QUERY.remotePaused) ?? false;
		}
		return this.bus.querySync(playerId, PLAYER_QUERY.isPaused);
	}

	private isPlaybackActive(playerId: string): boolean {
		if (this.bus.querySync(playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.REMOTE) {
			return Boolean(this.bus.querySync(playerId, PLAYER_QUERY.currentTrack)) && !this.isPlaybackPaused(playerId);
		}
		return this.bus.querySync(playerId, PLAYER_QUERY.isPlaying);
	}

	private reconcilePauseOnEmpty(playerId: string, state: LifecycleState): void {
		if (!state.pauseOnEmpty) return;
		state.pauseTransition = state.pauseTransition
			.then(async () => {
				if (this.states.get(playerId) !== state || this.isForward(playerId)) return;
				const hasHuman = this.hasHumanVoiceMember(state);
				if (hasHuman === null) return;

				if (!hasHuman) {
					if (state.autoPaused || !this.isPlaybackActive(playerId) || this.isPlaybackPaused(playerId)) return;
					await this.bus.action(playerId, { type: PLAYER_ACTION.pause });
					state.autoPaused = this.isPlaybackPaused(playerId);
					return;
				}

				if (!state.autoPaused) return;
				state.autoPaused = false;
				if (this.isPlaybackPaused(playerId)) await this.bus.action(playerId, { type: PLAYER_ACTION.resume });
			})
			.catch((error) => state.debug?.("[LifecycleController] pauseOnEmpty action failed:", error));
	}

	private clearVoiceEmptyTimeout(state: LifecycleState): void {
		if (!state.voiceEmptyTimer) return;
		clearTimeout(state.voiceEmptyTimer);
		state.voiceEmptyTimer = null;
	}

	private isForward(playerId: string): boolean {
		return this.bus.querySync(playerId, PLAYER_QUERY.playbackMode) === PlaybackMode.FORWARD;
	}

	private async disconnect(playerId: string, state: LifecycleState, reason: string): Promise<void> {
		if (this.states.get(playerId) !== state || state.disposed) return;
		try {
			await this.bus.request(
				playerId,
				{ type: BUS_REQUEST.connectionDisconnect, requestId: createPlayerRequestId(), reason },
				{ timeoutMs: Math.max(5000, state.leaveTimeout || 5000) },
			);
		} catch (error) {
			state.debug?.(`[LifecycleController] disconnect failed:`, error);
		}
	}
}
