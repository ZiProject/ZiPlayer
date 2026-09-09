import type { Player } from "../structures/Player";
import type { PlayerBus } from "../structures/PlayerBus";
import type { TTSController } from "./TTSController";

export interface PlayerConnectionBridgeOptions {
	player: Player;
	bus: PlayerBus;
	ttsController: TTSController;
	debug?: (...args: any[]) => void;
	guildId: string;
}

/** Syncs voice connection state from ConnectionController to Player and TTSController. */
export class PlayerConnectionBridge {
	private readonly detach: () => void;

	constructor(options: PlayerConnectionBridgeOptions) {
		const { player, bus, ttsController, debug, guildId } = options;
		const detachConnected = bus.onOutput("[Connection]->[Player]:connected", (event) => {
			ttsController.setConnection(event.connection);
			player.connection = event.connection;
			debug?.(`[Player] Connection set guild=${guildId} session=${event.sessionId}`);
		});
		const detachDisconnected = bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			ttsController.setConnection(null);
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
