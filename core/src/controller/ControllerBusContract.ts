/**
 * Internal controller boundary contract.
 *
 * Controllers communicate through PlayerBus RPC/events instead of importing
 * Player or reaching into another controller. Player remains the public API
 * facade; PlayerRuntimeController is only the composition/lifecycle root.
 */
export interface ControllerCommandContext {
	requestId: string;
	sessionId?: string;
	signal?: AbortSignal;
	timestamp?: number;
}

export type ControllerCommandHandler<TRequest = unknown, TResponse = unknown> = (
	request: TRequest,
	context: ControllerCommandContext,
) => TResponse | Promise<TResponse>;
