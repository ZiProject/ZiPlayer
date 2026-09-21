import { PlaybackMode, type Track, type ForwardHealthStatus } from "../types";
import { AudioPlayerStatus } from "@discordjs/voice";
import type { Bus } from "../structures/Bus";
import { PLAYER_QUERY, PLAYER_RPC, BUS_EVENT, PLAYER_ACTION } from "../structures/BusContract";

interface ForwardState {
	leaderId?: string;
	followers: Set<string>;
	mode: PlaybackMode;
}

/** Shared, singleton controller: owns leader/follower voice-subscription state for
 *  forward playback across every player, keyed by playerId. Since every player shares
 *  the same Bus, cross-player coordination is just a bus call addressed to
 *  the other player's id — no separate per-player bus lookup is needed. */
export class ForwardController {
	private readonly states = new Map<string, ForwardState>();
	private disposed = false;
	private readonly debug: (...args: any[]) => void;

	constructor(
		private readonly bus: Bus,
		options: { debug?: (...args: any[]) => void } = {},
	) {
		this.debug = options.debug ?? (() => undefined);
		bus.registerRpc<void, ForwardHealthStatus>(PLAYER_RPC.forwardHealth, (_req, ctx) => this.healthStatus(ctx.playerId));
		bus.registerRpc<{ leader: unknown; options?: { forwardMode?: boolean } }, boolean>(
			PLAYER_RPC.forwardSubscribe,
			({ leader, options: forwardOptions }, ctx) => this.subscribeTo(ctx.playerId, leader as any, forwardOptions),
		);
		bus.registerRpc<{ reason?: string }, boolean>(PLAYER_RPC.forwardUnsubscribe, ({ reason }, ctx) =>
			this.unsubscribeForward(ctx.playerId, reason),
		);
		bus.registerRpc<{ playerId: string; leaderId: string }, boolean>(PLAYER_RPC.forwardAddFollower, ({ playerId }, ctx) => {
			this.addFollower(ctx.playerId, playerId);
			return true;
		});
		bus.registerRpc<{ playerId: string; leaderId: string }, boolean>(PLAYER_RPC.forwardRemoveFollower, ({ playerId }, ctx) => {
			this.removeFollower(ctx.playerId, playerId);
			return true;
		});
		bus.registerQuery(PLAYER_QUERY.playbackMode, (playerId) => this.state(playerId).mode);
		bus.registerQuery(PLAYER_QUERY.forwardLeader, (playerId) => {
			const leaderId = this.state(playerId).leaderId;
			return leaderId ? ({ guildId: leaderId } as any) : null;
		});
		bus.registerQuery(PLAYER_QUERY.forwardLeaderId, (playerId) => this.state(playerId).leaderId ?? null);
		bus.registerQuery(PLAYER_QUERY.forwardFollowers, (playerId) => this.state(playerId).followers as any);
	}

	attach(playerId: string): void {
		this.states.set(playerId, { leaderId: undefined, followers: new Set(), mode: PlaybackMode.NATIVE });
	}
	aggregateSnapshot(): { leader: number; follower: number; healthStatus: ForwardHealthStatus[] } {
		let leader = 0;
		let follower = 0;
		const healthStatus: ForwardHealthStatus[] = [];
		for (const playerId of this.states.keys()) {
			const status = this.healthStatus(playerId);
			healthStatus.push(status);
			if (status.role === "leader") leader++;
			if (status.role === "follower") follower++;
		}
		return { leader, follower, healthStatus };
	}
	detach(playerId: string): void {
		this.clearFollowers(playerId);
		this.unsubscribeForward(playerId, "controller disposed");
		this.states.delete(playerId);
	}

	private state(playerId: string): ForwardState {
		let state = this.states.get(playerId);
		if (!state) {
			state = { leaderId: undefined, followers: new Set(), mode: PlaybackMode.NATIVE };
			this.states.set(playerId, state);
		}
		return state;
	}

	healthStatus(playerId: string): ForwardHealthStatus {
		const state = this.state(playerId);
		const role: ForwardHealthStatus["role"] =
			this.isLeader(playerId) ? "leader"
			: this.isFollower(playerId) ? "follower"
			: "none";
		const issues: string[] = [];
		if (role === "leader") {
			for (const followerId of state.followers) {
				if (!this.bus.querySync(followerId, PLAYER_QUERY.connection)) issues.push(followerId);
			}
		} else if (role === "follower" && !state.leaderId) {
			issues.push("missing leader");
		}
		return {
			guildId: playerId,
			healthy: role === "leader" ? true : issues.length === 0,
			role,
			issues,
			details: {
				leaderId: state.leaderId,
				followerCount: state.followers.size,
				connectionState: this.bus.querySync(playerId, PLAYER_QUERY.connectionState),
				audioPlayerState:
					this.bus.querySync(playerId, PLAYER_QUERY.isPlaying) ? AudioPlayerStatus.Playing
					: this.bus.querySync(playerId, PLAYER_QUERY.isPaused) ? AudioPlayerStatus.Paused
					: AudioPlayerStatus.Idle,
			},
		};
	}

