import type { AudioPlayerState } from "@discordjs/voice";
import type { PlayerOptions } from "../types";
import type { PlayerManager } from "./PlayerManager";
import { Player as LegacyPlayer } from "./Player.old";
import { PlayerBus, type PlayerAction, type PlayerQuery } from "./PlayerBus";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";

/**
 * Public Player facade.
 *
 * The legacy implementation is kept behind this boundary while the playback
 * subsystems are migrated. Public lifecycle/control calls are announced
 * through PlayerBus; orchestration can be moved behind the bus incrementally
 * without changing the PlayerManager/public API.
 */
export class Player extends LegacyPlayer {
	public readonly bus: PlayerBus;
	public readonly orchestrator: PlaybackOrchestrator;

	private readonly detachStateForwarding: () => void;

	public constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super(guildId, options, manager);

		this.bus = new PlayerBus();
		this.orchestrator = new PlaybackOrchestrator(this.bus);

		const stateListener = (oldState: AudioPlayerState, newState: AudioPlayerState) => {
			this.bus.publish("stateChanged", oldState, newState);
		};
		this.audioPlayer.on("stateChange", stateListener);
		this.detachStateForwarding = () => this.audioPlayer.removeListener("stateChange", stateListener);

		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	/** Dispatch a public playback action through the communication hub. */
	public action(action: PlayerAction): Promise<void> {
		return this.bus.action(action);
	}

	/** Read orchestrated player state through the communication hub. */
	public query<K extends PlayerQuery>(query: K): ReturnType<PlayerBus["query"]> {
		return this.bus.query(query);
	}

	/** Subscribe to a typed playback lifecycle event. */
	public subscribe<K extends Parameters<PlayerBus["subscribe"]>[0]>(
		type: K,
		listener: Parameters<PlayerBus["subscribe"]>[1],
	): () => void {
		return this.bus.subscribe(type, listener as never);
	}

	public override destroy(): void {
		if (this.destroyed) return;
		this.bus.publish("destroyed");
		this.detachStateForwarding();
		this.orchestrator.dispose();
		this.bus.clear();
		super.destroy();
	}
}
