import type { Bus } from "../structures/Bus";
import { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";
import { CONTROLLER_RPC, PLAYER_QUERY } from "../structures/BusContract";

interface SessionState {
	session: PlaybackSession | null;
	pendingRetire: PlaybackSession | null;
}

/** Shared, singleton controller: owns the active PlaybackSession per player, exposed
 *  only through the internal Bus capability. */
export class PlaybackSessionController {
	private readonly states = new Map<string, SessionState>();
	private disposed = false;

	public constructor(bus: Bus) {
		bus.registerQuery(PLAYER_QUERY.playbackSessionInternal, (playerId) => this.states.get(playerId)?.session ?? null);
		bus.registerRpc<void, void>(CONTROLLER_RPC.playbackSessionRetirePending, (_req, ctx) =>
			this.retirePendingPrevious(ctx.playerId),
		);
	}

	attach(playerId: string): void {
		if (this.states.has(playerId)) this.detach(playerId);
		this.states.set(playerId, { session: null, pendingRetire: null });
	}
	detach(playerId: string): void {
		this.clear(playerId);
		this.states.delete(playerId);
	}
	/**
	 * Reads the state slice for `playerId`. Only `attach()` may create a persistent entry —
	 * a call for a playerId that was never attached (or was already `detach()`ed) gets a
	 * throwaway default instead of silently resurrecting a permanent `Map` entry that no
	 * future `detach()` would ever know to clean up.
	 */
	private state(playerId: string): SessionState {
		return this.states.get(playerId) ?? { session: null, pendingRetire: null };
	}

	public current(playerId: string): PlaybackSession | null {
		return this.states.get(playerId)?.session ?? null;
	}

	public replace(playerId: string, track: Track, options?: { destroyPrevious?: boolean }): PlaybackSession {
		if (this.disposed) throw new Error("PlaybackSessionController is disposed");
		const state = this.state(playerId);
		const previous = state.session;
		previous?.markStopped();
		if (options?.destroyPrevious ?? true) {
			previous?.destroy();
		} else if (previous) {
			state.pendingRetire = previous;
		}
		const session = new PlaybackSession();
		session.begin(track);
		state.session = session;
		return session;
	}
	public retirePendingPrevious(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		const pending = state.pendingRetire;
		state.pendingRetire = null;
		pending?.destroy();
	}
	public clear(playerId: string): void {
		this.retirePendingPrevious(playerId);
		const state = this.states.get(playerId);
		state?.session?.destroy();
		if (state) state.session = null;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const playerId of [...this.states.keys()]) this.clear(playerId);
		this.states.clear();
	}
}