	playbackMode(playerId: string): PlaybackMode {
		return this.state(playerId).mode;
	}
	forwardLeader(playerId: string): any {
		const leaderId = this.state(playerId).leaderId;
		return leaderId ? { guildId: leaderId } : null;
	}
	forwardFollowers(playerId: string): ReadonlySet<string> {
		return this.state(playerId).followers;
	}
	isFollower(playerId: string): boolean {
		return Boolean(this.state(playerId).leaderId);
	}
	isLeader(playerId: string): boolean {
		return this.state(playerId).followers.size > 0;
	}

	subscribeTo(
		playerId: string,
		leader: string | { guildId?: string; id?: string },
		options?: { forwardMode?: boolean },
	): boolean {
		const state = this.state(playerId);
		if (this.disposed || !leader) return false;
		const leaderId = typeof leader === "string" ? leader : (leader.guildId ?? leader.id);
		if (!leaderId || leaderId === playerId || !this.states.has(leaderId)) return false;

		const leaderMode = this.bus.querySync(leaderId, PLAYER_QUERY.playbackMode);
		const leaderLeader =
			this.bus.querySync(leaderId, PLAYER_QUERY.forwardLeaderId) ?? this.bus.querySync(leaderId, PLAYER_QUERY.forwardLeader);
		if (leaderMode === PlaybackMode.FORWARD || leaderLeader) return false;

		const myConn = this.bus.querySync(playerId, PLAYER_QUERY.connection);
		const leaderConn = this.bus.querySync(leaderId, PLAYER_QUERY.connection);
		if (!myConn || !leaderConn) return false;

		this.unsubscribeForward(playerId, `replaced by ${leaderId}`);
		const leaderAudioPlayer = this.bus.querySync(leaderId, PLAYER_QUERY.audioPlayer);
		const playerAudioPlayer = this.bus.querySync(playerId, PLAYER_QUERY.audioPlayer);
		if (!leaderAudioPlayer || !playerAudioPlayer) return false;

		state.leaderId = leaderId;
		this.addFollower(leaderId, playerId);
		state.mode = (options?.forwardMode ?? true) ? PlaybackMode.FORWARD : PlaybackMode.NATIVE;

		try {
			this.bus.event(playerId, { type: BUS_EVENT.forwardModeStart, leader: leader as any });
			void this.bus.action(playerId, { type: PLAYER_ACTION.stop });
			this.clearFollowers(playerId, `leader changed to ${leaderId}`);
			const track = this.bus.querySync(leaderId, PLAYER_QUERY.currentTrack) as Track | null | undefined;
			if (track) this.bus.requestRpcSync(playerId, PLAYER_RPC.queueSetCurrent, { track });
			if (state.mode === PlaybackMode.FORWARD) {
				this.bus.requestRpcSync(playerId, PLAYER_RPC.connectionSetAudioPlayer, { audioPlayer: leaderAudioPlayer });
			}
			const leaderVolume = this.bus.querySync(leaderId, PLAYER_QUERY.volume);
			if (typeof leaderVolume === "number") this.bus.requestRpcSync(playerId, PLAYER_RPC.volumeSet, { value: leaderVolume });
			return true;
		} catch (error) {
			this.debug("[Forward] subscribe error:", error);
			this.removeFollower(leaderId, playerId);
			state.leaderId = undefined;
			state.mode = PlaybackMode.NATIVE;
			return false;
		}
	}

	unsubscribeForward(playerId: string, reason?: string): boolean {
		const state = this.state(playerId);
		const leaderId = state.leaderId;
		if (!leaderId) return false;
		this.removeFollower(leaderId, playerId);
		state.leaderId = undefined;
		state.mode = PlaybackMode.NATIVE;
		try {
			const audioPlayer = this.bus.querySync(playerId, PLAYER_QUERY.audioPlayer);
			if (audioPlayer) this.bus.requestRpcSync(playerId, PLAYER_RPC.connectionSetAudioPlayer, { audioPlayer });
		} catch {}
		this.bus.requestRpcSync(playerId, PLAYER_RPC.queueClear, undefined);
		this.bus.event(playerId, { type: BUS_EVENT.forwardModeEnd, leader: { guildId: leaderId } as any, reason });
		return true;
	}

	addFollower(leaderId: string, followerId: string): void {
		if (this.disposed || followerId === leaderId) return;
		this.state(leaderId).followers.add(followerId);
	}

	removeFollower(leaderId: string, followerId: string): void {
		this.states.get(leaderId)?.followers.delete(followerId);
	}

	clearFollowers(playerId: string, reason = "leader destroyed"): void {
		const state = this.state(playerId);
		for (const followerId of [...state.followers]) {
			if (this.states.has(followerId)) this.unsubscribeForward(followerId, reason);
		}
		state.followers.clear();
	}
}
