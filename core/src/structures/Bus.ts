import type {
	PlayerAction,
	PlayerActionExecutionContext,
	BusEvents,
	BusRequestErrorReason,
	BusRpcContext,
	BusRpcOptions,
	PlayerEvent,
	PlayerEventArgsMap,
	PlayerEventType,
	PlayerInput,
	PlayerOutput,
	PlayerQuery,
	PlayerQueryHandler,
	PlayerQueryMap,
	PlayerRpcMap,
	PlayerRequestId,
	PlayerRequestInputType,
	PlayerRequestOptions,
	PlayerRequestProgress,
	PlayerRequestReply,
	PlayerSessionId,
} from "../types";

import { BUS_OUTPUT, BUS_REQUEST } from "./BusContract";
import { PlayerActionPriority } from "../types/bus";
import type { BusLatencyTrace } from "../controller/BusLatencyTrace";

export type {
	PlayerAction,
	PlayerActionExecutionContext,
	BusEvents,
	BusRequestErrorReason,
	BusRpcContext,
	BusRpcOptions,
	PlayerEvent,
	PlayerEventArgsMap,
	PlayerEventType,
	PlayerInput,
	PlayerOutput,
	PlayerQuery,
	PlayerQueryHandler,
	PlayerQueryMap,
	PlayerRpcMap,
	PlayerRequestId,
	PlayerRequestInputType,
	PlayerRequestOptions,
	PlayerRequestProgress,
	PlayerRequestReply,
	PlayerSessionId,
} from "../types/bus";

export { PlayerActionPriority } from "../types/bus";

type DistributiveOmit<T, K extends PropertyKey> = T extends any ? Omit<T, K> : never;

interface RequestContract {
	success: PlayerOutput["type"];
	error: PlayerOutput["type"];
	progress?: PlayerOutput["type"];
}

const REQUESTS: Record<PlayerRequestInputType, RequestContract> = {
	[BUS_REQUEST.connectionConnect]: {
		success: BUS_OUTPUT.connectionConnected,
		error: BUS_OUTPUT.connectionError,
		progress: BUS_OUTPUT.connectionConnecting,
	},
	[BUS_REQUEST.connectionDisconnect]: {
		success: BUS_OUTPUT.connectionDisconnected,
		error: BUS_OUTPUT.connectionError,
	},
	[BUS_REQUEST.connectionReconnect]: {
		success: BUS_OUTPUT.connectionConnected,
		error: BUS_OUTPUT.connectionError,
		progress: BUS_OUTPUT.connectionConnecting,
	},
	[BUS_REQUEST.preloadRequest]: {
		success: BUS_OUTPUT.preloadReady,
		error: BUS_OUTPUT.preloadFailed,
		progress: BUS_OUTPUT.preloadLoading,
	},
	[BUS_REQUEST.recoveryRecover]: {
		success: BUS_OUTPUT.recoveryRecovered,
		error: BUS_OUTPUT.recoveryFailed,
		progress: BUS_OUTPUT.recoveryRetrying,
	},
	[BUS_REQUEST.resourceRefresh]: {
		success: BUS_OUTPUT.resourceRefreshed,
		error: BUS_OUTPUT.resourceError,
	},
};

export class BusRequestError extends Error {
	public constructor(
		public readonly reason: BusRequestErrorReason,
		public readonly inputType: string,
		message: string,
	) {
		super(message);
		this.name = "BusRequestError";
	}
}

type RpcHandler<TRequest, TResponse> = (request: TRequest, context: BusRpcContext) => TResponse | Promise<TResponse>;

/**
 * Bus is the single, process-wide message bus shared by every player.
 *
 * Controllers are singletons: they register their RPC/query/action handlers on this
 * bus exactly once (at bootstrap), and every call carries an explicit `playerId` so a
 * handler can route to the right per-player state slice it keeps internally.
 *
 * `Player` instances never touch this class directly — they get a small `Bus`
 * facade (see below) that already knows its own `playerId` and exposes the same
 * ergonomic, no-playerId-argument API the rest of the codebase is used to.
 */
