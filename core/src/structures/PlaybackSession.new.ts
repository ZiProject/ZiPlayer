import type { Track } from "../types";
export type PlaybackSessionStatus = "idle" | "loading" | "playing" | "paused" | "stopped" | "ended" | "destroyed";
export class PlaybackSession {
	private static nextId = 0;
	public readonly id = ++PlaybackSession.nextId;
	public readonly abortController = new AbortController();
	public track: Track | null = null;
	public status: PlaybackSessionStatus = "idle";
	public position: number | null = null;
	public get signal(): AbortSignal { return this.abortController.signal; }
	public begin(track: Track): void { this.track = track; this.position = 0; this.status = "loading"; }
	public markPlaying(): void { this.status = "playing"; }
	public markPaused(): void { this.status = "paused"; }
	public markStopped(): void { this.status = "stopped"; }
	public markEnded(): void { this.status = "ended"; }
	public updatePosition(position: number): void { this.position = position; }
	public destroy(): void { this.abortController.abort(); this.status = "destroyed"; }
}
