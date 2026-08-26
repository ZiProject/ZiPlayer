import { EventEmitter } from "events";
import type { PlayerEvents, Track } from "../types";

/**
 * Actions are messages sent through the playback communication hub.
 *
 * `PlayerAction` deliberately describes a message category, not a command
 * bus contract. The bus also carries events, lifecycle notifications and
 * queries, so no architectural assumption is made about command -> handler
 * semantics.
 */
export type PlayerAction =
	| { type: "play"; track?: Track; query?: string }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "skip" }
	| { type: "stop" }
	| { type: "seek"; position: number }
	| { type: "setVolume"; volume: number };

export type PlayerActionType = PlayerAction["type"];

export interface PlayerQueryMap {
	currentTrack: Track | null;
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

/**
 * Communication hub for one Player instance.
 *
 * Flow:
 *
 *   Player -> PlayerBus -> Action / Event / Query -> PlaybackOrchestrator
 *                                      |               |
 *                                      +-> controllers +-> PlayerBus
 *
 * PlayerBus is deliberately transport/orchestration-neutral. It does not own
 * playback state and does not know about PlaybackOrchestrator, Queue,
 * TrackLoader, StreamController, AntiStuck, Transition or Preload.
 *
 * Actions, events and lifecycle notifications use typed message channels.
 * Queries use registered providers and may be synchronous or asynchronous.
 * This lets the playback implementation migrate behind the bus incrementally
 * without changing Player's public API.
 */
export class PlayerBus extends EventEmitter {
	private readonly actionHandlers = new Map<PlayerActionType, Set<ActionHandler<any>>>();
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

	/** Register a handler for one action message type. */
	public onAction<K extends PlayerActionType>(
		type: K,
		handler: ActionHandler<Extract<PlayerAction, { type: K }>>,
	): () => void {
		let handlers = this.actionHandlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.actionHandlers.set(type, handlers);
		}

		handlers.add(handler);
		return () => {
			handlers?.delete(handler);
			if (handlers?.size === 0) this.actionHandlers.delete(type);
		};
	}

	/** Publish an action message to all interested action subscribers. */
	public async dispatch(action: PlayerAction): Promise<void> {
		this.emit("actionDispatched", action);

		const handlers = this.actionHandlers.get(action.type);
		if (!handlers?.size) return;

		await Promise.all([...handlers].map((handler) => handler(action)));
	}

	/** Publish an event or lifecycle notification through the event lane. */
	public publish<K extends keyof PlayerBusEvents>(event: K, ...args: PlayerBusEvents[K]): boolean {
		return this.emit(event, ...args);
	}

	/** Register a provider for a query message. */
	public registerQuery<K extends PlayerQuery>(query: K, handler: QueryHandler<PlayerQueryMap[K]>): () => void {
		this.queryHandlers.set(query, handler);

		return () => {
			if (this.queryHandlers.get(query) === handler) this.queryHandlers.delete(query);
		};
	}

	/** Request current state through a typed query message. */
	public async query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		const handler = this.queryHandlers.get(query) as QueryHandler<PlayerQueryMap[K]> | undefined;
		if (!handler) throw new Error(`No playback query handler registered for "${query}"`);
		return handler();
	}

	/** Remove all routes, providers and subscriptions owned by this bus. */
	public clear(): void {
		this.actionHandlers.clear();
		this.queryHandlers.clear();
		this.removeAllListeners();
	}
}
