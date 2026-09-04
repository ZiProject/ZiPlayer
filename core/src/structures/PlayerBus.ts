import type {
	PlayerAction,
	PlayerActionExecutionContext,
	PlayerBusEvents,
	PlayerBusRequestErrorReason,
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

import { PlayerActionPriority } from "../types/bus";

export type {
	PlayerAction,
	PlayerActionExecutionContext,
	PlayerBusEvents,
	PlayerBusRequestErrorReason,
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

interface RequestContract {
	success: PlayerOutput["type"];
	error: PlayerOutput["type"];
	progress?: PlayerOutput["type"];
}

const REQUESTS: Record<PlayerRequestInputType, RequestContract> = {
	"[Player]->[Connection]:connect": {
		success: "[Connection]->[Player]:connected",
		error: "[Connection]->[Player]:error",
		progress: "[Connection]->[Player]:connecting",
	},
	"[Player]->[Connection]:disconnect": { success: "[Connection]->[Player]:disconnected", error: "[Connection]->[Player]:error" },
	"[Player]->[Connection]:reconnect": {
		success: "[Connection]->[Player]:connected",
		error: "[Connection]->[Player]:error",
		progress: "[Connection]->[Player]:connecting",
	},
	"[Player]->[Preload]:request": {
		success: "[Preload]->[Player]:ready",
		error: "[Preload]->[Player]:failed",
		progress: "[Preload]->[Player]:loading",
	},
	"[Player]->[Recovery]:recover": {
		success: "[Recovery]->[Player]:recovered",
		error: "[Recovery]->[Player]:failed",
		progress: "[Recovery]->[Player]:retrying",
	},
	"[Player]->[Resource]:refresh": { success: "[Resource]->[Player]:refreshed", error: "[Resource]->[Player]:error" },
};

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

export interface PlayerBusRpcContext {
	readonly requestId: PlayerRequestId;
	readonly signal: AbortSignal;
	readonly timestamp: number;
}

export interface PlayerBusRpcOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

type RpcHandler<TRequest, TResponse> = (request: TRequest, context: PlayerBusRpcContext) => TResponse | Promise<TResponse>;

export class PlayerBus {
	private readonly inputListeners = new Map<PlayerInput["type"], Set<(event: PlayerInput) => void | Promise<void>>>();
	private readonly outputListeners = new Map<PlayerOutput["type"], Set<(event: PlayerOutput) => void>>();
	private readonly eventListeners = new Map<PlayerEventType, Set<(event: PlayerEvent) => void>>();
	private readonly actionListeners = new Set<
		(action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>
	>();
	private readonly queryHandlers = new Map<PlayerQuery, Set<PlayerQueryHandler<any>>>();
	private readonly rpcHandlers = new Map<string, RpcHandler<any, any>>();
	private readonly pendingRequests = new Set<() => void>();
	private disposed = false;

	public emitInput(event: PlayerInput): void {
		if (!this.disposed) this.dispatch(this.inputListeners, event.type, event);
	}
	public emitOutput(event: PlayerOutput): void {
		if (!this.disposed) this.dispatch(this.outputListeners, event.type, event);
	}
	public onInput<K extends PlayerInput["type"]>(
		type: K,
		handler: (event: Extract<PlayerInput, { type: K }>) => void | Promise<void>,
	): () => void {
		return this.addListener(this.inputListeners, type, handler as any);
	}
	public onOutput<K extends PlayerOutput["type"]>(
		type: K,
		handler: (event: Extract<PlayerOutput, { type: K }>) => void,
	): () => void {
		return this.addListener(this.outputListeners, type, handler as any);
	}

	public request<K extends PlayerRequestInputType>(
		input: Extract<PlayerInput, { type: K }>,
		options: PlayerRequestOptions<K> = {},
	): Promise<PlayerRequestReply<K>["success"]> {
		if (this.disposed)
			return Promise.reject(
				new PlayerBusRequestError("disposed", input.type, `PlayerBus is disposed; cannot request "${input.type}"`),
			);
		const requestId = input.requestId;
		if (!requestId)
			return Promise.reject(new PlayerBusRequestError("unhandled", input.type, `Input "${input.type}" has no requestId`));
		const contract = REQUESTS[input.type];
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
					reject(
						new PlayerBusRequestError("disposed", input.type, `PlayerBus was disposed while awaiting reply to "${input.type}"`),
					),
				);
			this.pendingRequests.add(cancel);
			cleanups.push(() => this.pendingRequests.delete(cancel));
			if (options.timeoutMs !== undefined) {
				const timer = setTimeout(
					() =>
						settle(() =>
							reject(
								new PlayerBusRequestError(
									"timeout",
									input.type,
									`Timed out after ${options.timeoutMs}ms awaiting reply to "${input.type}"`,
								),
							),
						),
					options.timeoutMs,
				);
				cleanups.push(() => clearTimeout(timer));
			}
			if (options.signal) {
				if (options.signal.aborted) {
					settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted`)));
					return;
				}
				const abort = () =>
					settle(() => reject(new PlayerBusRequestError("aborted", input.type, `Request "${input.type}" was aborted`)));
				options.signal.addEventListener("abort", abort, { once: true });
				cleanups.push(() => options.signal?.removeEventListener("abort", abort));
			}
			cleanups.push(
				this.onOutput(contract.success, (event) => {
					if (event.requestId === requestId) settle(() => resolve(event as PlayerRequestReply<K>["success"]));
				}),
			);
			cleanups.push(
				this.onOutput(contract.error, (event: any) => {
					if (event.requestId === requestId)
						settle(() =>
							reject(
								event.error instanceof Error ?
									event.error
								:	new PlayerBusRequestError("unhandled", input.type, String(event.error ?? "request failed")),
							),
						);
				}),
			);
			if (contract.progress && options.onProgress)
				cleanups.push(
					this.onOutput(contract.progress, (event) => {
						if (event.requestId === requestId && !settled) options.onProgress!(event as PlayerRequestProgress<K>);
					}),
				);
			this.emitInput(input);
		});
	}

	public requestRpc<K extends keyof PlayerRpcMap>(
		type: K,
		request: PlayerRpcMap[K]["request"],
		options?: PlayerBusRpcOptions,
	): Promise<PlayerRpcMap[K]["response"]>;
	public requestRpc<TRequest, TResponse>(type: string, request: TRequest, options?: PlayerBusRpcOptions): Promise<TResponse>;
	public requestRpc<TRequest, TResponse>(type: string, request: TRequest, options: PlayerBusRpcOptions = {}): Promise<TResponse> {
		if (this.disposed)
			return Promise.reject(new PlayerBusRequestError("disposed", type, `PlayerBus is disposed; cannot request RPC "${type}"`));
		const handler = this.rpcHandlers.get(type) as RpcHandler<TRequest, TResponse> | undefined;
		if (!handler) return Promise.reject(new PlayerBusRequestError("unhandled", type, `No RPC handler registered for "${type}"`));
		if (options.signal?.aborted) return Promise.reject(new PlayerBusRequestError("aborted", type, `RPC "${type}" was aborted`));
		const requestId = createPlayerRequestId();
		const context: PlayerBusRpcContext = {
			requestId,
			signal: options.signal ?? new AbortController().signal,
			timestamp: Date.now(),
		};
		const operation = Promise.resolve().then(() => handler(request, context));
		if (options.timeoutMs === undefined) return operation;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new PlayerBusRequestError("timeout", type, `Timed out after ${options.timeoutMs}ms awaiting RPC "${type}"`)),
				options.timeoutMs,
			);
		});
		return Promise.race([operation, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}

	/** Invoke a synchronous RPC handler without exposing its owner through Player. */
	public requestRpcSync<K extends keyof PlayerRpcMap>(type: K, request: PlayerRpcMap[K]["request"]): PlayerRpcMap[K]["response"];
	public requestRpcSync<TRequest, TResponse>(type: string, request: TRequest): TResponse;
	public requestRpcSync<TRequest, TResponse>(type: string, request: TRequest): TResponse {
		if (this.disposed) throw new PlayerBusRequestError("disposed", type, `PlayerBus is disposed; cannot request RPC "${type}"`);
		const handler = this.rpcHandlers.get(type) as RpcHandler<TRequest, TResponse> | undefined;
		if (!handler) throw new PlayerBusRequestError("unhandled", type, `No RPC handler registered for "${type}"`);
		const context: PlayerBusRpcContext = {
			requestId: createPlayerRequestId(),
			signal: new AbortController().signal,
			timestamp: Date.now(),
		};
		const value = handler(request, context);
		if (value && typeof (value as any).then === "function")
			throw new Error(`RPC "${type}" is asynchronous; use requestRpc() instead`);
		return value as TResponse;
	}

	public registerRpc<TRequest, TResponse>(type: string, handler: RpcHandler<TRequest, TResponse>): () => void {
		if (this.disposed) return () => undefined;
		this.rpcHandlers.set(type, handler);
		return () => {
			if (this.rpcHandlers.get(type) === handler) this.rpcHandlers.delete(type);
		};
	}

	public action(action: PlayerAction, context?: Partial<PlayerActionExecutionContext>): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const execution: PlayerActionExecutionContext = {
			signal: context?.signal ?? new AbortController().signal,
			priority: context?.priority ?? action.priority ?? PlayerActionPriority.NORMAL,
			requestId: context?.requestId ?? action.requestId ?? createPlayerRequestId(),
			sessionId: context?.sessionId,
			source: context?.source,
			timestamp: context?.timestamp ?? Date.now(),
		};
		return Promise.all([...this.actionListeners].map((handler) => handler(action, execution))).then(() => undefined);
	}
	public onAction(handler: (action: PlayerAction, context: PlayerActionExecutionContext) => void | Promise<void>): () => void {
		this.actionListeners.add(handler);
		return () => this.actionListeners.delete(handler);
	}
	public event<K extends PlayerEventType>(event: Extract<PlayerEvent, { type: K }>): void {
		if (!this.disposed) this.dispatch(this.eventListeners, event.type, event);
	}
	public publish<K extends PlayerEventType>(type: K, ...args: PlayerEventArgsMap[K]): void {
		this.event(this.toEvent(type, args));
	}
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.addListener(this.eventListeners, type, listener as any);
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
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		if (this.disposed) return Promise.resolve(undefined as any);
		const handler = [...(this.queryHandlers.get(query) ?? [])][0] as PlayerQueryHandler<K> | undefined;
		return Promise.resolve(handler ? handler() : (undefined as any));
	}
	public querySync<K extends PlayerQuery>(query: K): PlayerQueryMap[K] {
		if (this.disposed) return undefined as any;
		const handler = [...(this.queryHandlers.get(query) ?? [])][0] as PlayerQueryHandler<K> | undefined;
		if (!handler) return undefined as any;
		const value = handler();
		if (value && typeof (value as any).then === "function")
			throw new Error(`Query "${query}" is asynchronous; use query() instead`);
		return value as PlayerQueryMap[K];
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
				return { type, volume: args[0] } as any;
			case "stateChanged":
				return { type, oldState: args[0], newState: args[1] } as any;
			case "preloadStateChanged":
				return { type, state: args[0] } as any;
			case "preloadPromoted":
				return { type, track: args[0] } as any;
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

export const createPlayerRequestId = (): PlayerRequestId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const createPlayerSessionId = (): PlayerSessionId => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
