import type { VoiceChannel } from "../types";
import type { Track } from "../types";
import type { VoiceConnection, AudioPlayerState } from "@discordjs/voice";
import type { PlaybackSessionSnapshot } from "./PlaybackSession";

/**
 * PlayerBus — the interconnect between `Player` (the "CPU") and its
 * Controllers (the "peripherals": Connection, Playback, Stream, Queue,
 * AntiStuck, Preload, Transition...).
 *
 * The mental model is a hardware bus, e.g. the link between a CPU and its
 * PCH/chipset, or between a CPU and RAM: nobody talks peer-to-peer, every
 * signal travels over a small set of standardized "lines" so that any
 * peripheral can be swapped, added, or removed without rewiring the others.
 * PlayerBus exposes five such lines:
 *
 *  - Input   `emitInput` / `onInput`   — one-shot command, Player -> one
 *    addressed peripheral (e.g. "[Player]->[Connection]:connect"). Like a
 *    chipset's control lines: a single target decodes and acts on it.
 *  - Output  `emitOutput` / `onOutput` — the addressed peripheral's reply
 *    back to whoever is awaiting it (e.g. "[Connection]->[Player]:connected").
 *  - Action  `action` / `onAction`     — the arbitrated command channel.
 *    `PlayerAction.ts` is the bus arbiter: it queues, prioritizes, and lets
 *    CRITICAL actions (SKIP/STOP) preempt in-flight work, the software
 *    analogue of interrupt/DMA arbitration on a real bus.
 *  - Event   `event` / `publish` / `subscribe` — a broadcast/interrupt line.
 *    Multicast, no addressee: any number of controllers or external
 *    listeners can subscribe without the publisher knowing who's listening.
 *  - Query   `registerQuery` / `query` — a synchronous, memory-mapped-style
 *    read of current state (current track, position, volume...) without
 *    issuing a command or waiting for round-trip event traffic.
 *
 * Because every channel is a plain discriminated union keyed by `type`,
 * adding a new signal is additive: extend the relevant union below and wire
 * the new controller through the bus in `PlayerRuntimeController`. Nothing
 * else has to change.
 */

export type PlayerRequestId = string;
export type PlayerSessionId = string;

/** Priority controls command arbitration. Higher values may preempt lower work. */
export enum PlayerActionPriority {
	BACKGROUND = 0,
	NORMAL = 10,
	HIGH = 50,
	CRITICAL = 100,
}

export interface PlayerActionExecutionContext {
	readonly signal: AbortSignal;
	readonly priority: PlayerActionPriority;
	readonly requestId: PlayerRequestId;
}

