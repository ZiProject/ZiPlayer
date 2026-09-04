import { EventEmitter } from "events";
import { Stream } from "stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerManager } from "./PlayerManager";
import type {
	PlayerOptions,
	StreamInfo,
	Track,
	VoiceChannel,
	SearchResult,
	ProgressBarOptions,
	TrackLoadResult,
	SaveOptions,
	SaveVideoOptions,
	SearchDebugResult,
} from "../types";
import {
	PlayerBus,
	createPlayerRequestId,
	type PlayerAction as PlayerActionMessage,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
} from "./PlayerBus";
import { PlayerAction } from "./PlayerAction";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { AudioResource } from "@discordjs/voice";
import type { PlaybackSession } from "./PlaybackSession";
import { PlayerRuntimeController } from "./PlayerRuntimeController";

export class Player extends EventEmitter {
	public readonly bus = new PlayerBus();
	public readonly actionExecutor = new PlayerAction(this.bus);
	public readonly runtime: PlayerRuntimeController;
	public readonly guildId: string;
	public readonly manager: PlayerManager;
	public readonly options: PlayerOptions;

	public connection: VoiceConnection | null = null;
	public playbackMode: any;
	public userdata?: Record<string, any>;
	public _lastActivity = Date.now();
	public destroyed = false;
	public forwardFollowers = new Set<Player>();
	public forwardLeader: Player | null = null;

	private disposed = false;

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
		const debug = this.debug.bind(this);

