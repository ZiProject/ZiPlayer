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
	public get ttsController() {
		return this.runtime.ttsController;
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
	public get isLive(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}
	public get isIdle(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isIdle ?? true;
		return this.playbackController.status === "idle";
	}
	public get isBuffering(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isBuffering ?? false;
		return this.playbackController.status === "buffering";
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
	public async connect(channel: VoiceChannel): Promise<VoiceConnection> {
		return this.bus
			.request({ type: "[Player]->[Connection]:connect", requestId: createPlayerRequestId(), channel })
			.then((e) => e.connection);
	}
	public async disconnect(): Promise<void> {
		return this.bus
			.request({ type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId() })
			.then(() => undefined);
	}
	public async play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		if (this.destroyed) return false;

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

		const isTTS = (track: Track): boolean => this.runtime.ttsController.isTTS(track);
		if (tracks.length === 1 && this.options.tts?.interrupt !== false && isTTS(tracks[0])) {
			await this.runtime.ttsController.play(tracks[0]);
			return true;
		}

		this.queueController.addMultiple(tracks);
		if (this.isPlaying || this.isPaused) {
			void this.preloadController.preload().catch((error: unknown) => this.debug("[Player] Preload after queue add error:", error));
			return true;
		}
		return this.playNext();
	}
	public async playNext(): Promise<boolean> {
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
	public async seek(position: number): Promise<boolean> {
		return this.action({ type: "SEEK", position }).then(() => true).catch(() => false);
	}

	public destroyCurrentStream(): void {
		this.streamController.abortCurrent();
		this.playbackController.stop();
	}
	public generateWillNext(): Track | null {
		return this.queueController.willNext;
	}
	public preloadNextTrack(): Promise<void> {
		return this.trackLoader.preloadNext();
	}
	public safeCancelPreload(): Promise<void> {
		return this.preloadController.cancelSafely();
	}
	public preloadNext(): Promise<void> {
		return this.preloadController.preload();
	}
	public cancelPreload(): void {
		this.preloadController.cancel();
	}
	public clearSlot(): void {
		this.preloadController.clear();
		this.streamController.abortCurrent();
	}
	public previous(): any {
		return this.queueController.previous();
	}
	public loop(mode?: any): any {
		return mode === undefined ? this.queueController.loop : this.queueController.setLoop(mode);
	}
	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ? this.queueController.autoPlay : this.queueController.setAutoPlay(enabled);
	}
	public setVolume(value: number): number {
		return this.volumeController.setVolume(value);
	}
	public shuffle(): void {
		this.queue.shuffle();
		this.bus.publish("queueChanged", this.queueController.snapshot());
	}
	public clearQueue(): void {
		this.queueController.clear();
	}
	public insert(track: Track, index = 0): number {
		return this.queueController.insert(track, index);
	}
	public remove(index: number): Track | null {
		return this.queueController.remove(index);
	}
	public getSerializableState(): any {
		return { guildId: this.guildId, queue: this.queue.toJSON?.(), volume: this.volume, playbackMode: this.playbackMode };
	}
	public restoreState(state: any): void {
		if (state?.queue) this.queue.fromJSON?.(state.queue);
		if (typeof state?.volume === "number") this.setVolume(state.volume);
		if (state?.playbackMode !== undefined) this.playbackMode = state.playbackMode;
	}
	public getStreamManagerStats(): any {
		return this.streamManager?.getStats?.() ?? {};
	}

	public getTime() {
		const track = this.currentTrack;
		const resource = this.currentResource ?? this.playbackController.activeResource;
		const isLive = Boolean(track?.isLive);
		if (isLive) return { current: 0, total: 0, format: "LIVE", formatted: { current: "LIVE", total: "LIVE" } };
		if (!track || !resource) return { current: 0, total: 0, format: "00:00", formatted: { current: "00:00", total: "00:00" } };
		const total = Math.floor(track.duration > 1000 ? track.duration : track.duration * 1000) | 0;
		const seekOffset = Number((this as any).seekOffset ?? 0);
		const current = Math.floor(Number(resource.playbackDuration ?? 0) + seekOffset) | 0;
		return {
			current,
			total,
			format: this.formatTime(current),
			formatted: { current: this.formatTimeCompact(current), total: this.formatTimeCompact(total) },
		};
	}
	public skip(): boolean {
		void this.action({ type: "SKIP" });
		return true;
	}
	public getProgressBar(options: ProgressBarOptions = {}): string {
		const { size = 20, barChar = "▬", progressChar = "🔘", timeFormat = "compact", showPercentage = false, showTime = true } = options;
		const track = this.currentTrack;
		const resource = this.runtime.playbackController.activeResource ?? this.currentResource;
		const isLive = Boolean((track as any)?.isLive);
		if (isLive || !track || !resource) return isLive ? "🔴 LIVE" : "";
		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Number(resource.playbackDuration ?? 0);
		if (!total) return this.formatTimeCompact(current);
		const ratio = Math.min(Math.max(current / total, 0), 1);
		const progress = Math.round(ratio * size);
		const filled = barChar.repeat(progress);
		const empty = barChar.repeat(Math.max(0, size - progress));
		const bar = progressChar === "none" || (options as any).hideProgressChar ? filled + empty : filled + progressChar + empty;
		const formatTimeFn = timeFormat === "compact" ? this.formatTimeCompact.bind(this) : this.formatTime.bind(this);
		let result = showTime ? `${formatTimeFn(current)} ${bar} ${formatTimeFn(total)}` : bar;
		if (showPercentage) result += ` (${Math.round(ratio * 100)}%)`;
		return result;
	}
	public formatTime(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = totalSeconds % 60;
		const parts: string[] = [];
		if (hours > 0) {
			parts.push(String(hours));
			parts.push(String(minutes).padStart(2, "0"));
		} else parts.push(String(minutes));
		parts.push(String(seconds).padStart(2, "0"));
		return parts.join(":");
	}
	public formatTimeCompact(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = totalSeconds % 60;
		if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}
	public addPlugin(plugin: BasePlugin): void { this.pluginManager.register(plugin); }
	public removePlugin(name: string): boolean { return this.pluginManager.unregister(name); }
	public attachExtension(extension: BaseExtension): void { this.extensionManager.register(extension); }
	public detachExtension(extension: BaseExtension): boolean { return this.extensionManager.unregister(extension); }
	public subscribeTo(leader: Player, options?: { forwardMode?: boolean }): boolean { return this.forwardController.subscribeTo(leader, options); }
	public unsubscribeForward(reason?: string): boolean { return this.forwardController.unsubscribeForward(reason); }
	public getForwardHealthStatus() {
		const role: "leader" | "follower" | "none" = this.forwardController.isLeader ? "leader" : this.forwardController.isFollower ? "follower" : "none";
		const issues: string[] = [];
		if (role === "follower" && !this.forwardController.forwardLeader) issues.push("missing leader");
		if (role === "leader" && this.forwardController.forwardFollowers.size === 0) issues.push("no followers");
		return { guildId: this.guildId, healthy: issues.length === 0, role, issues, details: { leaderId: this.forwardController.forwardLeader?.guildId, followerCount: this.forwardController.forwardFollowers.size, connectionState: this.connection?.state?.status, audioPlayerState: this.playbackController.status } };
	}
	public action(action: PlayerActionMessage): Promise<void> { return this.runtime.actionExecutor.enqueue(action); }
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> { return this.runtime.bus.query(query); }
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void { return this.runtime.bus.subscribe(type, listener); }
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.eventBridge.dispose();
		this.runtime.dispose();
		this.emit("playerDestroy");
		this.removeAllListeners();
	}
}
