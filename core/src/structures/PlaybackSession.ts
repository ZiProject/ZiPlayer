import type { AudioResource } from "@discordjs/voice";
import type { Track, PlaybackSessionStatus, PlaybackSessionSnapshot } from "../types";

/**
 * Owns the lifecycle state of one active playback operation.
 *
 * A session is the concurrency token for every asynchronous playback step.
 * Once destroyed, work associated with this session must be discarded before
 * it can mutate playback state.
 */
export class PlaybackSession {
	private static nextId = 0;

	public readonly id = ++PlaybackSession.nextId;
	public readonly abortController = new AbortController();
	public track: Track | null = null;
	public resource: AudioResource | null = null;
	public status: PlaybackSessionStatus = "idle";
	public position: number | null = null;
	public startedAt: number | null = null;

	public get signal(): AbortSignal {
		return this.abortController.signal;
	}

	public isActive(): boolean {
		return !this.signal.aborted && this.status !== "destroyed" && this.status !== "ended" && this.status !== "stopped";
	}

	public owns(operationSessionId: number): boolean {
		return this.id === operationSessionId && this.isActive();
	}

	public begin(track: Track): void {
		if (this.signal.aborted) throw new Error("Cannot begin an aborted playback session");
		this.track = track;
		this.resource = null;
		this.position = 0;
		this.startedAt = null;
		this.status = "loading";
	}

	public setResource(resource: AudioResource | null): void {
		if (!this.isActive()) return;
		this.resource = resource;
	}

	public markPlaying(position = this.position ?? 0): void {
		if (!this.isActive()) return;
		this.position = position;
		this.startedAt ??= Date.now();
		this.status = "playing";
	}

	public markPaused(position = this.position ?? 0): void {
		if (!this.isActive()) return;
		this.position = position;
		this.status = "paused";
	}

	public markStopped(): void {
		if (this.signal.aborted) return;
		this.status = "stopped";
	}

	public markEnded(): void {
		if (this.signal.aborted) return;
		this.status = "ended";
	}

	public updatePosition(position: number): void {
		if (!this.isActive()) return;
		this.position = Math.max(0, position);
	}

	public destroy(): void {
		if (!this.abortController.signal.aborted) this.abortController.abort();
		this.status = "destroyed";
		this.resource = null;
	}

	public snapshot(): PlaybackSessionSnapshot {
		return {
			id: this.id,
			track: this.track,
			resource: this.resource,
			status: this.status,
			position: this.position,
			startedAt: this.startedAt,
		};
	}
}
