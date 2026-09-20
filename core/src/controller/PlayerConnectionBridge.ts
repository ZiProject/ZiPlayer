import type { Player } from "../structures/Player";
import type { Bus } from "../structures/Bus";

/**
 * Syncs voice connection state from ConnectionController to the public Player facade.
 *
 * Singleton — created exactly once in `ensureSharedControllers()` and shared by every
 * player in the process (see `SharedControllerGraph`). `Bus.onOutput()` dispatch is
 * already global (not player-scoped), so the two listeners below are registered a
 * single time for the whole process; per-player wiring is just an entry in the
 * internal `playerId -> Player` registry via `attach()`/`detach()`, not a new bus
 * subscription or a new bridge instance.
 */
export class PlayerConnectionBridge {
	private readonly players = new Map<string, { player: Player; debug?: (...args: any[]) => void }>();

	public constructor(bus: Bus) {
		bus.onOutput("[Connection]->[Player]:connected", (event) => {
			const entry = this.players.get(event.playerId);
			if (!entry) return;
			entry.player.connection = event.connection;
			entry.debug?.(`[Player] Connection set guild=${event.playerId} session=${event.sessionId}`);
		});
		bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			const entry = this.players.get(event.playerId);
			if (!entry) return;
			entry.player.connection = null;
			entry.debug?.(`[Player] Connection cleared guild=${event.playerId} reason=${event.reason ?? "unknown"}`);
		});
	}

	/** Registers `player` as the current facade for `playerId`. Called once the Player
	 *  instance exists (after the runtime/controller graph, which is created first). */
	public attach(playerId: string, player: Player, debug?: (...args: any[]) => void): void {
		this.players.set(playerId, { player, debug });
	}

	/** Drops `playerId`'s entry. No bus unsubscription needed (there is none to undo —
	 *  the two onOutput listeners above live for the whole process). */
	public detach(playerId: string): void {
		const entry = this.players.get(playerId);
		if (entry) entry.player.connection = null;
		this.players.delete(playerId);
	}
}
