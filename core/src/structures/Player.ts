import type { PlayerOptions } from "../types";
import type { PlayerManager } from "./PlayerManager";
import { Player as LegacyPlayer } from "./Player.old";
import { type PlayerAction as PlayerActionMessage, type PlayerEvent, type PlayerEventType, type PlayerQuery, type PlayerQueryMap } from "./PlayerBus";
import { PlayerRuntimeController } from "../Controller/PlayerRuntimeController";

/** Public Player facade. */
export class Player extends LegacyPlayer {
	public readonly runtime: PlayerRuntimeController;

	public get bus() { return this.runtime.bus; }
	public get actionExecutor() { return this.runtime.actionExecutor; }
	public get orchestrator() { return this.runtime.orchestrator; }
	public get trackLoader() { return this.runtime.trackLoader; }
	public get streamController() { return this.runtime.streamController; }
	public get playbackController() { return this.runtime.playbackController; }
	public get queueController() { return this.runtime.queueController; }
	public get antiStuckController() { return this.runtime.antiStuckController; }
	public get transitionController() { return this.runtime.transitionController; }
	public get preloadController() { return this.runtime.preloadController; }

	public constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super(guildId, options, manager);
		this.runtime = new PlayerRuntimeController({
			player: this,
			manager,
			options: this.options,
			debug: this.debug.bind(this),
		});

		// Compatibility bridge: legacy methods now observe the runtime-owned
		// resources. The old instances created by LegacyPlayer are no longer
		// authoritative after this point.
		this.queue = this.runtime.queue;
		this.audioPlayer = this.runtime.audioPlayer;
		this.streamManager = this.runtime.streamManager;
		this.preloadManager = this.runtime.preloadManager;
	}

	public action(action: PlayerActionMessage): Promise<void> { return this.runtime.actionExecutor.enqueue(action); }
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> { return this.runtime.bus.query(query); }
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.runtime.bus.subscribe(type, listener);
	}

	public override destroy(): void {
		if (this.destroyed) return;
		this.runtime.dispose();
		super.destroy();
	}
}
