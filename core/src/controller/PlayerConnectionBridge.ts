import type { Player } from "../structures/Player";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlayerConnectionBridgeOptions } from "../types";

/** Syncs voice connection state from ConnectionController to the public Player facade. */
export class PlayerConnectionBridge {
	private readonly detach: () => void;
	private player: Player | null = null;

	constructor(options: { player?: Player | null; bus: PlayerBus; debug?: any; guildId: string }) {
		const { player, bus, debug, guildId } = options;
		this.player = player ?? null;
		const detachConnected = bus.onOutput("[Connection]->[Player]:connected", (event) => {
			if (this.player) this.player.connection = event.connection;
			debug?.(`[Player] Connection set guild=${guildId} session=${event.sessionId}`);
		});
		const detachDisconnected = bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			if (this.player) this.player.connection = null;
			debug?.(`[Player] Connection cleared guild=${guildId} reason=${event.reason ?? "unknown"}`);
		});
		this.detach = () => {
			detachConnected();
			detachDisconnected();
			if (this.player) this.player.connection = null;
		};
	}

	public attachPlayer(player: Player): void {
		this.player = player;
	}

	dispose(): void {
		this.detach();
	}
}