export type PlayerAction =
	| { type: "PLAY"; track?: Track; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "PAUSE"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "RESUME"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SEEK"; position: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "STOP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SKIP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SET_VOLUME"; volume: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId };

/** The discriminant of every action, e.g. for logging/telemetry without importing the full union. */
export type PlayerActionType = PlayerAction["type"];

export type PlayerInput = PlayerConnectionInput | PlayerPreloadInput | PlayerRecoveryInput;

export type PlayerConnectionInput =
	| { type: "[Player]->[Connection]:connect"; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: "[Player]->[Connection]:disconnect"; requestId: PlayerRequestId; reason?: string }
	| { type: "[Player]->[Connection]:reconnect"; requestId: PlayerRequestId; channel: VoiceChannel };

export type PlayerConnectionOutput =
	| { type: "[Connection]->[Player]:connecting"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel }
	| { type: "[Connection]->[Player]:connected"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel; connection: VoiceConnection }
	| { type: "[Connection]->[Player]:disconnected"; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| { type: "[Connection]->[Player]:error"; requestId: PlayerRequestId; sessionId?: PlayerSessionId; operation: "connect" | "disconnect" | "reconnect"; error: Error };

/**
 * Reserved channel — types only, not wired yet. Once `PreloadController`
 * emits these through `bus.onInput`/`bus.emitOutput`, `Player`/`PlaybackOrchestrator`
 * can `bus.request()` a specific track's preload instead of the current
 * fire-and-forget `preloadController.preload()` + `preloadStateChanged` broadcast.
 */
export type PlayerPreloadInput = { type: "[Player]->[Preload]:request"; requestId: PlayerRequestId; track: Track };
export type PlayerPreloadOutput =
	| { type: "[Preload]->[Player]:loading"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:ready"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:failed"; requestId: PlayerRequestId; track: Track; error: Error };

/**
 * Reserved channel — types only, not wired yet. Once `AntiStuckController`
 * emits these, callers can `bus.request()` a recovery attempt and watch its
 * retries via `onProgress` instead of passing ad-hoc retry/skip handlers.
 */
export type PlayerRecoveryInput = { type: "[Player]->[Recovery]:recover"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; reason: string };
export type PlayerRecoveryOutput =
	| { type: "[Recovery]->[Player]:retrying"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; attempt: number }
	| { type: "[Recovery]->[Player]:recovered"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: "[Recovery]->[Player]:failed"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; error: Error };

/**
 * Request/reply contracts for `PlayerBus.request()`.
 *
 * On a split-transaction hardware bus, a read request and its data response
 * are two independent bus phases correlated by a transaction tag, so other
 * traffic can interleave while the request is outstanding. `requestId` plays
 * that role here: `request()` emits one `PlayerInput` and resolves/rejects
 * with the first `PlayerOutput` that matches the registered `success`/`error`
 * type AND carries the same `requestId`. Any registered `progress` type in
 * between is forwarded to `options.onProgress` without settling the promise —
 * the bus equivalent of a "wait" or "split" signal on an in-flight transaction.
 *
 * Every input handled here MUST carry a `requestId`, and the controller that
 * owns the matching outputs MUST echo it back — that's the whole contract.
 * Linking a new peripheral means adding its Input/Output types above plus one
 * entry to `PlayerRequestReplyMap` (types) and `PLAYER_REQUEST_REPLY_TABLE`
 * (runtime); nothing else on the bus needs to change.
 */
export interface PlayerRequestReplyMap {
	"[Player]->[Connection]:connect": {
		success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>;
		progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }>;
	};
	"[Player]->[Connection]:disconnect": {
		success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:disconnected" }>;
	};
	"[Player]->[Connection]:reconnect": {
		success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>;
		progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }>;
	};
	"[Player]->[Preload]:request": {
		success: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:ready" }>;
		progress: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:loading" }>;
	};
	"[Player]->[Recovery]:recover": {
		success: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:recovered" }>;
		progress: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:retrying" }>;
	};
}

export type PlayerRequestInputType = keyof PlayerRequestReplyMap;
type PlayerRequestProgress<K extends PlayerRequestInputType> = PlayerRequestReplyMap[K] extends { progress: infer P } ? P : never;

interface PlayerRequestReplyTableEntry {
	success: PlayerOutput["type"];
	error: PlayerOutput["type"];
	progress?: PlayerOutput["type"];
}

/** Runtime mirror of {@link PlayerRequestReplyMap}: which output `type`s settle (or narrate) a given input's request. */
const PLAYER_REQUEST_REPLY_TABLE: Record<PlayerRequestInputType, PlayerRequestReplyTableEntry> = {
	"[Player]->[Connection]:connect": { success: "[Connection]->[Player]:connected", error: "[Connection]->[Player]:error", progress: "[Connection]->[Player]:connecting" },
	"[Player]->[Connection]:disconnect": { success: "[Connection]->[Player]:disconnected", error: "[Connection]->[Player]:error" },
	"[Player]->[Connection]:reconnect": { success: "[Connection]->[Player]:connected", error: "[Connection]->[Player]:error", progress: "[Connection]->[Player]:connecting" },
	"[Player]->[Preload]:request": { success: "[Preload]->[Player]:ready", error: "[Preload]->[Player]:failed", progress: "[Preload]->[Player]:loading" },
	"[Player]->[Recovery]:recover": { success: "[Recovery]->[Player]:recovered", error: "[Recovery]->[Player]:failed", progress: "[Recovery]->[Player]:retrying" },
};

export interface PlayerRequestOptions<K extends PlayerRequestInputType = PlayerRequestInputType> {
	/** Reject with {@link PlayerBusRequestError} if no matching reply arrives in time. */
	timeoutMs?: number;
	/** External cancellation; rejects immediately (or as soon as it fires) with an AbortError. */
	signal?: AbortSignal;
	/** Called for each intermediate reply (e.g. "connecting") before the request settles. Never settles the promise itself. */
	onProgress?: (event: PlayerRequestProgress<K>) => void;
}

