import type { PlayerBus } from "./PlayerBus";
import type { PlaybackSession } from "./PlaybackSession";
import type { Track } from "../types";

export interface AntiStuckControllerOptions {
	enabled?: boolean;
	maxRetries?: number;
	retryDelayMs?: number;
	reusePreloadFirst?: boolean;
	reduceQualityOnRetry?: boolean;
	controlledSkipThreshold?: number;
	bus?: PlayerBus;
}

export interface AntiStuckRetryContext {
	session: PlaybackSession;
	track: Track;
	retry: number;
	reason?: string;
}

export interface AntiStuckRetryHandlers {
	retry: (context: AntiStuckRetryContext) => Promise<boolean>;
	skip: (context: AntiStuckRetryContext) => Promise<void> | void;
}

export interface LegacyAntiStuckRetryContext {
	track: Track;
	retry: number;
	reason?: unknown;
	signal: AbortSignal;
}

export interface LegacyAntiStuckRetryHandlers {
	retry: (context: LegacyAntiStuckRetryContext) => Promise<boolean>;
}

/** Owns stuck detection/recovery policy; stream recreation remains outside. */
export class AntiStuckController {
	private readonly enabled: boolean;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly reusePreloadFirst: boolean;
	private readonly reduceQualityOnRetry: boolean;
	private readonly controlledSkipThreshold: number;
	private readonly bus?: PlayerBus;
	private readonly failures = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;
	private generation = 0;

	public constructor(options: AntiStuckControllerOptions = {}) {
		this.enabled = options.enabled ?? true;
		this.maxRetries = Math.max(0, options.maxRetries ?? 2);
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 900);
		this.reusePreloadFirst = options.reusePreloadFirst ?? true;
		this.reduceQualityOnRetry = options.reduceQualityOnRetry ?? true;
		this.controlledSkipThreshold = Math.max(1, options.controlledSkipThreshold ?? 3);
		this.bus = options.bus;
	}

	public arm(session: PlaybackSession, timeoutMs: number, handlers: AntiStuckRetryHandlers): void {
		this.clearTimer();
		if (!this.enabled || timeoutMs <= 0 || !session.track) return;
		const generation = ++this.generation;
		this.timer = setTimeout(() => {
			void this.recover(session, generation, "playback timeout", handlers);
		}, timeoutMs);
	}

	public async reportStuck(session: PlaybackSession, reason: string, handlers: AntiStuckRetryHandlers): Promise<boolean> {
		return this.recover(session, ++this.generation, reason, handlers);
	}

	/** Legacy Player adapter: preserves the old retry loop while moving policy/state into this controller. */
	public async recoverTrack(
		track: Track,
		signal: AbortSignal,
		reason: unknown,
		handlers: LegacyAntiStuckRetryHandlers,
	): Promise<boolean> {
		if (!this.enabled || signal.aborted) return false;
		const generation = ++this.generation;
		const key = this.key(track);
		let attempted = 0;
		while (attempted < this.maxRetries) {
			attempted++;
			if (signal.aborted || generation !== this.generation) return false;
			if (this.retryDelayMs > 0) await this.delay(this.retryDelayMs, signal);
			if (signal.aborted || generation !== this.generation) return false;
			const ok = await handlers.retry({ track, retry: attempted, reason, signal });
			if (ok) {
				this.failures.delete(key);
				return true;
			}
		}
		if (signal.aborted || generation !== this.generation) return false;
		const failures = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, failures);
		return false;
	}

	public clear(session?: PlaybackSession): void {
		this.clearTimer();
		this.generation++;
		if (session?.track) this.failures.delete(this.key(session.track));
	}

	public clearTrack(track: Track): void {
		this.generation++;
		this.failures.delete(this.key(track));
	}

	public reset(): void {
		this.clearTimer();
		this.generation++;
		this.failures.clear();
	}
	public getRetryCount(track: Track): number {
		return this.failures.get(this.key(track)) ?? 0;
	}
	public get shouldControlledSkip(): boolean {
		return false;
	}
	public get policy(): Readonly<{
		enabled: boolean;
		maxRetries: number;
		retryDelayMs: number;
		reusePreloadFirst: boolean;
		reduceQualityOnRetry: boolean;
		controlledSkipThreshold: number;
	}> {
		return {
			enabled: this.enabled,
			maxRetries: this.maxRetries,
			retryDelayMs: this.retryDelayMs,
			reusePreloadFirst: this.reusePreloadFirst,
			reduceQualityOnRetry: this.reduceQualityOnRetry,
			controlledSkipThreshold: this.controlledSkipThreshold,
		};
	}
	public dispose(): void {
		this.reset();
	}

	private async recover(
		session: PlaybackSession,
		generation: number,
		reason: string,
		handlers: AntiStuckRetryHandlers,
	): Promise<boolean> {
		const track = session.track;
		if (!this.enabled || !track || !session.isActive() || generation !== this.generation) return false;
		const retry = this.getRetryCount(track);
		this.bus?.event({ type: "STUCK_DETECTED", session: session.snapshot(), reason });
		if (retry >= this.maxRetries) {
			await handlers.skip({ session, track, retry, reason });
			return false;
		}
		this.failures.set(this.key(track), retry + 1);
		this.bus?.event({ type: "RECOVERY_STARTED", session: session.snapshot() });
		if (this.retryDelayMs > 0) await this.delay(this.retryDelayMs, session.signal);
		if (!session.isActive() || generation !== this.generation) return false;
		const ok = await handlers.retry({ session, track, retry: retry + 1, reason });
		if (!ok && session.isActive()) {
			this.bus?.event({ type: "RECOVERY_FAILED", session: session.snapshot() });
			if (this.getRetryCount(track) >= this.controlledSkipThreshold)
				await handlers.skip({ session, track, retry: this.getRetryCount(track), reason });
		}
		return ok;
	}

	private delay(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) return resolve();
			const timer = setTimeout(resolve, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
	private key(track: Track): string {
		return track.id ?? track.url ?? `${track.source}:${track.title}`;
	}
}
