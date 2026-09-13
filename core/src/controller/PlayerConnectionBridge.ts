import type { Player } from "../structures/Player";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlayerConnectionBridgeOptions } from "../types";

/** Syncs voice connection state from ConnectionController to the public Player facade. */
export class PlayerConnectionBridge {
	private readonly detach: () => void;

	constructor(options: PlayerConnectionBridgeOptions) {
		const { player, bus, debug, guildId } = options;
		const detachConnected = bus.onOutput("[Connection]->[Player]:connected", (event) => {
			player.connection = event.connection;
			debug?.(`[Player] Connection set guild=${guildId} session=${event.sessionId}`);
		});
		const detachDisconnected = bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			player.connection = null;
			debug?.(`[Player] Connection cleared guild=${guildId} reason=${event.reason ?? "unknown"}`);
		});
		this.detach = () => {
			detachConnected();
			detachDisconnected();
			player.connection = null;
		};
	}

	dispose(): void {
		this.detach();
	}
}
