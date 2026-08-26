import { EventEmitter } from "events";
import type { PlayerEvents, Track } from "../types";
import type { PlaybackSessionSnapshot } from "./PlaybackSession";

/** Public action messages accepted by the playback architecture. */
export type PlayerAction =
	| { type: "PLAY"; track?: Track; query?: string }
	| { type: "SKIP" }
	| { type: "STOP" }
	| { type: "PAUSE" }
	| { type: "RESUME" }
	| { type: "SEEK"; position: number }
	| { type: "SET_VOLUME"; volume: number };

export type PlayerActionType = PlayerAction["type"];

export type PlayerEvent =
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "STREAM_ABORTED"; session: PlaybackSessionSnapshot }
	| { type: "STUCK_DETECTED"; session: PlaybackSessionSnapshot; reason?: string }
	| { type: "RECOVERY_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "RECOVERY_FAILED"; session: PlaybackSessionSnapshot; error?: Error };

export type PlayerEventType = PlayerEvent["type"];

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

export type PlayerQuery = keyof PlayerQueryMap;

/** Lifecycle notifications are intentionally carried by the same event lane. */
export interface PlayerLifecycleEvents {
	initialized: [];
	ready: [];
	destroyed: [];
	stateChanged: [];
}

export type PlayerBusEvents = PlayerEvents & PlayerLifecycleEvents & {
	actionDispatched: [action: PlayerAction];
};

type ActionHandler<A extends PlayerAction> = (action: A) => void | Promise<void>;
type QueryHandler<T> = () => T | Promise<T>;
type EventHandler<E extends PlayerEvent> = (event: E) => void;

/**
 * Communication hub for one Player instance.
 *
 * Player is the public facade. Everything behind it communicates through this
 * hub using four explicit lanes: action, event, query and subscription.
 * Controllers never need a direct reference to sibling controllers.
 */
export class PlayerBus extends EventEmitter {
	private readonly actionHandlers = new Map<PlayerActionType, Set<ActionHandler<any>>>();
	private readonly eventHandlers = new Map<PlayerEventType, Set<EventHandler<any>>>();
	private readonly queryHandlers = new Map<PlayerQuery, QueryHandler<any>>();

	public on<K extends keyof PlayerBusEvents>(
		event: K,
		listener: (...args: PlayerBusEvents[K]) => void,
	): this {
		return super.on(event, listener);
	}

	public once<K extends keyof PlayerBusEvents>(
		event: K,
		listener: (...args: PlayerBusEvents[K]) => void,
	): this {
		return super.once(event, listener);
	}

	public emit<K extends keyof PlayerBusEvents>(event: K, ...args: PlayerBusEvents[K]): boolean {
		return super.emit(event, ...args);
	}

	public onAction<K extends PlayerActionType>(
		type: K | ActionHandler<Extract<PlayerAction, { type: K }>>,
		handler?: ActionHandler<Extract<PlayerAction, { type: K }>>,
	): () => void {
		const actionType = typeof type === "string" ? type : undefined;
		if (!actionType) {
			const genericHandler = type as ActionHandler<Extract<PlayerAction, { type: K }>>;
			for (const action of ["PLAY", "SKIP", "STOP", "PAUSE", "RESUME", "SEEK", "SET_VOLUME"] as PlayerActionType[]) {
				this.addActionHandler(action, genericHandler);
			}
			return () => {
				for (const action of ["PLAY", "SKIP", "STOP", "PAUSE", "RESUME", "SEEK", "SET_VOLUME"] as PlayerActionType[]) {
					this.removeActionHandler(action, genericHandler);
				}
			};
		}
		if (!handler) throw new TypeError(`Missing handler for action ${actionType}`);
		return this.addActionHandler(actionType, handler);
	}

	private addActionHandler<K extends PlayerActionType>(
		type: K,
		handler: ActionHandler<Extract<PlayerAction, { type: K }>>,
	): () => void {
		let handlers = this.actionHandlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.actionHandlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => this.removeActionHandler(type, handler);
	}

	private removeActionHandler(type: PlayerActionType, handler: ActionHandler<any>): void {
		const handlers = this.actionHandlers.get(type);
		handlers?.delete(handler);
		if (handlers?.size === 0) this.actionHandlers.delete(type);
	}

	/** Dispatch an action through the action lane. */
	public async action(message: PlayerAction): Promise<void> {
		this.emit("actionDispatched", message);
		const handlers = this.actionHandlers.get(message.type);
		if (!handlers?.size) return;
		await Promise.all([...handlers].map((handler) => handler(message)));
	}

	/** Backward-compatible name for action(). */
	public dispatch(message: PlayerAction): Promise<void> {
		return this.action(message);
	}

	/** Publish an architecture event. */
	public event(message: PlayerEvent): boolean {
		const handlers = this.eventHandlers.get(message.type);
		if (handlers) {
			for (const handler of [...handlers]) handler(message);
		}
		return this.emit(message.type as keyof PlayerBusEvents, message as never);
	}

	/** Subscribe to one architecture event type. */
	public subscribe<K extends PlayerEventType>(type: K, listener: EventHandler<Extract<PlayerEvent, { type: K }>>): () => void {
		let handlers = this.eventHandlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.eventHandlers.set(type, handlers);
		}
		handlers.add(listener);
		return () => {
			handlers?.delete(listener);
			if (handlers?.size === 0) this.eventHandlers.delete(type);
		};
	}

	/** Legacy event publisher retained for PlayerEvents/lifecycle notifications. */
	public publish<K extends keyof PlayerBusEvents>(event: K, ...args: PlayerBusEvents[K]): boolean {
		return this.emit(event, ...args);
	}

	public registerQuery<K extends PlayerQuery>(query: K, handler: QueryHandler<PlayerQueryMap[K]>): () => void {
		this.queryHandlers.set(query, handler);
		return () => {
			if (this.queryHandlers.get(query) === handler) this.queryHandlers.delete(query);
		};
	}

	public async query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		const handler = this.queryHandlers.get(query) as QueryHandler<PlayerQueryMap[K]> | undefined;
		if (!handler) throw new Error(`No playback query handler registered for \"${query}\"`);
		return handler();
	}

	public clear(): void {
		this.actionHandlers.clear();
		this.eventHandlers.clear();
		this.queryHandlers.clear();
		this.removeAllListeners();
	}
}
