import { PlaybackMode, type Track, type ForwardControllerOptions, type ForwardHealthStatus } from "../types";
import type { Player } from "../structures/Player";
import { AudioPlayerStatus } from "@discordjs/voice";

/** Owns leader/follower voice-subscription state for forward playback. */
export class ForwardController {
	private leader: Player | null = null;
	private readonly followers = new Set<Player>();
	private mode: PlaybackMode = PlaybackMode.NATIVE;
	private disposed = false;
	private readonly debug: (...args: any[]) => void;
	private readonly detachRpcs: Array<() => void> = [];

	constructor(
		private readonly player: Player,
		options: ForwardControllerOptions = {},
	) {
		this.debug = options.debug ?? (() => undefined);
		if (options.bus) {
			this.detachRpcs.push(
				options.bus.registerRpc<void, ForwardHealthStatus>("forward.health", () => this.healthStatus()),
				options.bus.registerRpc<{ leader: unknown; options?: { forwardMode?: boolean } }, boolean>(
					"forward.subscribe",
					({ leader, options: forwardOptions }) => this.subscribeTo(leader as Player, forwardOptions),
				),
				options.bus.registerRpc<{ reason?: string }, boolean>("forward.unsubscribe", ({ reason }) =>
					this.unsubscribeForward(reason),
				),
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
			for (const follower of this.followers) if (follower.destroyed || !follower.connection) issues.push(follower.guildId);
		} else if (role === "follower" && (!this.leader || this.leader.destroyed)) issues.push("missing leader");
		return {
			guildId: this.player.guildId,
			healthy: role === "leader" ? true : issues.length === 0,
			role,
			issues,
			details: {
				leaderId: this.leader?.guildId,
				followerCount: this.followers.size,
				connectionState: this.player.connection?.state?.status,
				audioPlayerState:
					this.player.isPlaying ? AudioPlayerStatus.Playing
					: this.player.isPaused ? AudioPlayerStatus.Paused
					: AudioPlayerStatus.Idle,
			},
		};
	}

	get playbackMode(): PlaybackMode {
		return this.mode;
	}
	get forwardLeader(): Player | null {
		return this.leader;
	}
	get forwardFollowers(): ReadonlySet<Player> {
		return this.followers;
	}
	get isFollower(): boolean {
		return this.leader !== null;
	}
	get isLeader(): boolean {
		return this.followers.size > 0;
	}

	subscribeTo(leader: Player, options?: { forwardMode?: boolean }): boolean {
		if (this.disposed || !leader || leader === this.player || leader.destroyed || this.player.destroyed) return false;
		const leaderForward = leader.runtimeGraph.forwardController;
		if (leaderForward?.isFollower || leaderForward?.forwardLeader) return false;
		if (!this.player.connection || !leader.connection) return false;

		this.unsubscribeForward(`replaced by ${leader.guildId}`);
		const leaderAudioPlayer = leader.runtime.getAudioPlayer();
		const playerAudioPlayer = this.player.runtime.getAudioPlayer();
		if (!leaderAudioPlayer || !playerAudioPlayer) return false;
		this.leader = leader;
		leaderForward.addFollower(this.player);

		try {
			this.player.stop();
			for (const fp of [...this.followers]) fp.unsubscribeForward(`leader changed to ${leader.guildId}`);
			this.followers.clear();
			const track = leader.currentTrack as Track | null | undefined;
			if (track) leader.runtime.setCurrentTrack(track);
			this.mode = (options?.forwardMode ?? true) ? PlaybackMode.FORWARD : PlaybackMode.NATIVE;
			if (this.mode === PlaybackMode.FORWARD) this.player.connection.subscribe(leaderAudioPlayer);
			this.player.volume = leader.volume;
			this.player.bus.event({ type: "forwardModeStart", leader });
			return true;
		} catch (error) {
			this.debug("[Forward] subscribe error:", error);
			leaderForward.removeFollower(this.player);
			this.leader = null;
			this.mode = PlaybackMode.NATIVE;
			return false;
		}
	}

	unsubscribeForward(reason?: string): boolean {
		const leader = this.leader;
		if (!leader) return false;
		const leaderForward = leader.runtimeGraph.forwardController;
		leaderForward.removeFollower(this.player);
		this.leader = null;
		this.mode = PlaybackMode.NATIVE;
		try {
			const audioPlayer = this.player.runtime.getAudioPlayer();
			if (audioPlayer) this.player.connection?.subscribe(audioPlayer);
		} catch {}
		this.player.clearQueue();
		this.player.bus.event({ type: "forwardModeEnd", leader, reason });
		return true;
	}

	addFollower(follower: Player): void {
		if (!this.disposed && follower !== this.player) {
			this.followers.add(follower);
		}
	}
	removeFollower(follower: Player): void {
		this.followers.delete(follower);
	}
	clearFollowers(reason = "leader destroyed"): void {
		for (const follower of [...this.followers]) follower.unsubscribeForward(reason);
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
