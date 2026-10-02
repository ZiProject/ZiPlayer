import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, AntiStuckControllerOptions, AntiStuckRetryHandlers } from "../types";
import {
	BUS_OUTPUT,
	CONTROLLER_RPC,
	PLAYER_QUERY,
	BUS_EVENT,
	traceBusSignal,
	type AntiStuckReportRequest,
} from "../structures/BusContract";
import type { Bus } from "../structures/Bus";

const MAX_FAILURE_ENTRIES = 500;

interface AntiStuckState {
	enabled: boolean;
	maxRetries: number;
	retryDelayMs: number;
	reusePreloadFirst: boolean;
	reduceQualityOnRetry: boolean;
	controlledSkipThreshold: number;
	failures: Map<string, number>;
	timer: NodeJS.Timeout | null;
	generation: number;
	lifecycleAbort: AbortController;
	debug?: (message: string) => void;
	disposed: boolean;
	recordFailure: (key: string, value: number) => void;
}

function clearTimer(state: AntiStuckState): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
}

function reset(state: AntiStuckState): void {
	clearTimer(state);
	state.generation++;
	state.failures.clear();
}

function trackKey(track: Track): string {
	return track.id ?? track.url ?? `${track.source}:${track.title}`;
}

function getRetryCount(state: AntiStuckState, track: Track): number {
	return state.failures.get(trackKey(track)) ?? 0;
}

function policy(state: AntiStuckState): Record<string, unknown> {
	return {
		enabled: state.enabled,
		maxRetries: state.maxRetries,
		retryDelayMs: state.retryDelayMs,
		reusePreloadFirst: state.reusePreloadFirst,
		reduceQualityOnRetry: state.reduceQualityOnRetry,
		controlledSkipThreshold: state.controlledSkipThreshold,
	};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			resolve();
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function recover(
	bus: Bus,
	playerId: string,
	state: AntiStuckState,
	session: PlaybackSession,
	generation: number,
	reason: string,
	handlers: AntiStuckRetryHandlers,
	requestId?: string,
): Promise<boolean> {
	const track = session.track;
	if (state.disposed || !state.enabled || !track || !session.isActive() || generation !== state.generation) return false;
	const retry = getRetryCount(state, track);
	bus.event(playerId, { type: BUS_EVENT.stuckDetected, session: session.snapshot(), reason });
	if (retry >= state.maxRetries) {
		await handlers.skip({ session, track, retry, reason });
		return false;
	}
	state.recordFailure(trackKey(track), retry + 1);
	bus.event(playerId, { type: BUS_EVENT.recoveryStarted, session: session.snapshot() });
	if (requestId) {
		state.debug?.(
			`[AntiStuckController] ${traceBusSignal(BUS_OUTPUT.recoveryRetrying)} guild=${playerId} attempt=${retry + 1} reason=${reason}`,
		);
		bus.emitOutput({
			type: BUS_OUTPUT.recoveryRetrying,
			requestId,
			playerId,
			session: session.snapshot(),
			attempt: retry + 1,
		});
	}
	if (state.retryDelayMs > 0) await delay(state.retryDelayMs, AbortSignal.any([session.signal, state.lifecycleAbort.signal]));
	if (state.disposed || !session.isActive() || generation !== state.generation) return false;
	const ok = await handlers.retry({ session, track, retry: retry + 1, reason });
	if (ok) {
		state.failures.delete(trackKey(track));
		if (requestId) {
			state.debug?.(`[AntiStuckController] ${traceBusSignal(BUS_OUTPUT.recoveryRecovered)} guild=${playerId}`);
			bus.emitOutput({
				type: BUS_OUTPUT.recoveryRecovered,
				requestId,
				playerId,
				session: session.snapshot(),
			});
		}
		return true;
	}
	if (session.isActive()) {
		bus.event(playerId, { type: BUS_EVENT.recoveryFailed, session: session.snapshot() });
		if (requestId) {
			state.debug?.(`[AntiStuckController] ${traceBusSignal(BUS_OUTPUT.recoveryFailed)} guild=${playerId}: ${reason}`);
			bus.emitOutput({
				type: BUS_OUTPUT.recoveryFailed,
				requestId,
				playerId,
				session: session.snapshot(),
				error: new Error(reason),
			});
		}
		if (getRetryCount(state, track) >= state.controlledSkipThreshold)
			await handlers.skip({ session, track, retry: getRetryCount(state, track), reason });
	}
	return false;
}

/** Shared anti-stuck controller with per-player retry accounting and timers. */
export class AntiStuckController {
	public readonly states = new Map<string, AntiStuckState>();

	public constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			if (context.signal.aborted || (action.type !== "STOP" && action.type !== "SEEK")) return;
			const state = this.states.get(context.playerId);
			if (!state) return;
			clearTimer(state);
			state.generation++;
		});
		bus.registerQuery(PLAYER_QUERY.retryPolicy, (playerId) => {
			const state = this.states.get(playerId);
			return state ? policy(state) : {};
		});
		bus.registerRpc<AntiStuckReportRequest, boolean>(CONTROLLER_RPC.antiStuckReport, ({ session, reason, handlers }, ctx) => {
			const state = this.states.get(ctx.playerId);
			return state ? this.reportStuck(ctx.playerId, state, session, reason, handlers) : false;
		});
	}

	attach(playerId: string, options: Omit<AntiStuckControllerOptions, "bus"> = {}): void {
		this.detach(playerId);
		const state: AntiStuckState = {
			enabled: options.enabled ?? true,
			maxRetries: Math.max(0, options.maxRetries ?? 2),
			// Avoid premature recovery while the audio buffer is naturally filling.
			retryDelayMs: Math.max(0, options.retryDelayMs ?? 90000),
			reusePreloadFirst: options.reusePreloadFirst ?? true,
			reduceQualityOnRetry: options.reduceQualityOnRetry ?? true,
			controlledSkipThreshold: Math.max(1, options.controlledSkipThreshold ?? 3),
			failures: new Map(),
			timer: null,
			generation: 0,
			lifecycleAbort: new AbortController(),
			debug: options.debug,
			disposed: false,
			recordFailure: (key, value) => {
				if (!state.failures.has(key) && state.failures.size >= MAX_FAILURE_ENTRIES) {
					const oldest = state.failures.keys().next().value;
					if (oldest !== undefined) state.failures.delete(oldest);
				}
				state.failures.set(key, value);
			},
		};
		this.states.set(playerId, state);
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.disposed = true;
		state.lifecycleAbort.abort();
		reset(state);
	}

	private reportStuck(
		playerId: string,
		state: AntiStuckState,
		session: PlaybackSession,
		reason: string,
		handlers: AntiStuckRetryHandlers,
	): Promise<boolean> {
		return recover(this.bus, playerId, state, session, ++state.generation, reason, handlers);
	}
}