export class Bus {
	private readonly inputListeners = new Map<PlayerInput["type"], Set<(event: PlayerInput) => void | Promise<void>>>();
	private readonly outputListeners = new Map<PlayerOutput["type"], Set<(event: PlayerOutput) => void>>();
	private readonly eventListeners = new Map<PlayerEventType, Map<string, Set<(event: PlayerEvent) => void>>>();
	private readonly actionListeners = new Set<
		(action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>
	>();
	private readonly queryHandlers = new Map<PlayerQuery, Set<PlayerQueryHandler<any>>>();
	private readonly rpcHandlers = new Map<string, RpcHandler<any, any>>();
	private readonly pendingRequests = new Set<() => void>();
	private latencyTrace?: BusLatencyTrace;
	private disposed = false;

	public setLatencyTrace(trace?: BusLatencyTrace): void {
		this.latencyTrace = trace;
	}

	// ---------------------------------------------------------------------
	// Input / output bridge used by `request()`. Dispatch stays global/flat:
	// each in-flight request is disambiguated by its own unique requestId, so
	// broadcasting to every listener is both correct and simple. Handlers on
	// the controller side read `event.playerId` to know which player's state
	// to act on.
	// ---------------------------------------------------------------------
	public emitInput(event: PlayerInput): void {
		if (!this.disposed) this.dispatchFlat(this.inputListeners, event.type, event);
	}
	public emitOutput(event: PlayerOutput): void {
		if (!this.disposed) this.dispatchFlat(this.outputListeners, event.type, event);
	}
	public onInput<K extends PlayerInput["type"]>(
		type: K,
		handler: (event: Extract<PlayerInput, { type: K }>) => void | Promise<void>,
	): () => void {
		return this.addFlatListener(this.inputListeners, type, handler as any);
	}
	public onOutput<K extends PlayerOutput["type"]>(
		type: K,
		handler: (event: Extract<PlayerOutput, { type: K }>) => void,
	): () => void {
		return this.addFlatListener(this.outputListeners, type, handler as any);
	}

	public request<T extends DistributiveOmit<PlayerInput, "playerId">>(
		playerId: string,
		input: T,
		options: PlayerRequestOptions<T["type"]> = {},
	): Promise<PlayerRequestReply<T["type"]>["success"]> {
		const fullInput = { ...input, playerId } as unknown as PlayerInput;
		type K = T["type"];
		if (this.disposed)
			return Promise.reject(
				new BusRequestError("disposed", fullInput.type, `Bus is disposed; cannot request "${fullInput.type}"`),
			);
		const requestId = fullInput.requestId;
		if (!requestId)
			return Promise.reject(new BusRequestError("unhandled", fullInput.type, `Input "${fullInput.type}" has no requestId`));
		const contract = REQUESTS[fullInput.type as PlayerRequestInputType];
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanups: Array<() => void> = [];
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				for (const cleanup of cleanups.splice(0)) cleanup();
				this.pendingRequests.delete(cancel);
				fn();
			};
			const cancel = () =>
				settle(() =>
					reject(new BusRequestError("disposed", fullInput.type, `Bus was disposed while awaiting reply to "${fullInput.type}"`)),
				);
			this.pendingRequests.add(cancel);
			cleanups.push(() => this.pendingRequests.delete(cancel));
			if (options.timeoutMs !== undefined) {
				const timer = setTimeout(
					() =>
						settle(() =>
							reject(
								new BusRequestError(
									"timeout",
									fullInput.type,
									`Timed out after ${options.timeoutMs}ms awaiting reply to "${fullInput.type}"`,
								),
							),
						),
					options.timeoutMs,
				);
				cleanups.push(() => clearTimeout(timer));
			}
			if (options.signal) {
				if (options.signal.aborted) {
					settle(() => reject(new BusRequestError("aborted", fullInput.type, `Request "${fullInput.type}" was aborted`)));
					return;
				}
				const abort = () =>
					settle(() => reject(new BusRequestError("aborted", fullInput.type, `Request "${fullInput.type}" was aborted`)));
				options.signal.addEventListener("abort", abort, { once: true });
				cleanups.push(() => options.signal?.removeEventListener("abort", abort));
			}
			cleanups.push(
				this.onOutput(contract.success, (event) => {
					if (event.requestId === requestId && event.playerId === playerId)
						settle(() => resolve(event as PlayerRequestReply<K>["success"]));
				}),
			);
			cleanups.push(
				this.onOutput(contract.error, (event: any) => {
					if (event.requestId === requestId && event.playerId === playerId)
						settle(() =>
							reject(
								event.error instanceof Error ?
									event.error
								:	new BusRequestError("unhandled", fullInput.type, String(event.error ?? "request failed")),
							),
						);
				}),
			);
			if (contract.progress && options.onProgress)
				cleanups.push(
					this.onOutput(contract.progress, (event) => {
						if (event.requestId === requestId && event.playerId === playerId && !settled)
							options.onProgress!(event as PlayerRequestProgress<K>);
					}),
				);
			this.emitInput(fullInput);
		});
	}

	// ---------------------------------------------------------------------
	// RPC: one handler per type, shared by every player. `playerId` travels
	// inside the execution context so a shared controller can look up its own
	// per-player state.
	// ---------------------------------------------------------------------
	public requestRpc<K extends keyof PlayerRpcMap>(
		playerId: string,
		type: K,
		request: PlayerRpcMap[K]["request"],
		options?: BusRpcOptions,
	): Promise<PlayerRpcMap[K]["response"]>;
	public requestRpc<TRequest, TResponse>(
		playerId: string,
		type: string,
		request: TRequest,
		options?: BusRpcOptions,
	): Promise<TResponse>;
	public requestRpc<TRequest, TResponse>(
		playerId: string,
		type: string,
		request: TRequest,
		options: BusRpcOptions = {},
	): Promise<TResponse> {
		if (this.disposed)
			return Promise.reject(new BusRequestError("disposed", type, `Bus is disposed; cannot request RPC "${type}"`));
		const handler = this.rpcHandlers.get(type) as RpcHandler<TRequest, TResponse> | undefined;
		if (!handler) return Promise.reject(new BusRequestError("unhandled", type, `No RPC handler registered for "${type}"`));
		if (options.signal?.aborted) return Promise.reject(new BusRequestError("aborted", type, `RPC "${type}" was aborted`));
		const requestId = createPlayerRequestId();
		const context: BusRpcContext = {
			playerId,
			requestId,
			signal: options.signal ?? new AbortController().signal,
			timestamp: Date.now(),
		};
		const start = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
		const operation = Promise.resolve()
			.then(() => handler(request, context))
			.finally(() => {
				if (this.latencyTrace?.enabled)
					this.latencyTrace.record("rpc", type, start, { requestId, handler: handler.name || "anonymous" });
			});
		if (options.timeoutMs === undefined) return operation;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new BusRequestError("timeout", type, `Timed out after ${options.timeoutMs}ms awaiting RPC "${type}"`)),
				options.timeoutMs,
			);
		});
		return Promise.race([operation, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}

	/** Invoke a synchronous RPC handler without exposing its owner through Player. */
	public requestRpcSync<K extends keyof PlayerRpcMap>(
		playerId: string,
		type: K,
		request: PlayerRpcMap[K]["request"],
	): PlayerRpcMap[K]["response"];
	public requestRpcSync<TRequest, TResponse>(playerId: string, type: string, request: TRequest): TResponse;
	public requestRpcSync<TRequest, TResponse>(playerId: string, type: string, request: TRequest): TResponse {
		if (this.disposed) throw new BusRequestError("disposed", type, `Bus is disposed; cannot request RPC "${type}"`);
		const handler = this.rpcHandlers.get(type) as RpcHandler<TRequest, TResponse> | undefined;
		if (!handler) throw new BusRequestError("unhandled", type, `No RPC handler registered for "${type}"`);
		const context: BusRpcContext = {
			playerId,
			requestId: createPlayerRequestId(),
			signal: new AbortController().signal,
			timestamp: Date.now(),
		};
		const start = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
		try {
			const value = handler(request, context);
			if (value && typeof (value as any).then === "function")
				throw new Error(`RPC "${type}" is asynchronous; use requestRpc() instead`);
			return value as TResponse;
		} finally {
			if (this.latencyTrace?.enabled)
				this.latencyTrace.record("rpc", type, start, { requestId: context.requestId, handler: handler.name || "anonymous" });
		}
	}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public hasRpc(type: string): boolean {
		return this.rpcHandlers.has(type);
	}

	/** Registered once by a shared (singleton) controller, never per player. */
	public registerRpc<TRequest, TResponse>(type: string, handler: RpcHandler<TRequest, TResponse>): () => void {
		if (this.disposed) return () => undefined;
		this.rpcHandlers.set(type, handler);
		return () => {
			if (this.rpcHandlers.get(type) === handler) this.rpcHandlers.delete(type);
		};
	}

	// ---------------------------------------------------------------------
	// Actions: broadcast to every registered (shared) controller listener;
	// `context.playerId` tells each listener which player's state to touch.
	// ---------------------------------------------------------------------
	public action(playerId: string, action: PlayerAction, context?: Partial<PlayerActionExecutionContext>): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const execution: PlayerActionExecutionContext = {
			playerId,
			signal: context?.signal ?? new AbortController().signal,
			priority: context?.priority ?? action.priority ?? PlayerActionPriority.NORMAL,
			requestId: context?.requestId ?? action.requestId ?? createPlayerRequestId(),
			sessionId: context?.sessionId,
			source: context?.source,
			timestamp: context?.timestamp ?? Date.now(),
		};
		const start = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
		const handlerDurations: number[] = [];
		return Promise.all(
			[...this.actionListeners].map((handler) => {
				const handlerStart = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
				return Promise.resolve()
					.then(() => handler(action, execution))
					.finally(() => {
						if (this.latencyTrace?.enabled) {
							const duration = this.latencyTrace.record("action", action.type, handlerStart, {
								requestId: execution.requestId,
								sessionId: execution.sessionId,
								source: execution.source,
								handler: handler.name || "anonymous",
							});
							handlerDurations.push(duration);
						}
					});
			}),
		)
			.finally(() => {
				if (this.latencyTrace?.enabled) {
					this.latencyTrace.record("action", action.type, start, {
						requestId: execution.requestId,
						sessionId: execution.sessionId,
						source: execution.source,
						handler: `criticalPath=${Math.max(0, ...handlerDurations).toFixed(1)}µs`,
					});
				}
			})
			.then(() => undefined);
	}
	/** Registered once by a shared (singleton) controller, never per player. */
	public onAction(handler: (action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>): () => void {
		this.actionListeners.add(handler);
		return () => this.actionListeners.delete(handler);
	}

	// ---------------------------------------------------------------------
	// Events: scoped per (type, playerId) so a Player never observes another
	// guild's events even though every controller instance is shared.
	// ---------------------------------------------------------------------
	public event<K extends PlayerEventType>(playerId: string, event: Extract<PlayerEvent, { type: K }>): void {
		if (!this.disposed) this.dispatchScoped(this.eventListeners, event.type, playerId, event);
	}
	public publish<K extends PlayerEventType>(playerId: string, type: K, ...args: PlayerEventArgsMap[K]): void {
		this.event(playerId, this.toEvent(type, args));
	}
	public subscribe<K extends PlayerEventType>(
		playerId: string,
		type: K,
		listener: (event: Extract<PlayerEvent, { type: K }>) => void,
	): () => void {
		return this.addScopedListener(this.eventListeners, type, playerId, listener as any);
	}

	// ---------------------------------------------------------------------
	// Queries: one handler per query type, shared by every player; the
	// handler receives `playerId` and looks up its own state.
	// ---------------------------------------------------------------------
	/** Registered once by a shared (singleton) controller, never per player. */
	public registerQuery<K extends PlayerQuery>(query: K, handler: PlayerQueryHandler<K>): () => void {
		let handlers = this.queryHandlers.get(query);
		if (!handlers) {
			handlers = new Set();
			this.queryHandlers.set(query, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}
	public query<K extends PlayerQuery>(playerId: string, query: K): Promise<PlayerQueryMap[K]> {
		if (this.disposed) return Promise.resolve(undefined as any);
		const handler = [...(this.queryHandlers.get(query) ?? [])][0] as PlayerQueryHandler<K> | undefined;
		if (!handler) return Promise.resolve(undefined as any);
		const start = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
		return Promise.resolve(handler(playerId)).finally(() => {
			if (this.latencyTrace?.enabled) this.latencyTrace.record("query", query, start, { handler: handler.name || "anonymous" });
		});
	}
	public querySync<K extends PlayerQuery>(playerId: string, query: K): PlayerQueryMap[K] {
		if (this.disposed) return undefined as any;
		const handler = [...(this.queryHandlers.get(query) ?? [])][0] as PlayerQueryHandler<K> | undefined;
		if (!handler) return undefined as any;
		const start = this.latencyTrace?.enabled ? this.latencyTrace.start() : 0;
		try {
			const value = handler(playerId);
			if (value && typeof (value as any).then === "function")
				throw new Error(`Query "${query}" is asynchronous; use query() instead`);
			return value as PlayerQueryMap[K];
		} finally {
			if (this.latencyTrace?.enabled) this.latencyTrace.record("query", query, start, { handler: handler.name || "anonymous" });
		}
	}

	/** Drop everything scoped to a single player (its event subscriptions). Shared, global
	 * controller registrations (rpc/query/action) are untouched — controllers themselves
	 * drop their per-player state slice via GlobalControllerRegistry. */
	public disposePlayer(playerId: string): void {
		for (const byPlayer of this.eventListeners.values()) byPlayer.delete(playerId);
	}

	public clear(): void {
		for (const cancel of [...this.pendingRequests]) cancel();
		this.inputListeners.clear();
		this.outputListeners.clear();
		this.eventListeners.clear();
		this.actionListeners.clear();
		this.queryHandlers.clear();
		this.rpcHandlers.clear();
	}
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
		this.latencyTrace = undefined;
	}

	private toEvent<K extends PlayerEventType>(type: K, args: PlayerEventArgsMap[K]): Extract<PlayerEvent, { type: K }> {
		switch (type) {
			case "initialized":
			case "ready":
			case "destroyed":
			case "preloadCancelled":
				return { type } as any;
			case "TRACK_LOADING":
			case "TRACK_LOADED":
			case "TRACK_STARTED":
			case "TRACK_END":
			case "STREAM_ABORTED":
			case "playbackStateChanged":
			case "playbackSessionCreated":
			case "RECOVERY_STARTED":
			case "RECOVERY_FAILED":
				return { type, session: args[0] } as any;
			case "TRACK_ERROR":
				return { type, session: args[0], error: args[1] } as any;
			case "STUCK_DETECTED":
				return { type, session: args[0], reason: args[1] } as any;
			case "trackRequested":
				return { type, track: args[0], session: args[1] } as any;
			case "queueChanged":
				return { type, queue: args[0] } as any;
			case "volumeRequested":
				return { type, volume: args[0], oldVolume: args[1], newVolume: args[2] } as any;
			case "stateChanged":
				return { type, oldState: args[0], newState: args[1] } as any;
			case "preloadStateChanged":
				return { type, state: args[0] } as any;
			case "preloadPromoted":
				return { type, track: args[0] } as any;
			case "queueEnd":
			case "playerStop":
			case "filtersCleared":
				return { type } as any;
			case "willPlay":
				return { type, track: args[0], upcomingTracks: args[1] } as any;
			case "playerPause":
			case "playerResume":
				return { type, track: args[0] } as any;
			case "seek":
				return { type, track: args[0], position: args[1] } as any;
			case "filterApplied":
			case "filterRemoved":
				return { type, filter: args[0] } as any;
			case "streamError":
				return { type, error: args[0], track: args[1] } as any;
			case "forwardModeStart":
				return { type, leader: args[0] } as any;
			case "forwardModeEnd":
				return { type, leader: args[0], reason: args[1] } as any;
		}
	}
	private addFlatListener<T extends string, E>(
		map: Map<T, Set<(event: E) => any>>,
		type: T,
		handler: (event: E) => any,
	): () => void {
		let listeners = map.get(type);
		if (!listeners) {
			listeners = new Set();
			map.set(type, listeners);
		}
		listeners.add(handler);
		return () => listeners?.delete(handler);
	}
	private dispatchFlat<T extends string, E>(map: Map<T, Set<(event: E) => any>>, type: T, event: E): void {
		for (const listener of map.get(type) ?? []) void listener(event);
	}
	private addScopedListener<T extends string, E>(
		map: Map<T, Map<string, Set<(event: E) => any>>>,
		type: T,
		playerId: string,
		handler: (event: E) => any,
	): () => void {
		let byPlayer = map.get(type);
		if (!byPlayer) {
			byPlayer = new Map();
			map.set(type, byPlayer);
		}
		let listeners = byPlayer.get(playerId);
		if (!listeners) {
			listeners = new Set();
			byPlayer.set(playerId, listeners);
		}
		listeners.add(handler);
		return () => listeners?.delete(handler);
	}
	private dispatchScoped<T extends string, E>(
		map: Map<T, Map<string, Set<(event: E) => any>>>,
		type: T,
		playerId: string,
		event: E,
	): void {
		for (const listener of map.get(type)?.get(playerId) ?? []) void listener(event);
	}
}

export const createPlayerRequestId = (): PlayerRequestId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const createPlayerSessionId = (): PlayerSessionId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
