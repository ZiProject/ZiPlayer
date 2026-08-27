import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerOptions, VoiceChannel, SearchResult } from "../types";
import type { PlayerManager } from "./PlayerManager";
import { Player as LegacyPlayer } from "./Player.old";
import {
	type PlayerAction as PlayerActionMessage,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
	createPlayerRequestId,
} from "./PlayerBus";
import { PlayerRuntimeController } from "../Controller/PlayerRuntimeController";
import { SearchController } from "../Controller/SearchController";

/** Public Player facade. LegacyPlayer is temporary and will be removed. */
export class Player extends LegacyPlayer {
	public readonly runtime: PlayerRuntimeController;
	public readonly searchController: SearchController;

	public get bus() { return this.runtime.bus; }
	public get actionExecutor() { return this.runtime.actionExecutor; }
	public get connectionController() { return this.runtime.connectionController; }
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
		this.searchController = new SearchController({
			extensionManager: this.extensionManager,
			pluginManager: this.pluginManager,
			debug: this.debug.bind(this),
		});

		// Runtime resources are authoritative during decomposition.
		this.queue = this.runtime.queue;
		this.audioPlayer = this.runtime.audioPlayer;
		this.streamManager = this.runtime.streamManager;
		this.preloadManager = this.runtime.preloadManager;
	}

	/** Search through the extracted search subsystem. Legacy play() dispatches here polymorphically. */
	public override search(query: string, requestedBy: string): Promise<SearchResult> {
		return this.searchController.search(query, requestedBy);
	}

	public override clearSearchCache(): void {
		this.searchController.clear();
	}

	public override debugSearchQuery(query: string): ReturnType<SearchController["debug"]> {
		return this.searchController.debug(query);
	}

	/** Request a voice connection through PlayerBus. ConnectionController owns the connection. */
	public override connect(channel: VoiceChannel): Promise<VoiceConnection> {
		return this.bus
			.request({ type: "[Player]->[Connection]:connect", requestId: createPlayerRequestId(), channel })
			.then((event) => event.connection);
	}

	/** Request voice disconnection through PlayerBus. */
	public override disconnect(): Promise<void> {
		return this.bus.request({ type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId() }).then(() => undefined);
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