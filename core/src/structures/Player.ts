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
import { PlaybackMode } from "../types";
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
import type { PlayerRuntimeGraph } from "../types";

export class Player extends EventEmitter {
	public readonly bus = new PlayerBus();
	public readonly actionExecutor = new PlayerAction(this.bus);
	public readonly runtime: PlayerRuntimeController;
	public readonly guildId: string;
	public readonly manager: PlayerManager;
	public readonly options: PlayerOptions;

	public connection: VoiceConnection | null = null;
	public userdata?: Record<string, any>;
	public _lastActivity = Date.now();
	public destroyed = false;

	private disposed = false;
	private playOperation: Promise<boolean> = Promise.resolve(false);
	private playGeneration = 0;
	private playAbortController: AbortController | null = null;
	public readonly runtimeGraph: PlayerRuntimeGraph;

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
		this.runtimeGraph = this.runtime.initialize(this, manager, this.options, debug);
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

	public get queue() {
		return this.runtimeGraph.queueController;
	}
	public get pluginManager() {
		return this.runtimeGraph.pluginManager;
	}
	public get extensionManager() {
		return this.runtimeGraph.extensionManager;
	}
	public get streamManager() {
		return this.runtimeGraph.streamManager;
	}
	public get preloadManager() {
		return this.runtimeGraph.preloadManager;
	}
	public get filter() {
		return this.runtimeGraph.filterController;
	}
	public get audioPlayer() {
		return this.runtimeGraph.audioPlayer;
	}
	public get playbackMode(): PlaybackMode {
		return this.runtimeGraph.forwardController.playbackMode;
	}
	public get forwardLeader(): Player | null {
		return this.runtimeGraph.forwardController.forwardLeader;
	}
	public get forwardFollowers(): ReadonlySet<Player> {
		return this.runtimeGraph.forwardController.forwardFollowers;
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
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}

	public get isIdle(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isIdle ?? true;
		return this.bus.querySync("playerState") === "idle";
	}

	public get isBuffering(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isBuffering ?? false;
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

	public get availablePlugins(): string[] {
		return this.bus.querySync("availablePlugins").map((plugin) => plugin.name);
	}

	public get relatedTracks(): Track[] {
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

	/** Regenerates related tracks for the supplied track or the current track. */
	public createRelatedTracks(track?: Track | null): Promise<Track[]> {
		return this.bus.requestRpc("playback.createRelatedTracks", { track });
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
		const generation = ++this.playGeneration;
		const controller = new AbortController();
		this.playAbortController?.abort();
		this.playAbortController = controller;
		const operation = this.playOperation
			.catch(() => false)
			.then(() => {
				if (generation !== this.playGeneration || controller.signal.aborted) return false;
				return this.bus
					.requestRpc("play", { query, requestedBy }, { signal: controller.signal })
					.then((result) => (generation === this.playGeneration ? result : false));
			});
		this.playOperation = operation;
		return operation.finally(() => {
			if (this.playAbortController === controller) this.playAbortController = null;
		});
	}
	public async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
		return this.action({ type: "SKIP" })
			.then(() => this.isPlaying || this.currentTrack !== null)
			.catch(() => false);
	}
	public pause(): boolean {
		this.invalidatePlay();
		void this.action({ type: "PAUSE" });
		return true;
	}
	public resume(): boolean {
		void this.action({ type: "RESUME" });
		return true;
	}
	public stop(): boolean {
		this.invalidatePlay();
		void this.action({ type: "STOP" });
		return true;
	}
	public async seek(position: number): Promise<boolean> {
		this.invalidatePlay();
		return this.action({ type: "SEEK", position })
			.then(() => true)
			.catch(() => false);
	}
	public skip(): boolean {
		this.invalidatePlay();
		void this.action({ type: "SKIP" });
		return true;
	}
	private invalidatePlay(): void {
		this.playGeneration++;
		this.playAbortController?.abort();
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
	public async previous(): Promise<boolean> {
		const track = this.bus.requestRpcSync<void, Track | null>("queue.previous", undefined);
		if (!track) return false;
		await this.startTrack(track);
		return true;
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
	public getTime(): { current: number; total: number; format: string; formatted: { current: string; total: string } } {
		return this.bus.querySync("time");
	}
	public action(action: PlayerActionMessage): Promise<void> {
		return this.actionExecutor.execute(action);
	}
	public onEvent(type: PlayerEventType, listener: (...args: any[]) => void): this {
		return this.on(type, listener);
	}
	public destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.destroyed = true;
		this.invalidatePlay();
		this.runtime.dispose();
		this.removeAllListeners();
		this.bus.dispose();
	}
}