export type PlayerBusRequestErrorReason = "timeout" | "aborted" | "disposed" | "unhandled";

export class PlayerBusRequestError extends Error {
	public constructor(
		public readonly reason: PlayerBusRequestErrorReason,
		public readonly inputType: string,
		message: string,
	) {
		super(message);
		this.name = "PlayerBusRequestError";
	}
}

/** State snapshot published by PreloadController after a preload attempt. */
export interface PlayerPreloadState {
	requestedTrack: Track | null;
	valid: boolean;
}

// Event unions are grouped by the controller/domain that owns them, so a
// given controller's contract lives next to the others it ships with instead
// of being an undifferentiated flat list.
export type PlayerLifecycleEvents =
	| { type: "initialized" }
	| { type: "ready" }
	| { type: "destroyed" };

export type PlayerPlaybackEvents =
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "STREAM_ABORTED"; session: PlaybackSessionSnapshot }
	| { type: "playbackStateChanged"; session: PlaybackSessionSnapshot }
	| { type: "playbackSessionCreated"; session: PlaybackSessionSnapshot }
	| { type: "trackRequested"; track: Track; session: PlaybackSessionSnapshot }
	| { type: "stateChanged"; oldState: AudioPlayerState; newState: AudioPlayerState };

export type PlayerRecoveryEvents =
	| { type: "STUCK_DETECTED"; session: PlaybackSessionSnapshot; reason: string }
	| { type: "RECOVERY_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "RECOVERY_FAILED"; session: PlaybackSessionSnapshot };

export type PlayerPreloadEvents =
	| { type: "preloadStateChanged"; state: PlayerPreloadState }
	| { type: "preloadPromoted"; track: Track }
	| { type: "preloadCancelled" };

export type PlayerQueueEvents = { type: "queueChanged"; queue: Track[] };
export type PlayerVolumeEvents = { type: "volumeRequested"; volume: number };

export type PlayerEvent =
	| PlayerLifecycleEvents
	| PlayerPlaybackEvents
	| PlayerRecoveryEvents
	| PlayerPreloadEvents
	| PlayerQueueEvents
	| PlayerVolumeEvents;

export type PlayerEventType = PlayerEvent["type"];

export type PlayerEventArgsMap = {
	[K in PlayerEventType]: K extends "initialized" | "ready" | "destroyed" | "preloadCancelled"
		? []
		: K extends "TRACK_LOADING" | "TRACK_LOADED" | "TRACK_STARTED" | "TRACK_END" | "STREAM_ABORTED" | "playbackStateChanged" | "playbackSessionCreated" | "RECOVERY_STARTED" | "RECOVERY_FAILED"
			? [session: PlaybackSessionSnapshot]
			: K extends "TRACK_ERROR"
				? [session: PlaybackSessionSnapshot, error: Error]
				: K extends "STUCK_DETECTED"
					? [session: PlaybackSessionSnapshot, reason: string]
					: K extends "trackRequested"
						? [track: Track, session: PlaybackSessionSnapshot]
						: K extends "queueChanged"
							? [queue: Track[]]
							: K extends "volumeRequested"
								? [value: number]
								: K extends "stateChanged"
									? [oldState: AudioPlayerState, newState: AudioPlayerState]
									: K extends "preloadStateChanged"
										? [state: PlayerPreloadState]
										: K extends "preloadPromoted"
											? [track: Track]
											: never;
};

/** Every message type PlayerBus can carry across its Input/Output/Event lines. */
export type PlayerBusEvents = PlayerInput | PlayerOutput;

export type PlayerQuery = keyof PlayerQueryMap;
export interface PlayerQueryMap {
	currentTrack: Track | null;
	playerState: PlaybackSessionSnapshot["status"] | "idle";
	queue: Track[];
	playbackSession: PlaybackSessionSnapshot | null;
	position: number | null;
	volume: number;
	isPlaying: boolean;
	isPaused: boolean;
}

export type PlayerQueryHandler<K extends PlayerQuery> = () => PlayerQueryMap[K] | Promise<PlayerQueryMap[K]>;

export class PlayerBus {
	private readonly inputListeners = new Map<PlayerInput["type"], Set<(event: PlayerInput) => void | Promise<void>>>();
	private readonly outputListeners = new Map<PlayerOutput["type"], Set<(event: PlayerOutput) => void>>();
	private readonly eventListeners = new Map<PlayerEventType, Set<(event: PlayerEvent) => void>>();
	private readonly actionListeners = new Set<(action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>>();
	private readonly queryHandlers = new Map<PlayerQuery, Set<PlayerQueryHandler<any>>>();
	private readonly pendingRequests = new Set<() => void>();
	private disposed = false;

	public emitInput(event: PlayerInput): void {
		if (this.disposed) return;
		this.dispatch(this.inputListeners, event.type, event);
	}

	public emitOutput(event: PlayerOutput): void {
		if (this.disposed) return;
		this.dispatch(this.outputListeners, event.type, event);
	}

	public onInput<K extends PlayerInput["type"]>(type: K, handler: (event: Extract<PlayerInput, { type: K }>) => void | Promise<void>): () => void {
		return this.addListener(this.inputListeners, type, handler as (event: PlayerInput) => void | Promise<void>);
	}

	public onOutput<K extends PlayerOutput["type"]>(type: K, handler: (event: Extract<PlayerOutput, { type: K }>) => void): () => void {
		return this.addListener(this.outputListeners, type, handler as (event: PlayerOutput) => void);
	}

	/**
	 * Emit an addressed `PlayerInput` and resolve with the correlated
	 * `PlayerOutput` reply — the bus-transaction pattern: one request phase,
	 * one response phase, tied together by `input.requestId`.
	 *
	 * This replaces the hand-rolled "emitInput + two onOutput listeners +
	 * manual cleanup" pattern that used to live in callers like
	 * `Player.connect()`; the correlation, cleanup, timeout, and abort
	 * handling are centralized here instead of duplicated per call site.
	 */
	public request<K extends PlayerRequestInputType>(
		input: Extract<PlayerInput, { type: K }>,
		options: PlayerRequestOptions = {},
	): Promise<PlayerRequestReplyMap[K]["success"]> {
		if (this.disposed) {
			return Promise.reject(new PlayerBusRequestError("disposed", input.type, `PlayerBus is disposed; cannot request "${input.type}"`));
		}

		const requestId = (input as { requestId?: PlayerRequestId }).requestId;
		if (!requestId) {
			return Promise.reject(new PlayerBusRequestError("unhandled", input.type, `Input "${input.type}" has no requestId; request/reply correlation requires one`));
		}

		const contract = PLAYER_REQUEST_REPLY_TABLE[input.type];
		if (!contract) {
			return Promise.reject(new PlayerBusRequestError("unhandled", input.type, `No request/reply contract registered for input "${input.type}"`));
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanups: Array<() => void> = [];
			const settle = (run: () => void): void => {
				if (settled) return;
				settled = true;
				for (const cleanup of cleanups.splice(0)) cleanup();
				run();
			};

			const disposeAbort = (): void => settle(() => reject(new PlayerBusRequestError("disposed", input.type, `PlayerBus was disposed while awaiting reply to "${input.type}"`)));
			this.pendingRequests.add(disposeAbort);
			cleanups.push(() => this.pendingRequests.delete(disposeAbort));

			if (options.timeoutMs !== undefined) {
				const timer = setTimeout(() => {
					settle(() => reject(new PlayerBusRequestError("timeout", input.type, `Timed out after ${options.timeoutMs}ms awaiting reply to "${input.type}"`)));
				}, options.timeoutMs);
				cleanups.push(() => clearTimeout(timer));
			}

			if (options.signal) {
				if (options.signal.aborted) {
					settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted before it settled`)));
					return;
				}
				const onAbort = (): void => settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted before it settled`)));
				options.signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
			}

			for (const successType of contract.success) {
				cleanups.push(
					this.onOutput(successType as never, (event: any) => {
						if (event.requestId !== requestId) return;
						settle(() => resolve(event));
					}),
				);
			}
			for (const errorType of contract.error) {
				cleanups.push(
					this.onOutput(errorType as never, (event: any) => {
						if (event.requestId !== requestId) return;
						settle(() => reject(event.error instanceof Error ? event.error : new PlayerBusRequestError("unhandled", input.type, String(event.error ?? "request failed"))));
					}),
				);
			}

			this.emitInput(input);
		});
	}

	public action(action: PlayerAction, context?: PlayerActionExecutionContext): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const execution: PlayerActionExecutionContext = context ?? {
			signal: new AbortController().signal,
			priority: action.priority ?? PlayerActionPriority.NORMAL,
			requestId: action.requestId ?? createPlayerRequestId(),
		};
		return Promise.all([...this.actionListeners].map((handler) => handler(action, execution))).then(() => undefined);
	}

	public onAction(handler: (action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>): () => void {
		this.actionListeners.add(handler);
		return () => this.actionListeners.delete(handler);
	}

	public event<K extends PlayerEventType>(event: Extract<PlayerEvent, { type: K }>): void {
		if (this.disposed) return;
		this.dispatch(this.eventListeners, event.type, event);
	}

	public publish<K extends PlayerEventType>(type: K, ...args: PlayerEventArgsMap[K]): void {
		this.event(this.toEvent(type, args));
	}

	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.addListener(this.eventListeners, type, listener as (event: PlayerEvent) => void);
	}

	public registerQuery<K extends PlayerQuery>(query: K, handler: PlayerQueryHandler<K>): () => void {
		let handlers = this.queryHandlers.get(query);
		if (!handlers) {
			handlers = new Set();
			this.queryHandlers.set(query, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	public async query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		if (this.disposed) return undefined as unknown as PlayerQueryMap[K];
		const handlers = this.queryHandlers.get(query);
		if (!handlers?.size) return undefined as unknown as PlayerQueryMap[K];
		const handler = [...handlers][0] as PlayerQueryHandler<K>;
		return handler();
	}

	public clear(): void {
		for (const abort of [...this.pendingRequests]) abort();
		this.inputListeners.clear();
		this.outputListeners.clear();
		this.eventListeners.clear();
		this.actionListeners.clear();
		this.queryHandlers.clear();
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
	}

	private toEvent<K extends PlayerEventType>(type: K, args: PlayerEventArgsMap[K]): Extract<PlayerEvent, { type: K }> {
		switch (type) {
			case "initialized":
			case "ready":
			case "destroyed":
			case "preloadCancelled":
				return { type } as Extract<PlayerEvent, { type: K }>;
			case "TRACK_LOADING":
			case "TRACK_LOADED":
			case "TRACK_STARTED":
			case "TRACK_END":
			case "STREAM_ABORTED":
			case "playbackStateChanged":
			case "playbackSessionCreated":
			case "RECOVERY_STARTED":
			case "RECOVERY_FAILED":
				return { type, session: args[0] } as Extract<PlayerEvent, { type: K }>;
			case "TRACK_ERROR":
				return { type, session: args[0], error: args[1] } as Extract<PlayerEvent, { type: K }>;
			case "STUCK_DETECTED":
				return { type, session: args[0], reason: args[1] } as Extract<PlayerEvent, { type: K }>;
			case "trackRequested":
				return { type, track: args[0], session: args[1] } as Extract<PlayerEvent, { type: K }>;
			case "queueChanged":
				return { type, queue: args[0] } as Extract<PlayerEvent, { type: K }>;
			case "volumeRequested":
				return { type, volume: args[0] } as Extract<PlayerEvent, { type: K }>;
			case "stateChanged":
				return { type, oldState: args[0], newState: args[1] } as Extract<PlayerEvent, { type: K }>;
			case "preloadStateChanged":
				return { type, state: args[0] } as Extract<PlayerEvent, { type: K }>;
			case "preloadPromoted":
				return { type, track: args[0] } as Extract<PlayerEvent, { type: K }>;
			default:
				throw new Error(`Unknown PlayerBus event: ${String(type)}`);
		}
	}

	private addListener<T extends string, E>(map: Map<T, Set<(event: E) => any>>, type: T, handler: (event: E) => any): () => void {
		let listeners = map.get(type);
		if (!listeners) {
			listeners = new Set();
			map.set(type, listeners);
		}
		listeners.add(handler);
		return () => listeners?.delete(handler);
	}

	private dispatch<T extends string, E>(map: Map<T, Set<(event: E) => any>>, type: T, event: E): void {
		for (const listener of map.get(type) ?? []) void listener(event);
	}
}

export type PlayerOutput = PlayerConnectionOutput | PlayerEvent;

export const createPlayerRequestId = (): PlayerRequestId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const createPlayerSessionId = (): PlayerSessionId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;