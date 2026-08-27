import { PlaybackMode, type Track } from "../types";
import type { Player } from "../structures/Player";

export interface ForwardControllerOptions {
	debug?: (...args: any[]) => void;
}

/** Owns leader/follower voice-subscription state for forward playback. */
export class ForwardController {
	private leader: Player | null = null;
	private readonly followers = new Set<Player>();
	private disposed = false;
	private readonly debug: (...args: any[]) => void;

	constructor(
		private readonly player: Player,
		options: ForwardControllerOptions = {},
	) {
		this.debug = options.debug ?? (() => undefined);
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
		const leaderForward = (leader as any).forwardController as ForwardController | undefined;
		if (leaderForward?.isFollower || (leader as any).forwardLeader) return false;
		if (!this.player.connection || !leader.connection) return false;

		this.unsubscribeForward(`replaced by ${leader.guildId}`);
		this.leader = leader;
		leaderForward?.followers.add(this.player);

		try {
			this.player.stop();
			for (const fp of [...this.followers]) fp.unsubscribeForward(`leader changed to ${leader.guildId}`);
			this.followers.clear();
			this.player.queue.clear();
			const track = leader.currentTrack as Track | null | undefined;
			if (track) this.player.queue.setCurrentTrack(track);
			if (options?.forwardMode ?? true) this.player.playbackMode = PlaybackMode.FORWARD;
			if (this.player.playbackMode === PlaybackMode.FORWARD) this.player.connection.subscribe(leader.audioPlayer);
			this.player.volume = leader.volume;
			this.player.emit("forwardModeStart", leader);
			return true;
		} catch (error) {
			this.debug("[Forward] subscribe error:", error);
			leaderForward?.followers.delete(this.player);
			this.leader = null;
			this.player.playbackMode = PlaybackMode.NATIVE;
			return false;
		}
	}

	unsubscribeForward(reason?: string): boolean {
		const leader = this.leader;
		if (!leader) return false;
		const leaderForward = (leader as any).forwardController as ForwardController | undefined;
		leaderForward?.followers.delete(this.player);
		(leader as any).forwardFollowers?.delete?.(this.player);
		this.leader = null;
		this.player.playbackMode = PlaybackMode.NATIVE;
		try {
			this.player.connection?.subscribe(this.player.audioPlayer);
		} catch {}
		this.player.queue.clear();
		this.player.emit("forwardModeEnd", leader, reason);
		return true;
	}

	addFollower(follower: Player): void {
		if (!this.disposed && follower !== this.player) this.followers.add(follower);
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
		this.clearFollowers();
		this.unsubscribeForward("controller disposed");
	}
}
