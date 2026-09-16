import { PlaybackMode, type Track, type ForwardControllerOptions, type ForwardHealthStatus } from "../types";
import { AudioPlayerStatus } from "@discordjs/voice";
import type { PlayerBus } from "../structures/PlayerBus";
import { globalControllerRegistry } from "./GlobalControllerRegistry";

/** Owns leader/follower voice-subscription state for forward playback. */
export class ForwardController {
	private readonly playerId: string;
	private readonly bus: PlayerBus;
	private leaderId?: string;
	private readonly followers = new Set<string>();
	private mode: PlaybackMode = PlaybackMode.NATIVE;
	private disposed = false;
	private readonly debug: (...args: any[]) => void;
	private readonly detachRpcs: Array<() => void> = [];

	constructor(
		playerOrOptions: any = {},
		options: ForwardControllerOptions = {},
	) {
		const opts: ForwardControllerOptions =
			typeof playerOrOptions === "string"
				? { ...options, playerId: playerOrOptions }
				: playerOrOptions && typeof playerOrOptions === "object" && "bus" in playerOrOptions
					? (playerOrOptions as ForwardControllerOptions)
					: { ...options, ...playerOrOptions };

		this.playerId = opts.playerId ?? (playerOrOptions as any)?.guildId ?? "";
		this.bus = opts.bus!;
		this.debug = opts.debug ?? (() => undefined);

		if (this.bus) {
			this.detachRpcs.push(
				this.bus.registerRpc<void, ForwardHealthStatus>("forward.health", () => this.healthStatus()),
				this.bus.registerRpc<{ leader: unknown; options?: { forwardMode?: boolean } }, boolean>(
					"forward.subscribe",
					({ leader, options: forwardOptions }) => this.subscribeTo(leader as any, forwardOptions),
				),
				this.bus.registerRpc<{ reason?: string }, boolean>("forward.unsubscribe", ({ reason }) =>
					this.unsubscribeForward(reason),
				),
				this.bus.registerRpc<{ playerId: string; leaderId: string }, boolean>(
					"forward.addFollower",
					async ({ playerId, leaderId }) => {
						if (leaderId === this.playerId) {
							this.addFollower(playerId);
							return true;
						}
						const leaderEntry = globalControllerRegistry.get(leaderId);
						if (!leaderEntry) return false;
						return leaderEntry.bus.requestRpc("forward.addFollower", { playerId, leaderId });
					},
				),
				this.bus.registerRpc<{ playerId: string; leaderId: string }, boolean>(
					"forward.removeFollower",
					async ({ playerId, leaderId }) => {
						if (leaderId === this.playerId) {
							this.removeFollower(playerId);
							return true;
						}
						const leaderEntry = globalControllerRegistry.get(leaderId);
						if (!leaderEntry) return false;
						return leaderEntry.bus.requestRpc("forward.removeFollower", { playerId, leaderId });
					},
				),
				this.bus.registerQuery("playbackMode", () => this.mode),
				this.bus.registerQuery("forwardLeader", () => (this.leaderId ? ({ guildId: this.leaderId } as any) : null)),
				this.bus.registerQuery("forwardLeaderId", () => this.leaderId ?? null),
				this.bus.registerQuery("forwardFollowers", () => this.followers as any),
			);
		}
	}

	healthStatus(): ForwardHealthStatus {
		const role: ForwardHealthStatus["role"] =
			this.isLeader ? "leader"
			: this.isFollower ? "follower"
			: "none";
		const issues: string[] = [];
		if (role === "leader") {
			for (const followerId of this.followers) {
				const entry = globalControllerRegistry.get(followerId);
				if (!entry || !entry.bus.querySync("connection")) issues.push(followerId);
			}
		} else if (role === "follower" && !this.leaderId) {
			issues.push("missing leader");
		}
		return {
			guildId: this.playerId,
			healthy: role === "leader" ? true : issues.length === 0,
			role,
			issues,
			details: {
				leaderId: this.leaderId,
				followerCount: this.followers.size,
				connectionState: this.bus.querySync("connection.state"),
				audioPlayerState:
					this.bus.querySync("isPlaying") ? AudioPlayerStatus.Playing
					: this.bus.querySync("isPaused") ? AudioPlayerStatus.Paused
					: AudioPlayerStatus.Idle,
			},
		};
	}

