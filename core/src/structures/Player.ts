import { EventEmitter } from "events";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerOptions, VoiceChannel, SearchResult, Track, ProgressBarOptions } from "../types";
import type { PlayerManager } from "./PlayerManager";
import {
	type PlayerAction as PlayerActionMessage,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
	createPlayerRequestId,
} from "./PlayerBus";
import { PlayerRuntimeController } from "../Controller/PlayerRuntimeController";
import { PlayerEventBridge } from "../Controller/PlayerEventBridge";
import { SearchController } from "../Controller/SearchController";
import type { ForwardController } from "../Controller/ForwardController";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";

/** Public Player facade. Runtime controllers own playback state and lifecycles. */
export class Player extends EventEmitter {
	public readonly runtime: PlayerRuntimeController;
	public readonly searchController: SearchController;
	public readonly eventBridge: PlayerEventBridge;
	public readonly guildId: string;
	public connection: VoiceConnection | null = null;
	public audioPlayer!: any;
	public queue!: any;
	public readonly options: PlayerOptions;
	public userdata?: Record<string, any>;
	public _lastActivity = Date.now();
	public destroyed = false;
	public readonly manager: PlayerManager;
	public pluginManager!: any;
	public extensionManager!: any;
	public streamManager!: any;
	public preloadManager!: any;
	public filter!: any;
	public playbackMode!: any;
	public forwardFollowers = new Set<Player>();
	public forwardLeader: Player | null = null;
	public currentResource!: any;
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
	public get lifecycleController() {
		return this.runtime.lifecycleController;
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
	public get volumeController() {
		return this.runtime.volumeController;
	}
	public get forwardController(): ForwardController {
		return this.runtime.forwardController;
	}
	public get currentTrack(): Track | null {
		return this.queueController.current ?? null;
	}
	public get queueSize(): number {
		return this.queueController.snapshot().length;
	}
	public get isPlaying(): boolean {
		return this.playbackController.status === "playing";
	}
	public get isPaused(): boolean {
		return this.playbackController.status === "paused";
	}
	public get volume(): number {
		return this.volumeController.value;
	}
	public set volume(value: number) {
		this.volumeController.setVolume(value);
	}

	public constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super();
		this.guildId = guildId;
		this.manager = manager;
		this.options = {
			leaveOnEnd: true,
			leaveOnEmpty: true,
			leaveTimeout: 100000,
			volume: 100,
			quality: "high",
			extractorTimeout: 50000,
			selfDeaf: true,
			selfMute: false,
			...options,
			tts: { createPlayer: false, interrupt: true, volume: 100, maxTimeTts: 60_000, ...(options.tts || {}) },
		};
		this.userdata = this.options.userdata;
		this.runtime = new PlayerRuntimeController({ player: this, manager, options: this.options, debug: this.debug.bind(this) });
		this.searchController = new SearchController({
			extensionManager: this.runtime.extensionManager,
			pluginManager: this.runtime.pluginManager,
			debug: this.debug.bind(this),
		});
		this.eventBridge = new PlayerEventBridge(this, manager, this.runtime.bus);
		this.queue = this.runtime.queue;
		this.audioPlayer = this.runtime.audioPlayer;
		this.streamManager = this.runtime.streamManager;
		this.preloadManager = this.runtime.preloadManager;
		this.filter = this.runtime.filterController;
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.listenerCount("debug") > 0 || this.manager.debugEnabled)
			this.manager.emit("debug", `[Player:${this.guildId}] ${message}`, ...optionalParams);
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
	public async play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		if (this.destroyed) return false;

		// Legacy contract: null starts the next queued track; it does not skip.
		if (query === null) {
			if (this.isPlaying || this.isPaused) return true;
			return this.playNext();
		}

		let tracks: Track[];
		try {
			if (typeof query === "string") {
				tracks = (await this.search(query, requestedBy || "Unknown")).tracks;
			} else if ("tracks" in query) {
				tracks = query.tracks;
			} else {
				tracks = [query];
			}
		} catch (error) {
			this.debug("[Player] Play search error:", error);
			this.emit("playerError", error as Error);
			return false;
		}

		if (tracks.length === 0) return false;

		this.queueController.addMultiple(tracks);

		if (this.isPlaying || this.isPaused) {
			void this.preloadController.preload().catch((error: unknown) => this.debug("[Player] Preload after queue add error:", error));
			return true;
		}