		this.runtime = new PlayerRuntimeController(this.bus);
		const graph = this.runtime.initialize(this, manager, this.options, debug);
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.listenerCount("debug") > 0 || this.manager.debugEnabled)
			this.manager.emit("debug", `[Player:${this.guildId}] ${message}`, ...optionalParams);
	}

	public get currentTrack(): Track | null {
		return this.bus.querySync("currentTrack");
	}

	public get queueSize(): number {
		return this.bus.querySync("queue").length;
	}

	public get isPlaying(): boolean {
		return this.bus.querySync("isPlaying");
	}

	public get isPaused(): boolean {
		return this.bus.querySync("isPaused");
	}

	public get isLive(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}

	public get isIdle(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isIdle ?? true;
		return this.bus.querySync("playerState") === "idle";
	}

	public get isBuffering(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isBuffering ?? false;
		return this.bus.querySync("playerState") === "buffering";
	}

	public get volume(): number {
		return this.bus.querySync("volume");
	}

	public set volume(value: number) {
		this.bus.requestRpcSync<{ value: number }, number>("volume.set", { value });
	}

	public get previousTrack(): Track | null {
		return this.bus.querySync("previousTrack");
	}

	public get upcomingTracks(): Track[] {
		return this.bus.querySync("queue");
	}

	public get previousTracks(): Track[] {
		return this.bus.querySync("previousTracks");
	}

	public get availablePlugins(): BasePlugin[] {
		return this.bus.querySync("availablePlugins");
	}

	public get relatedTracks(): Track[] | null {
		return this.bus.querySync("relatedTracks");
	}

	public get currentResource(): AudioResource | null {
		return this.bus.querySync("currentResource") as AudioResource | null;
	}

	public search(query: string, requestedBy: string): Promise<SearchResult> {
		return this.bus.requestRpc("search", { query, requestedBy });
	}

	public getCachedSearchResult(query: string): Promise<SearchResult | null> {
		return this.bus.requestRpc("search.cache.get", { query });
	}

	public cacheSearchResult(query: string, result: SearchResult): Promise<void> {
		return this.bus.requestRpc("search.cache.set", { query, result });
	}

	public clearSearchCache(): Promise<void> {
		return this.bus.requestRpc("search.cache.clear", {});
	}

	public clearExpiredSearchCache(): Promise<void> {
		return this.bus.requestRpc("search.cache.purge", {});
	}

	public debugSearchQuery(query: string): Promise<SearchDebugResult> {
		return this.bus.requestRpc("search.debug", { query });
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
		return this.bus.requestRpc("play", { query, requestedBy });
	}
	public async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
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
		return this.action({ type: "SEEK", position })
			.then(() => true)
			.catch(() => false);
	}
	public skip(): boolean {
		void this.action({ type: "SKIP" });
		return true;
	}
	public destroyCurrentStream(): void {
		void this.bus.action({ type: "STOP" });
	}
	public generateWillNext(): Track | null {
		return this.bus.querySync("willNext");
	}
	public preloadNextTrack(): Promise<void> {
		return this.bus.requestRpc("preload.next", undefined);
	}
	public safeCancelPreload(): Promise<void> {
		return this.bus.requestRpc("preload.cancelSafe", undefined);
	}
	public preloadNext(): Promise<void> {
		return this.bus.requestRpc("preload.next", undefined);
	}
	public cancelPreload(): void {
		this.bus.requestRpcSync<void, void>("preload.cancel", undefined);
	}
	public clearSlot(): void {
		this.bus.requestRpcSync<void, void>("preload.clear", undefined);
	}
	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		return this.bus.requestRpc("transition.fade", { resource, from, to, durationMs });
	}
	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		return this.bus.requestRpc("transition.fadeIn", { resource, track });
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		return this.bus.requestRpc("transition.fadeOutCurrent", undefined);
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		return this.bus.requestRpc("transition.skipAndStop", undefined);
	}
	public getTrackMetadataValue(track: Track, key: string): any {
		return track?.metadata?.[key];
	}
	public resolveSmartTransitionDuration(track: Track): number {
		return this.bus.requestRpcSync("transition.duration", { from: this.currentTrack, to: track });
	}
	public async maybeAlignToBeatBoundary(track?: Track): Promise<void> {
		const wait = this.bus.requestRpcSync<{ track: Track | null; positionMs: number }, number>("transition.beatWait", {
			track: track ?? this.currentTrack,
			positionMs: this.getTime().current,
		});
		if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
	}
	public getTrackTargetVolume(track: Track): number {
		return this.bus.requestRpcSync<{ track: Track | null }, number>("transition.targetVolume", { track });
	}
	public attemptTrackRecovery(track: Track, session?: PlaybackSession): Promise<TrackLoadResult> {
		if (!session) return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession"));
		return this.bus.requestRpc("playback.recover", { track, session });
	}
	public promotePreloadToCurrent(track: Track): AudioResource | null {
		return this.bus.requestRpcSync("playback.promotePreload", { track });
	}
	public createResource(stream: Stream.Readable, track: Track): AudioResource {
		return this.bus.requestRpcSync("resource.create", { stream, track });
	}
	public mergeTrackPreserveRef(target: Track, source: Track): Track {
		Object.assign(target, source);
		return target;
	}
	public async applyTrackMiddleware(track: Track): Promise<Track> {
		return this.bus.requestRpc("track.middleware", { track });
	}
	public async getStream(track: Track): Promise<StreamInfo | TrackLoadResult | null> {
		if (this.bus.querySync("playbackSession")) return this.bus.requestRpc("playback.loadFreshCurrent", { track });
		return this.bus.requestRpc("stream.resolve", { track });
	}
	public isUnrecoverableStreamError(error: unknown): boolean {
		const name = error instanceof Error ? error.name : "";
		const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		return name === "AbortError" || /unrecoverable|unsupported|not found|invalid source/.test(message);
	}
	public startTrack(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: "PLAY", track });
	}
	public startFromPreload(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: "PLAY", track });
	}
	public loadFreshStream(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		return this.bus.requestRpc("playback.loadFresh", { track, session });
	}
	public async playRemote(_track: Track, stream: any, ..._args: any[]): Promise<boolean> {
		return this.bus.requestRpc("playback.remote", { track: _track, stream });
	}
	public ensureTTSPlayer(): boolean {
		return this.runtime.hasTTSPlayer();
	}
	public interruptWithTTSTrack(track: Track, ..._args: any[]): Promise<boolean> {
		return this.play(track);
	}
	public previous(): Track | null {
		return this.bus.requestRpcSync<void, Track | null>("queue.previous", undefined);
	}
	async save(track: Track, options?: SaveOptions | string): Promise<Stream.Readable> {
		try {
			return await this.bus.requestRpc("save", { track, options });
		} catch (error) {
			this.debug("[Player] save error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	async saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Stream.Readable> {
		if (!track) throw new TypeError("A track is required to save video");
		try {
			return await this.bus.requestRpc("save.video", { track, options });
		} catch (error) {
			this.debug("[Player] saveVideo error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	public loop(mode?: any): any {
		return mode === undefined ? this.bus.querySync("queueLoop") : this.bus.requestRpcSync("queue.loop", { mode });
	}
	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ? this.bus.querySync("queueAutoPlay") : this.bus.requestRpcSync("queue.autoPlay", { enabled });
	}
	public setVolume(value: number): number {
		return this.bus.requestRpcSync("volume.set", { value });
	}
	public shuffle(): void {
		this.bus.requestRpcSync<void, void>("queue.shuffle", undefined);
	}
	public clearQueue(): void {
		this.bus.requestRpcSync<void, void>("queue.clear", undefined);
	}
	public async insert(query: string | Track | Track[], index = 0, requestedBy?: string): Promise<boolean> {
		return this.bus
			.requestRpc<{ query: string | Track | Track[]; index: number; requestedBy?: string }, boolean>("queue.insert", {
				query,
				index,
				requestedBy,
			})
			.catch(() => false);
	}
	public remove(index: number): Track | null {
		return this.bus.requestRpcSync<{ index: number }, Track | null>("queue.remove", { index });
	}
	public scheduleLeave(): void {
		this.bus.requestRpcSync("lifecycle.scheduleLeave", {});
	}
	public clearLeaveTimeout(): void {
		this.bus.requestRpcSync("lifecycle.clearLeaveTimeout", undefined);
	}
	public refreshPlayerResource(position = 0): Promise<boolean> {
		return this.bus
			.request({ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position } as any)
			.then(() => true)
			.catch(() => false);
	}
	public getExtensions(): any[] {
		return this.bus.querySync("extensions") ?? [];
	}
	public saveSession(_options?: any): any {
		return this.getSerializableState();
	}
	public exitRemoteMode(): void {
		this.playbackMode = "NATIVE";
	}
	public getSerializableState(): any {
		return { guildId: this.guildId, queue: this.runtime.serializeQueue(), volume: this.volume, playbackMode: this.playbackMode };
	}
	public restoreState(state: any): void {
		if (state?.queue) this.runtime.restoreQueue(state.queue);
		if (typeof state?.volume === "number") this.setVolume(state.volume);
		if (state?.playbackMode !== undefined) this.playbackMode = state.playbackMode;
	}
	public getStreamManagerStats(): any {
		return this.runtime.getStreamManagerStats() ?? {};
	}
	public getTime() {
		const session = this.bus.querySync("playbackSession");
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive) return { current: 0, total: 0, format: "LIVE", formatted: { current: "LIVE", total: "LIVE" } };
		if (!track) return { current: 0, total: 0, format: "00:00", formatted: { current: "00:00", total: "00:00" } };
		const total = Math.floor(track.duration > 1000 ? track.duration : track.duration * 1000) | 0;
		const current = Math.max(0, Math.floor(this.bus.querySync("position") ?? session?.position ?? 0)) | 0;
		return {
			current,
			total,
			format: this.formatTime(current),
			formatted: { current: this.formatTimeCompact(current), total: this.formatTimeCompact(total) },
		};
	}
	public getProgressBar(options: ProgressBarOptions = {}): string {
		const {
			size = 20,
			barChar = "▬",
			progressChar = "🔘",
			timeFormat = "compact",
			showPercentage = false,
			showTime = true,
		} = options;
		const session = this.bus.querySync("playbackSession");
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive || !track) return isLive ? "🔴 LIVE" : "";
		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Math.max(0, Number(this.bus.querySync("position") ?? session?.position ?? 0));
		if (!total) return this.formatTimeCompact(current);
		const ratio = Math.min(Math.max(current / total, 0), 1);
		const progress = Math.round(ratio * size);
		const filled = barChar.repeat(progress);
		const empty = barChar.repeat(Math.max(0, size - progress));
		const bar = progressChar === "none" || options.hideProgressChar ? filled + empty : filled + progressChar + empty;
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
	public action(action: PlayerActionMessage): Promise<void> {
		return this.actionExecutor.enqueue(action);
	}
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		return this.bus.query(query);
	}
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.bus.subscribe(type, listener);
	}
	public addPlugin(plugin: BasePlugin): void {
		this.bus.requestRpcSync<{ plugin: BasePlugin }, void>("plugin.add", { plugin });
	}
	public removePlugin(name: string): boolean {
		return this.bus.requestRpcSync<{ name: string }, boolean>("plugin.remove", { name });
	}
	public attachExtension(extension: BaseExtension): void {
		this.bus.requestRpcSync<{ extension: BaseExtension }, void>("extension.add", { extension });
	}
	public detachExtension(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync<{ extension: BaseExtension }, boolean>("extension.remove", { extension });
	}
	public subscribeTo(leader: Player, options?: { forwardMode?: boolean }): boolean {
		return this.bus.requestRpcSync("forward.subscribe", { leader, options });
	}
	public unsubscribeForward(reason?: string): boolean {
		return this.bus.requestRpcSync("forward.unsubscribe", { reason });
	}
	public getForwardHealthStatus() {
		return this.bus.requestRpcSync("forward.health", undefined);
	}
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.dispose();
		this.emit("playerDestroy");
		this.removeAllListeners();
	}
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.actionExecutor.dispose();
		void this.runtime.dispose();
		this.bus.publish("destroyed");
		this.bus.clear();
	}
}