	get playbackMode(): PlaybackMode {
		return this.mode;
	}
	get forwardLeader(): any {
		return this.leaderId ? { guildId: this.leaderId } : null;
	}
	get forwardFollowers(): ReadonlySet<any> {
		return this.followers;
	}
	get isFollower(): boolean {
		return Boolean(this.leaderId);
	}
	get isLeader(): boolean {
		return this.followers.size > 0;
	}

	subscribeTo(leader: string | { guildId?: string; id?: string }, options?: { forwardMode?: boolean }): boolean {
		if (this.disposed || !leader) return false;
		const leaderId = typeof leader === "string" ? leader : leader.guildId ?? leader.id;
		if (!leaderId || leaderId === this.playerId) return false;

		const leaderEntry = globalControllerRegistry.get(leaderId);
		if (!leaderEntry) return false;

		const leaderBus = leaderEntry.bus;
		const leaderMode = leaderBus.querySync("playbackMode");
		const leaderLeader = leaderBus.querySync("forwardLeaderId") ?? leaderBus.querySync("forwardLeader");
		if (leaderMode === PlaybackMode.FORWARD || leaderLeader) return false;

		const myConn = this.bus.querySync("connection");
		const leaderConn = leaderBus.querySync("connection");
		if (!myConn || !leaderConn) return false;

		this.unsubscribeForward(`replaced by ${leaderId}`);
		const leaderAudioPlayer = leaderBus.querySync("audioPlayer");
		const playerAudioPlayer = this.bus.querySync("audioPlayer");
		if (!leaderAudioPlayer || !playerAudioPlayer) return false;

		this.leaderId = leaderId;
		void this.bus.requestRpc("forward.addFollower", { playerId: this.playerId, leaderId });

		try {
			void this.bus.action({ type: "STOP" });
			this.clearFollowers(`leader changed to ${leaderId}`);
			const track = leaderBus.querySync("currentTrack") as Track | null | undefined;
			if (track) this.bus.requestRpcSync("queue.setCurrent", { track });
			this.mode = (options?.forwardMode ?? true) ? PlaybackMode.FORWARD : PlaybackMode.NATIVE;
			if (this.mode === PlaybackMode.FORWARD) {
				this.bus.requestRpcSync("connection.setAudioPlayer", { audioPlayer: leaderAudioPlayer });
			}
			const leaderVolume = leaderBus.querySync("volume");
			if (typeof leaderVolume === "number") {
				this.bus.requestRpcSync("volume.set", { value: leaderVolume });
			}
			this.bus.event({ type: "forwardModeStart", leader: leader as any });
			return true;
		} catch (error) {
			this.debug("[Forward] subscribe error:", error);
			void this.bus.requestRpc("forward.removeFollower", { playerId: this.playerId, leaderId });
			this.leaderId = undefined;
			this.mode = PlaybackMode.NATIVE;
			return false;
		}
	}

	unsubscribeForward(reason?: string): boolean {
		const leaderId = this.leaderId;
		if (!leaderId) return false;
		void this.bus.requestRpc("forward.removeFollower", { playerId: this.playerId, leaderId });
		this.leaderId = undefined;
		this.mode = PlaybackMode.NATIVE;
		try {
			const audioPlayer = this.bus.querySync("audioPlayer");
			if (audioPlayer) {
				this.bus.requestRpcSync("connection.setAudioPlayer", { audioPlayer });
			}
		} catch {}
		this.bus.requestRpcSync("queue.clear", undefined);
		this.bus.event({ type: "forwardModeEnd", leader: { guildId: leaderId } as any, reason });
		return true;
	}

	addFollower(followerId: string): void {
		if (!this.disposed && followerId !== this.playerId) {
			this.followers.add(followerId);
		}
	}

	removeFollower(followerId: string): void {
		this.followers.delete(followerId);
	}

	clearFollowers(reason = "leader destroyed"): void {
		for (const followerId of [...this.followers]) {
			const entry = globalControllerRegistry.get(followerId);
			void entry?.bus.requestRpc("forward.unsubscribe", { reason });
		}
		this.followers.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const detach of this.detachRpcs.splice(0)) detach();
		this.clearFollowers();
		this.unsubscribeForward("controller disposed");
		this.mode = PlaybackMode.NATIVE;
	}
}
