import type { PlaybackSession } from "../structures/PlaybackSession";
import type {
	Track,
	AntiStuckControllerOptions,
	AntiStuckRetryHandlers,
	LegacyAntiStuckRetryHandlers,
	PlayerAction,
} from "../types";
import { BUS_OUTPUT, CONTROLLER_RPC, PLAYER_QUERY, BUS_EVENT, type AntiStuckReportRequest } from "../structures/BusContract";
import type { Bus } from "../structures/Bus";

/** Per-player anti-stuck retry policy + recovery state machine, owned by the shared
 *  `AntiStuckController` below. */
class AntiStuckWorker {
	private readonly enabled: boolean;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly reusePreloadFirst: boolean;
	private readonly reduceQualityOnRetry: boolean;
	private readonly controlledSkipThreshold: number;
	private readonly bus?: Bus;
	private readonly playerId?: string;
	private readonly failures = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;
	private generation = 0;
	private readonly detachAction?: () => void;
	private readonly detachBusHandlers: Array<() => void> = [];
	public constructor(options: AntiStuckControllerOptions & { playerId?: string } = {}) {
		this.enabled = options.enabled ?? true;
		this.maxRetries = Math.max(0, options.maxRetries ?? 2);
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 90000);
		this.reusePreloadFirst = options.reusePreloadFirst ?? true;
		this.reduceQualityOnRetry = options.reduceQualityOnRetry ?? true;
		this.controlledSkipThreshold = Math.max(1, options.controlledSkipThreshold ?? 3);
		this.bus = options.bus;
		this.playerId = options.playerId;
	}
	public arm(session: PlaybackSession, timeoutMs: number, handlers: AntiStuckRetryHandlers): void {
		this.clearTimer();
		if (!this.enabled || timeoutMs <= 0 || !session.track) return;
		const generation = ++this.generation;
		this.timer = setTimeout(() => void this.recover(session, generation, "playback timeout", handlers), timeoutMs);
	}
	public async reportStuck(session: PlaybackSession, reason: string, handlers: AntiStuckRetryHandlers): Promise<boolean> {
		return this.recover(session, ++this.generation, reason, handlers);
	}
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
		this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
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
	/**
	 * Invalidates any in-flight anti-stuck recovery without resetting retry
	 * accounting. This is used by user-driven operations such as seek, which
	 * supersede a recovery attempt but keep the same playback session alive.
	 */
	public cancelRecovery(): void {
		this.clearTimer();
		this.generation++;
	}
	public reset(): void {
		this.clearTimer();
		this.generation++;
		this.failures.clear();
	}
	public getRetryCount(track: Track): number {
		return this.failures.get(this.key(track)) ?? 0;
	}
	public get policy() {
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
	public get policySnapshot(): Record<string, unknown> {
		return this.policy as Record<string, unknown>;
	}
	public requestRecovery(
		session: PlaybackSession,
		reason: string,
		handlers: AntiStuckRetryHandlers,
		requestId?: string,
	): Promise<boolean> {
		return this.recover(session, ++this.generation, reason, handlers, requestId);
	}
	private async recover(
		session: PlaybackSession,
		generation: number,
		reason: string,
		handlers: AntiStuckRetryHandlers,
		requestId?: string,
	): Promise<boolean> {
		const track = session.track;
		if (!this.enabled || !track || !session.isActive() || generation !== this.generation) return false;
		const retry = this.getRetryCount(track);
		if (this.bus && this.playerId)
			this.bus.event(this.playerId, { type: BUS_EVENT.stuckDetected, session: session.snapshot(), reason });
		if (retry >= this.maxRetries) {
			await handlers.skip({ session, track, retry, reason });
			return false;
		}
		this.failures.set(this.key(track), retry + 1);
		if (this.bus && this.playerId)
			this.bus.event(this.playerId, { type: BUS_EVENT.recoveryStarted, session: session.snapshot() });
		if (requestId && this.bus && this.playerId)
			this.bus.emitOutput({
				type: BUS_OUTPUT.recoveryRetrying,
				requestId,
				playerId: this.playerId,
				session: session.snapshot(),
				attempt: retry + 1,
			});
		if (this.retryDelayMs > 0) await this.delay(this.retryDelayMs, session.signal);
		if (!session.isActive() || generation !== this.generation) return false;
		const ok = await handlers.retry({ session, track, retry: retry + 1, reason });
		if (ok) {
			this.failures.delete(this.key(track));
			if (requestId && this.bus && this.playerId)
				this.bus.emitOutput({
					type: BUS_OUTPUT.recoveryRecovered,
					requestId,
					playerId: this.playerId,
					session: session.snapshot(),
				});
			return true;
		}
		if (session.isActive()) {
			if (this.bus && this.playerId)
				this.bus.event(this.playerId, { type: BUS_EVENT.recoveryFailed, session: session.snapshot() });
			if (requestId && this.bus && this.playerId)
				this.bus.emitOutput({
					type: BUS_OUTPUT.recoveryFailed,
					requestId,
					playerId: this.playerId,
					session: session.snapshot(),
					error: new Error(reason),
				});
			if (this.getRetryCount(track) >= this.controlledSkipThreshold)
				await handlers.skip({ session, track, retry: this.getRetryCount(track), reason });
		}
		return false;
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

/** Shared, singleton controller: owns anti-stuck retry policy and recovery for every
 *  player, keyed by playerId. */
export class AntiStuckController {
	private readonly workers = new Map<string, AntiStuckWorker>();

	public constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			if (context.signal.aborted) return;
			if (action.type === "STOP" || action.type === "SEEK") this.workers.get(context.playerId)?.cancelRecovery();
		});
		bus.registerQuery(PLAYER_QUERY.retryPolicy, (playerId) => this.workers.get(playerId)?.policySnapshot ?? {});
		bus.registerRpc<AntiStuckReportRequest, boolean>(CONTROLLER_RPC.antiStuckReport, ({ session, reason, handlers }, ctx) => {
			const worker = this.workers.get(ctx.playerId);
			return worker ? worker.reportStuck(session, reason, handlers) : Promise.resolve(false);
		});
	}

	attach(playerId: string, options: Omit<AntiStuckControllerOptions, "bus"> = {}): void {
		if (this.workers.has(playerId)) this.detach(playerId);
		this.workers.set(playerId, new AntiStuckWorker({ ...options, bus: this.bus, playerId }));
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}
}
