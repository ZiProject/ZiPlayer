import { EventEmitter } from "events";
import type { Track, PlayerEvents } from "../types";

/**
 * Commands understood by the playback orchestration layer.
 *
 * The bus is intentionally transport-only for now. Player remains the
 * compatibility facade while commands are migrated incrementally.
 */
export type PlayerAction =
	| { type: "play"; track?: Track; query?: string }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "skip" }
	| { type: "stop" }
	| { type: "seek"; position: number }
	| { type: "setVolume"; volume: number };

export interface PlayerQueryMap {
	currentTrack: Track | null;
	position: number | null;
	volume: number;
	isPlaying: boolean;
	isPaused: boolean;
}

export type PlayerQuery = keyof PlayerQueryMap;

export type PlayerBusEvents = PlayerEvents & {
	actionDispatched: [action: PlayerAction];
};

type Handler<A extends PlayerAction = PlayerAction> = (action: A) => void | Promise<void>;

/**
 * Typed internal bus used to decouple Player's public API from playback
 * orchestration. It provides three primitives:
 *
 * - dispatch(action): send a command to the current handler
 * - on(event): subscribe to typed playback events
 * - query(name): synchronously read a typed playback value
 *
 * The bus does not own playback state. That ownership moves to the
 * orchestrator/session controllers in subsequent refactor steps.
 */
export class PlayerBus extends EventEmitter {
	private actionHandler: Handler | null = null;
	private readonly queryHandlers = new Map<PlayerQuery, () => unknown>();

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

	public setActionHandler(handler: Handler): () => void {
		this.actionHandler = handler;

		return () => {
			if (this.actionHandler === handler) this.actionHandler = null;
		};
	}

	public async dispatch(action: PlayerAction): Promise<void> {
		this.emit("actionDispatched", action);

		if (!this.actionHandler) return;
		await this.actionHandler(action);
	}

	public registerQuery<K extends PlayerQuery>(query: K, handler: () => PlayerQueryMap[K]): () => void {
		this.queryHandlers.set(query, handler);

		return () => {
			if (this.queryHandlers.get(query) === handler) this.queryHandlers.delete(query);
		};
	}

	public query<K extends PlayerQuery>(query: K): PlayerQueryMap[K] {
		const handler = this.queryHandlers.get(query) as (() => PlayerQueryMap[K]) | undefined;
		if (!handler) throw new Error(`No playback query handler registered for "${query}"`);
		return handler();
	}

	public clear(): void {
		this.actionHandler = null;
		this.queryHandlers.clear();
		this.removeAllListeners();
	}
}