		return this.playNext();
	}
	public playNext(): Promise<boolean> {
		if (this.destroyed) return Promise.resolve(false);
		return this.action({ type: "SKIP" })
			.then(() => this.isPlaying || this.currentTrack !== null)
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

	/** Get the current playback time using the legacy public contract. */
	public getTime() {
		const track = this.currentTrack;
		const resource = this.currentResource ?? this.playbackController.activeResource;
		const isLive = Boolean(track?.isLive);

		if (isLive) {
			return {
				current: 0,
				total: 0,
				format: "LIVE",
				formatted: {
					current: "LIVE",
					total: "LIVE",
				},
			};
		}

		if (!track || !resource) {
			return {
				current: 0,
				total: 0,
				format: "00:00",
				formatted: {
					current: "00:00",
					total: "00:00",
				},
			};
		}

		const total = Math.floor(track.duration > 1000 ? track.duration : track.duration * 1000) | 0;
		const seekOffset = Number((this as any).seekOffset ?? 0);
		const current = Math.floor(Number(resource.playbackDuration ?? 0) + seekOffset) | 0;

		return {
			current,
			total,
			format: this.formatTime(current),
			formatted: {
				current: this.formatTimeCompact(current),
				total: this.formatTimeCompact(total),
			},
		};
	}

	public skip(): boolean {
		void this.action({ type: "SKIP" });
		return true;
	}

	/**
	 * Get the progress bar of the current track.
	 * Kept on the public facade for API compatibility; playback state is read from the runtime playback controller.
	 */
	public getProgressBar(options: ProgressBarOptions = {}): string {
		const {
			size = 20,
			barChar = "▬",
			progressChar = "🔘",
			timeFormat = "compact",
			showPercentage = false,
			showTime = true,
		} = options;

		const track = this.currentTrack;
		const resource = this.runtime.playbackController.activeResource ?? this.currentResource;
		const isLive = Boolean((track as any)?.isLive);

		if (isLive || !track || !resource) {
			if (isLive) return "🔴 LIVE";
			return "";
		}

		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Number(resource.playbackDuration ?? 0);
		if (!total) return this.formatTimeCompact(current);

		const ratio = Math.min(Math.max(current / total, 0), 1);
		const progress = Math.round(ratio * size);

		let bar = "";
		if (progressChar === "none" || (options as any).hideProgressChar) {
			const filled = barChar.repeat(progress);
			const empty = barChar.repeat(Math.max(0, size - progress));
			bar = filled + empty;
		} else {
			const filled = barChar.repeat(progress);
			const empty = barChar.repeat(Math.max(0, size - progress));
			bar = filled + progressChar + empty;
		}

		const formatTimeFn = timeFormat === "compact" ? this.formatTimeCompact.bind(this) : this.formatTime.bind(this);
		const currentTimeStr = formatTimeFn(current);
		const totalTimeStr = formatTimeFn(total);

		let result = "";
		if (showTime) {
			result = `${currentTimeStr} ${bar} ${totalTimeStr}`;
		} else {
			result = bar;
		}

		if (showPercentage) {
			const percent = Math.round(ratio * 100);
			result += ` (${percent}%)`;
		}

		return result;
	}

	/** Format time with leading zeros (00:00 or 00:00:00). */
	public formatTime(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = (totalSeconds % 60) | 0;

		const parts: string[] = [];
		if (hours > 0) {
			parts.push(String(hours));
			parts.push(String(minutes).padStart(2, "0"));
		} else {
			parts.push(String(minutes));
		}
		parts.push(String(seconds).padStart(2, "0"));
		return parts.join(":");
	}

	/** Format time without leading zeros for hours (1:22:12 or 3:45). */
	public formatTimeCompact(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = (totalSeconds % 60) | 0;

		if (hours > 0) {
			return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
		}
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}

	public addPlugin(plugin: BasePlugin): void {
		this.pluginManager.register(plugin);
	}
	public removePlugin(name: string): boolean {
		return this.pluginManager.unregister(name);
	}
	public attachExtension(extension: BaseExtension): void {
		this.extensionManager.register(extension);
	}
	public detachExtension(extension: BaseExtension): boolean {
		return this.extensionManager.unregister(extension);
	}
	public subscribeTo(leader: Player, options?: { forwardMode?: boolean }): boolean {
		return this.forwardController.subscribeTo(leader, options);
	}
	public unsubscribeForward(reason?: string): boolean {
		return this.forwardController.unsubscribeForward(reason);
	}
	public getForwardHealthStatus() {
		const role: "leader" | "follower" | "none" =
			this.forwardController.isLeader ? "leader"
			: this.forwardController.isFollower ? "follower"
			: "none";
		const issues: string[] = [];
		if (role === "follower" && !this.forwardController.forwardLeader) issues.push("missing leader");
		if (role === "leader" && this.forwardController.forwardFollowers.size === 0) issues.push("no followers");
		return {
			guildId: this.guildId,
			healthy: issues.length === 0,
			role,
			issues,
			details: {
				leaderId: this.forwardController.forwardLeader?.guildId,
				followerCount: this.forwardController.forwardFollowers.size,
				connectionState: this.connection?.state?.status,
				audioPlayerState: this.playbackController.status,
			},
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
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.eventBridge.dispose();
		this.runtime.dispose();
		this.emit("playerDestroy");
		this.removeAllListeners();
	}
}
