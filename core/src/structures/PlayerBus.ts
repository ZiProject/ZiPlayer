import type { VoiceChannel } from "../types";
import type { Track } from "../types";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlaybackSessionSnapshot } from "./PlaybackSession";

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

export type PlayerInput = PlayerConnectionInput;

export type PlayerConnectionInput =
	| { type: "[Player]->[Connection]:connect"; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: "[Player]->[Connection]:disconnect"; requestId: PlayerRequestId; reason?: string }
	| { type: "[Player]->[Connection]:reconnect"; requestId: PlayerRequestId; channel: VoiceChannel };

export type PlayerConnectionOutput =
	| { type: "[Connection]->[Player]:connecting"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel }
	| { type: "[Connection]->[Player]:connected"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel; connection: VoiceConnection }
	| { type: "[Connection]->[Player]:disconnected"; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| { type: "[Connection]->[Player]:error"; requestId: PlayerRequestId; sessionId?: PlayerSessionId; operation: "connect" | "disconnect" | "reconnect"; error: Error };

export type PlayerEvent =
	| { type: "initialized" }
	| { type: "ready" }
	| { type: "destroyed" }
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "playbackStateChanged"; session: PlaybackSessionSnapshot }
	| { type: "playbackSessionCreated"; session: PlaybackSessionSnapshot }
	| { type: "trackRequested"; track: Track; session: PlaybackSessionSnapshot }
	| { type: "queueChanged"; queue: Track[] }
	| { type: "volumeRequested"; volume: number };

export type PlayerEventType = PlayerEvent["type"];

export type PlayerEventArgsMap = {
	[K in PlayerEventType]: K extends "initialized" | "ready" | "destroyed"
		? []
		: K extends "TRACK_LOADING" | "TRACK_LOADED" | "TRACK_STARTED" | "TRACK_END" | "playbackStateChanged" | "playbackSessionCreated"
			? [session: PlaybackSessionSnapshot]
			: K extends "TRACK_ERROR"
				? [session: PlaybackSessionSnapshot, error: Error]
				: K extends "trackRequested"
					? [track: Track, session: PlaybackSessionSnapshot]
					: K extends "queueChanged"
						? [queue: Track[]]
						: [value: number];
};

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
		if (this.disposed) return undefined as PlayerQueryMap[K];
		const handlers = this.queryHandlers.get(query);
		if (!handlers?.size) return undefined as PlayerQueryMap[K];
		const handler = [...handlers][0] as PlayerQueryHandler<K>;
		return handler();
	}

	public clear(): void {
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
				return { type } as Extract<PlayerEvent, { type: K }>;
			case "TRACK_LOADING":
			case "TRACK_LOADED":
			case "TRACK_STARTED":
			case "TRACK_END":
			case "playbackStateChanged":
			case "playbackSessionCreated":
				return { type, session: args[0] } as Extract<PlayerEvent, { type: K }>;
			case "TRACK_ERROR":
				return { type, session: args[0], error: args[1] } as Extract<PlayerEvent, { type: K }>;
			case "trackRequested":
				return { type, track: args[0], session: args[1] } as Extract<PlayerEvent, { type: K }>;
		case "queueChanged":
				return { type, queue: args[0] } as Extract<PlayerEvent, { type: K }>;
		case "volumeRequested":
				return { type, volume: args[0] } as Extract<PlayerEvent, { type: K }>;
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
