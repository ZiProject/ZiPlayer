import type { AudioResource } from "@discordjs/voice";
import type { Track } from "../types";

export type PlaybackSessionStatus = "idle" | "loading" | "playing" | "paused" | "stopped" | "ended" | "destroyed";

export interface PlaybackSessionSnapshot {
	id: number;
	track: Track | null;
	resource: AudioResource | null;
	status: PlaybackSessionStatus;
	position: number | null;
	startedAt: number | null;
}

/**
 * Owns the lifecycle state of one active playback operation.
 *
 * The session deliberately contains no orchestration logic. Controllers can
 * replace the active session atomically and use its AbortSignal to cancel
 * work belonging to an obsolete playback operation.
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

	public begin(track: Track): void {
		this.track = track;
		this.resource = null;
		this.position = 0;
		this.startedAt = null;
		this.status = "loading";
	}

	public setResource(resource: AudioResource | null): void {
		this.resource = resource;
	}

	public markPlaying(position = this.position ?? 0): void {
		this.position = position;
		this.startedAt ??= Date.now();
		this.status = "playing";
	}

	public markPaused(position = this.position ?? 0): void {
		this.position = position;
		this.status = "paused";
	}

	public markStopped(): void {
		this.status = "stopped";
	}

	public markEnded(): void {
		this.status = "ended";
	}

	public updatePosition(position: number): void {
		this.position = position;
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
