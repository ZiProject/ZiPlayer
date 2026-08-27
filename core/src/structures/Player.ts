import { EventEmitter } from "events";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerOptions, VoiceChannel, SearchResult, Track } from "../types";
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
import type { ForwardController } from "../Controller/ForwardController";

/** Public Player facade. LegacyPlayer is composed temporarily and is no longer a base class. */
export class Player extends EventEmitter {
	public readonly runtime: PlayerRuntimeController;
	public readonly searchController: SearchController;
	private readonly legacy: LegacyPlayer;

	// Transitional compatibility surface. These members will move to the decomposed controllers.
	public guildId!: string;
	public connection!: VoiceConnection | null;
	public audioPlayer!: any;
	public queue!: any;
	public options!: PlayerOptions;
	public userdata?: Record<string, any>;
	public _lastActivity!: number;
	public destroyed = false;
	public manager!: PlayerManager;
	public pluginManager!: any;
	public extensionManager!: any;
	public streamManager!: any;
	public preloadManager!: any;
	public filter!: any;
	public playbackMode!: any;
	public forwardFollowers!: Set<Player>;
	public forwardLeader!: Player | null;
	public currentResource!: any;

	// Keep the legacy compatibility API available while callers migrate to controllers.
	[key: string]: any;

	public get bus() {
		return this.runtime.bus;
	}
	public get actionExecutor() {
		return this.runtime.actionExecutor;
	}
	public get connectionController() {
		return this.runtime.connectionController;
	}
	public get orchestrator() {
		return this.runtime.orchestrator;
	}
	public get trackLoader() {
		return this.runtime.trackLoader;
	}
	public get streamController() {
		return this.runtime.streamController;
	}
	public get playbackController() {
		return this.runtime.playbackController;
	}
	public get queueController() {
		return this.runtime.queueController;
	}
	public get antiStuckController() {
		return this.runtime.antiStuckController;
	}
	public get transitionController() {
		return this.runtime.transitionController;
	}
	public get preloadController() {
		return this.runtime.preloadController;
	}
	public get filterController() {
		return this.runtime.filterController;
	}
	public get forwardController(): ForwardController {
		return this.runtime.forwardController;
	}

	public constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super();
		this.legacy = new LegacyPlayer(guildId, options, manager);
		this.bindLegacyCompatibility();
		this.runtime = new PlayerRuntimeController({ player: this, manager, options: this.options, debug: this.debug.bind(this) });
		this.searchController = new SearchController({
			extensionManager: this.extensionManager,
			pluginManager: this.pluginManager,
			debug: this.debug.bind(this),
		});
		this.queue = this.runtime.queue;
		this.audioPlayer = this.runtime.audioPlayer;
		this.streamManager = this.runtime.streamManager;
		this.preloadManager = this.runtime.preloadManager;
		this.filter = this.runtime.filterController;
	}

	private bindLegacyCompatibility(): void {
		const legacy: any = this.legacy;
		for (const key of Object.keys(legacy)) {
			if (key in this && key !== "legacy") continue;
			try {
				(this as any)[key] = legacy[key];
			} catch {}
		}

		let proto = Object.getPrototypeOf(legacy);
		while (proto && proto !== Object.prototype) {
			for (const key of Object.getOwnPropertyNames(proto)) {
				if (key === "constructor" || key in this) continue;
				const descriptor = Object.getOwnPropertyDescriptor(proto, key);
				if (!descriptor || typeof descriptor.value !== "function") continue;
				(this as any)[key] = descriptor.value.bind(legacy);
			}
			proto = Object.getPrototypeOf(proto);
		}

		// Legacy internals emit on their own EventEmitter. Mirror those events through the facade.
		const originalEmit = legacy.emit.bind(legacy);
		legacy.emit = (...args: any[]) => {
			const result = originalEmit(...args);
			this.emit(args[0], ...args.slice(1));
			return result;
		};
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		(this.legacy as any).debug?.(message, ...optionalParams);
	}

	public search(query: string, requestedBy: string): Promise<SearchResult> {
		return this.searchController.search(query, requestedBy);
	}
	public clearSearchCache(): void {
		this.searchController.clear();
	}
	public debugSearchQuery(query: string): ReturnType<SearchController["debug"]> {
		return this.searchController.debug(query);
	}
	public connect(channel: VoiceChannel): Promise<VoiceConnection> {
		return this.bus
			.request({ type: "[Player]->[Connection]:connect", requestId: createPlayerRequestId(), channel })
			.then((e) => e.connection);
	}
	public disconnect(): Promise<void> {
		return this.bus
			.request({ type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId() })
			.then(() => undefined);
	}
	public play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		if (query === null) return this.action({ type: "SKIP" }).then(() => true);
		const track =
			"tracks" in (query as any) ? (query as SearchResult).tracks[0]
			: typeof query === "string" ? undefined
			: (query as Track);
		if (track) return this.action({ type: "PLAY", track }).then(() => true);
		return this.search(query, requestedBy || "Unknown")
			.then((r) => (r.tracks.length ? this.action({ type: "PLAY", track: r.tracks[0] }).then(() => true) : false))
			.catch(() => false);
	}
	public playNext(): Promise<boolean> {
		return this.action({ type: "SKIP" })
			.then(() => true)
			.catch(() => false);
	}
	public pause(): boolean {
		void this.action({ type: "PAUSE" });
		return true;
	}
	public resume(): boolean {
		void this.action({ type: "RESUME" });
		return true;
	}
	public stop(): boolean {
		void this.action({ type: "STOP" });
		return true;
	}
	public seek(position: number): Promise<boolean> {
		return this.action({ type: "SEEK", position })
			.then(() => true)
			.catch(() => false);
	}
	public skip(index?: number): boolean {
		void this.action({ type: "SKIP" });
		return true;
	}
	public subscribeTo(leader: Player, options?: { forwardMode?: boolean }): boolean {
		return this.forwardController.subscribeTo(leader, options);
	}
	public unsubscribeForward(reason?: string): boolean {
		return this.forwardController.unsubscribeForward(reason);
	}
	public getForwardHealthStatus() {
		return {
			role:
				this.forwardController.isLeader ? "leader"
				: this.forwardController.isFollower ? "follower"
				: "standalone",
			leaderGuildId: this.forwardController.forwardLeader?.guildId ?? null,
			followerCount: this.forwardController.forwardFollowers.size,
		};
	}
	public action(action: PlayerActionMessage): Promise<void> {
		return this.runtime.actionExecutor.enqueue(action);
	}
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		return this.runtime.bus.query(query);
	}
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.runtime.bus.subscribe(type, listener);
	}
	public override destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.runtime.dispose();
		this.legacy.destroy();
		this.removeAllListeners();
	}
}
