import { AsyncLocalStorage } from "async_hooks";

/** Canonical player identity. Guild id is the usual value. */
export type PlayerId = string;

/** Controllers subscribe with this to observe every player on the global bus. */
export const PLAYER_ID_WILDCARD = "*" as const;
export type PlayerIdScope = PlayerId | typeof PLAYER_ID_WILDCARD;

/**
 * Isolated unit-test / local-controller identity when a call has no explicit player.
 * Production Player facades always inject a real id.
 */
export const DEFAULT_PLAYER_ID: PlayerId = "__default__";

const storage = new AsyncLocalStorage<PlayerId>();

export function runWithPlayerId<T>(playerId: PlayerId, fn: () => T): T {
	return storage.run(playerId, fn);
}

export function currentPlayerId(fallback: PlayerId = DEFAULT_PLAYER_ID): PlayerId {
	return storage.getStore() ?? fallback;
}

export function peekPlayerId(): PlayerId | undefined {
	return storage.getStore();
}

export function isPlayerScopedId(playerId: unknown): playerId is PlayerId {
	return typeof playerId === "string" && playerId.length > 0 && playerId !== PLAYER_ID_WILDCARD;
}

export function requirePlayerId(playerId: unknown, source = "request"): PlayerId {
	if (!isPlayerScopedId(playerId)) {
		throw new Error(`playerId is required for player-scoped ${source}`);
	}
	return playerId;
}

export function readPlayerId(...candidates: unknown[]): PlayerId | undefined {
	for (const candidate of candidates) {
		if (isPlayerScopedId(candidate)) return candidate;
		if (candidate && typeof candidate === "object" && "playerId" in candidate) {
			const value = (candidate as { playerId?: unknown }).playerId;
			if (isPlayerScopedId(value)) return value;
		}
	}
	return peekPlayerId();
}

export function resolvePlayerId(...candidates: unknown[]): PlayerId {
	return readPlayerId(...candidates) ?? DEFAULT_PLAYER_ID;
}

export function playerIdsMatch(listenerId: PlayerIdScope, eventId?: PlayerId): boolean {
	if (listenerId === PLAYER_ID_WILDCARD) return true;
	if (!eventId) return listenerId === DEFAULT_PLAYER_ID;
	return listenerId === eventId;
}
