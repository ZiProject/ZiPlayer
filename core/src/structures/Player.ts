import { EventEmitter } from "events";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { AudioPlayer, PlayerSubscription, VoiceConnection } from "@discordjs/voice";
import type {
	PlayerOptions,
	TrackMiddleware,
	StreamInfo,
	Track,
	VoiceChannel,
	SearchResult,
	ProgressBarOptions,
	TrackLoadResult,
} from "../types";
import type { PlayerManager } from "./PlayerManager";
import {
	PlayerBus,
	createPlayerRequestId,
	type PlayerInput,
	type PlayerAction as PlayerActionMessage,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
} from "./PlayerBus";
import { PlayerAction } from "./PlayerAction";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { TrackLoader } from "./TrackLoader";
import { TrackResolver } from "./TrackResolver";
import { PlaybackController } from "../controller/PlaybackController";
import { StreamController } from "../controller/StreamController";
import { FilterController } from "../controller/FilterController";
import { QueueController } from "../controller/QueueController";
import { AntiStuckController } from "../controller/AntiStuckController";
import { TransitionController } from "../controller/TransitionController";
import { VolumeController } from "../controller/VolumeController";
import { PreloadController } from "../controller/PreloadController";
import { ConnectionController } from "../controller/ConnectionController";
import { LifecycleController } from "../controller/LifecycleController";
import { ForwardController } from "../controller/ForwardController";
import { TTSController } from "../controller/TTSController";
import { PlayerEventBridge } from "../controller/PlayerEventBridge";
import { SearchController } from "../controller/SearchController";
import { PlayerEventDebug } from "../controller/PlayerEventDebug";
import { Queue } from "./Queue";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { AudioResource } from "@discordjs/voice";
import type { PlaybackSession } from "./PlaybackSession";
import { Stream } from "stream";

export class Player extends EventEmitter {
	public readonly bus = new PlayerBus();
	public readonly actionExecutor = new PlayerAction(this.bus);
	public readonly guildId: string;
	public readonly manager: PlayerManager;
	public readonly options: PlayerOptions;
	public readonly connectionController: ConnectionController;
	public readonly lifecycleController: LifecycleController;
	public readonly forwardController: ForwardController;
	public readonly queue: Queue;
	public readonly audioPlayer: AudioPlayer;
	public readonly streamManager: StreamManager;
	public readonly preloadManager: PreloadManager;
	public readonly pluginManager: PluginManager;
	public readonly extensionManager: ExtensionManager;
	public readonly queueController: QueueController;
	public readonly trackLoader: TrackLoader;
	public readonly playbackController: PlaybackController;
	public readonly streamController: StreamController;
	public readonly filterController: FilterController;
	public readonly antiStuckController: AntiStuckController;
	public readonly transitionController: TransitionController;
	public readonly volumeController: VolumeController;
	public readonly preloadController: PreloadController;
	public readonly orchestrator: PlaybackOrchestrator;
	public readonly ttsController: TTSController;
	public readonly debugTracer: PlayerEventDebug;
	public readonly searchController: SearchController;
	public readonly eventBridge: PlayerEventBridge;
	public connection: VoiceConnection | null = null;
	public filter: FilterController;
	public playbackMode: any;
	public userdata?: Record<string, any>;
	public _lastActivity = Date.now();
	public destroyed = false;
	public forwardFollowers = new Set<Player>();
	public forwardLeader: Player | null = null;

	private disposed = false;
	private readonly detachResourceRefresh: () => void;
	private readonly detachConnectionSubscription: () => void;
	private audioPlayerSubscription: PlayerSubscription | null = null;

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
		this.debugTracer = new PlayerEventDebug(this.bus, guildId, debug, manager.debugLevel ?? "info");
		const middleware: TrackMiddleware[] = [
			...manager.getTrackMiddlewareChain(),
			...(Array.isArray(this.options.trackMiddleware) ? this.options.trackMiddleware
			: this.options.trackMiddleware ? [this.options.trackMiddleware]
			: []),
		];
		this.connectionController = new ConnectionController({ guildId, bus: this.bus, options: this.options, debug });
		this.lifecycleController = new LifecycleController({ bus: this.bus, options: this.options, debug });
		this.forwardController = new ForwardController(this, { debug });
		this.queue = new Queue();
		this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.streamManager = new StreamManager({
			maxConcurrentStreams: this.options.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		this.pluginManager = new PluginManager(this, manager, { extractorTimeout: this.options.extractorTimeout });
		this.extensionManager = new ExtensionManager(this, manager);
		this.ttsController = new TTSController({
			pluginManager: this.pluginManager,
			extensionManager: this.extensionManager,
			audioPlayer: this.audioPlayer,
			debug,
			maxTimeTts: this.options.tts?.maxTimeTts,
			volume: this.options.tts?.volume ?? this.options.volume ?? 100,
			onStart: (track) => this.emit("ttsStart", { track }),
			onEnd: () => this.emit("ttsEnd"),
		});
		this.queueController = new QueueController({ queue: this.queue, bus: this.bus });
		const resolver = new TrackResolver(this.streamManager);
		this.preloadManager = new PreloadManager({
			streamManager: this.streamManager,
			debug,
			getNextTrack: () => (this.queue.loop() === "track" ? this.queue.currentTrack : this.queue.nextTrack),
			getStream: (t) => resolver.resolve(this, t),
			removeTrackFromQueue: (t) => {
				const n = this.queue.nextTrack;
				return (
						n === t ||
							(n?.id !== undefined && t.id !== undefined && n.id === t.id) ||
							(n?.url !== undefined && t.url !== undefined && n.url === t.url)
					) ?
						this.queue.remove(0) !== null
					:	false;
			},
			isDestroyed: () => this.disposed,
			isEnabled: () => this.options.preload?.enabled ?? true,
		});
		this.trackLoader = new TrackLoader({
			middleware,
			context: { player: this, manager },
			resolvers: [(t) => resolver.resolve(this, t)],
			recovery: this.options.antiStuck,
			preloadManager: this.preloadManager,
			qualityController: {
				get: () => this.options.quality,
				set: (quality) => {
					this.options.quality = quality;
				},
			},
			debug,
		});
		this.transitionController = new TransitionController({
			enabled: this.options.crossfade?.enabled ?? true,
			durationMs: this.options.crossfade?.durationMs,
			smartEnabled: this.options.smartTransition?.enabled ?? true,
			genreAware: this.options.smartTransition?.genreAware ?? true,
			beatAlign: this.options.smartTransition?.beatAlign ?? true,
			baseDurationMs: this.options.smartTransition?.baseDurationMs ?? this.options.crossfade?.durationMs,
			minDurationMs: this.options.smartTransition?.minDurationMs,
			maxDurationMs: this.options.smartTransition?.maxDurationMs,
			beatAlignMaxWaitMs: this.options.smartTransition?.beatAlignMaxWaitMs,
			genreDurations: this.options.smartTransition?.genreDurations,
		});
		this.volumeController = new VolumeController(this.bus, {
			initialVolume: this.options?.volume ?? 100,
			loudness: this.options.loudnessNormalization,
		});
		this.playbackController = new PlaybackController({
			audioPlayer: this.audioPlayer,
			bus: this.bus,
			volumeController: this.volumeController,
			transitionController: this.transitionController,
		});
		this.streamController = new StreamController({ streamManager: this.streamManager, bus: this.bus });
		this.antiStuckController = new AntiStuckController({ ...this.options.antiStuck, bus: this.bus });
		this.preloadController = new PreloadController({ loader: this.trackLoader, manager: this.preloadManager, bus: this.bus });
		this.filterController = new FilterController(
			{
				refreshPlayerResource: (position) =>
					this.bus
						.request({ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position }, { timeoutMs: 30000 })
						.then(() => true)
						.catch(() => false),
			},
			debug,
			this.bus,
		);
		this.filter = this.filterController;
		this.orchestrator = new PlaybackOrchestrator(this.bus, {
			trackLoader: this.trackLoader,
			streamController: this.streamController,
			filterController: this.filterController,
			playbackController: this.playbackController,
			queueController: this.queueController,
			transitionController: this.transitionController,
			preloadController: this.preloadController,
			relatedTrackResolver: (track) => this.pluginManager.getRelatedTracks(track),
		});
		this.searchController = new SearchController({
			extensionManager: this.extensionManager,
			pluginManager: this.pluginManager,
			debug,
		});
		this.eventBridge = new PlayerEventBridge(this, manager, this.bus, this.debugTracer);
		this.detachConnectionSubscription = this.bus.onOutput("[Connection]->[Player]:connected", (event) => {
			if (this.connection === event.connection) return;
			this.audioPlayerSubscription?.unsubscribe();
			this.audioPlayerSubscription = event.connection.subscribe(this.audioPlayer) ?? null;
			this.ttsController.setConnection(event.connection);
			this.connection = event.connection;
			debug(`[Player] AudioPlayer subscribed guild=${guildId} session=${event.sessionId}`);
		});
		this.bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			this.audioPlayerSubscription?.unsubscribe();
			this.audioPlayerSubscription = null;
			this.ttsController.setConnection(null);
			this.connection = null;
			debug(`[Player] AudioPlayer unsubscribed guild=${guildId} reason=${event.reason ?? "unknown"}`);
		});
		this.detachResourceRefresh = this.bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.handleResourceRefresh(event);
		});
		this.bus.subscribe("volumeRequested", ({ volume }) => this.volumeController.setVolume(volume));
		if (Array.isArray(this.options.filters) && this.options.filters.length > 0)
			void this.filterController
				.applyFilters(this.options.filters)
				.catch((error) => debug("[FilterController] Initial filter error:", error));
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.listenerCount("debug") > 0 || this.manager.debugEnabled)
			this.manager.emit("debug", `[Player:${this.guildId}] ${message}`, ...optionalParams);
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
	public get previousTrack(): Track | null {
		return this.queue?.previousTracks?.at?.(-1) ?? null;
	}
	public get upcomingTracks(): Track[] {
		return this.queueController?.snapshot?.() ?? [];
	}
	public get previousTracks(): Track[] {
		return this.queue?.previousTracks ?? [];
	}
	public get availablePlugins(): BasePlugin[] {
		return this.pluginManager?.getAll?.() ?? [];
	}
	public get relatedTracks(): Track[] | null {
		return this.queueController?.relatedTracks ?? null;
	}
	public get currentResource() {
		return this.playbackController.activeResource ?? null;
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
		if (query === null) return this.isPlaying || this.isPaused ? true : this.playNext();
		let tracks: Track[];
		try {
			tracks =
				typeof query === "string" ? (await this.search(query, requestedBy || "Unknown")).tracks
				: "tracks" in query ? query.tracks
				: [query];
		} catch (error) {
			this.debug("[Player] Play search error:", error);
			this.emit("playerError", error as Error);
			return false;
		}
		if (tracks.length === 0) return false;
		if (tracks.length === 1 && this.options.tts?.interrupt !== false && this.ttsController.isTTS(tracks[0])) {
			await this.ttsController.play(tracks[0]);
			return true;
		}
		this.queueController.addMultiple(tracks);
		if (this.isPlaying || this.isPaused) {
			void this.preloadController.preload().catch((error) => this.debug("[Player] Preload after queue add error:", error));
			return true;
		}
		return this.playNext();
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

	public getCachedSearchResult(query: string): SearchResult | null {
		return this.searchController.cache?.get?.(query.toLowerCase().trim()) ?? null;
	}
	public cacheSearchResult(query: string, result: SearchResult): void {
		this.searchController.cacheResult(query, result);
	}
	public clearExpiredSearchCache(): void {
		this.searchController.purgeStale();
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

	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		if (!resource?.volume) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) {
			resource.volume.setVolume(to);
			return;
		}
		const start = Date.now();
		while (true) {
			const progress = Math.min(1, (Date.now() - start) / duration);
			resource.volume.setVolume(from + (to - from) * progress);
			if (progress >= 1) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		if (!resource?.volume) return;
		const target = this.getTrackTargetVolume(track);
		resource.volume.setVolume(0);
		this.volumeController.applyLoudness(resource, track, 0);
		await this.fadeResourceVolume(resource, 0, target, this.resolveSmartTransitionDuration(track));
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		const resource = this.currentResource ?? this.playbackController.activeResource;
		if (!resource?.volume) return;
		const current = Number(resource.volume.volume ?? this.getTrackTargetVolume(this.currentTrack as Track));
		await this.fadeResourceVolume(resource, current, 0, this.resolveSmartTransitionDuration(this.currentTrack as Track));
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		await this.applyCrossfadeOutCurrent();
		this.playbackController.stop();
	}
	public getTrackMetadataValue(track: Track, key: string): any {
		return track?.metadata?.[key];
	}
	public resolveSmartTransitionDuration(track: Track): number {
		return this.transitionController.plan(this.currentTrack, track).durationMs;
	}
	public async maybeAlignToBeatBoundary(track?: Track): Promise<void> {
		const wait = this.transitionController.beatWaitMs(track ?? this.currentTrack, this.getTime().current);
		if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
	}
	public getTrackTargetVolume(track: Track): number {
		const settings = this.volumeController.settings;
		const lufs = Number(track?.metadata?.lufs);
		if (!settings.enabled || !Number.isFinite(lufs)) return this.volume / 100;
		const correctionDb = Math.max(-settings.maxCutDb, Math.min(settings.maxBoostDb, settings.targetLUFS - lufs));
		const gain = Math.pow(10, correctionDb / 20);
		const ceiling = Math.pow(10, settings.limiterCeiling / 20);
		return Math.min((this.volume / 100) * gain, ceiling);
	}
	public attemptTrackRecovery(track: Track, session?: PlaybackSession): Promise<TrackLoadResult> {
		if (!session) return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession"));
		return this.trackLoader.loadWithRecovery(track, session);
	}
	public promotePreloadToCurrent(track: Track): AudioResource | null {
		const session = this.orchestrator.currentSession;
		if (!session) return null;
		return this.preloadController.promote(track, {
			resource: null,
			track: null,
			streamId: null,
			processedStreamId: null,
			abortController: null,
			isValid: false,
			isLoading: false,
			loadPromise: null,
		} as any);
	}

	public createResource(stream: Stream.Readable, track: Track): AudioResource {
		return this.playbackController.createResource(stream, track);
	}
	public mergeTrackPreserveRef(target: Track, source: Track): Track {
		Object.assign(target, source);
		return target;
	}
	public async applyTrackMiddleware(track: Track): Promise<Track> {
		const middleware: PlayerOptions["trackMiddleware"] = this.options.trackMiddleware;
		if (!Array.isArray(middleware)) return track;
		for (const fn of middleware) {
			const result = await fn(track, { player: this, manager: this.manager });
			if (result && result !== track) Object.assign(track, result);
		}
		return track;
	}
	public async getStream(track: Track): Promise<StreamInfo | TrackLoadResult | null> {
		const session = this.orchestrator.currentSession;
		if (session) return this.trackLoader.load(track, session);
		const extensionStream = await this.extensionManager?.provideStream?.(track);
		return extensionStream ?? this.pluginManager?.getStream?.(track);
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
		return this.trackLoader.load(track, session ?? this.orchestrator.currentSession);
	}
	public async playRemote(_track: Track, stream: any, ..._args: any[]): Promise<boolean> {
		if (stream?.handle?.play) await stream.handle.play();
		return true;
	}
	public ensureTTSPlayer(): boolean {
		return !!this.ttsController?.ttsPlayer;
	}
	public interruptWithTTSTrack(track: Track, ..._args: any[]): Promise<boolean> {
		return this.play(track);
	}

	public previous(): Track | null {
		return this.queueController.previous();
	}
	public async save(track: Track, options?: any): Promise<any> {
		// const extensionResult = await this.extensionManager?.save?.(track, options);
		// if (extensionResult) return extensionResult;
		// const pluginSave = this.pluginManager?.save;
		// if (typeof pluginSave === "function") return pluginSave.call(this.pluginManager, track, options);
		throw new Error("No save provider is available for this track");
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
	public async insert(query: string | Track | Track[], index = 0, requestedBy?: string): Promise<boolean> {
		try {
			const tracks =
				typeof query === "string" ? (await this.search(query, requestedBy || "Unknown")).tracks
				: Array.isArray(query) ? query
				: [query];
			if (tracks.length === 0) return false;
			for (let i = 0; i < tracks.length; i++) this.queueController.insert(tracks[i], index + i);
			return true;
		} catch (error) {
			this.debug("[Player] Insert error:", error);
			this.emit("playerError", error as Error);
			return false;
		}
	}
	public remove(index: number): Track | null {
		return this.queueController.remove(index);
	}
	public scheduleLeave(): void {
		this.lifecycleController.scheduleLeave?.();
	}
	public clearLeaveTimeout(): void {
		this.lifecycleController.clearLeaveTimeout?.();
	}
	public refreshPlayerResource(position = 0): Promise<boolean> {
		return this.bus
			.request({ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position } as any)
			.then(() => true)
			.catch(() => false);
	}
	public getExtensions(): any[] {
		return this.extensionManager?.getAll?.() ?? [];
	}
	public setupEventListeners(): void {}
	public saveSession(options?: any): any {
		return this.getSerializableState();
	}
	public exitRemoteMode(): void {
		this.playbackMode = "NATIVE";
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
		const total = Math.floor(track.duration) | 0;
		const seekOffset = Number((this as any).seekOffset ?? 0);
		const current = Math.floor(Number(resource.playbackDuration ?? 0) + seekOffset) | 0;
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
		const track = this.currentTrack;
		const resource = this.playbackController.activeResource ?? this.currentResource;
		const isLive = Boolean(track?.isLive);
		if (isLive || !track || !resource) return isLive ? "🔴 LIVE" : "";
		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Number(resource.playbackDuration ?? 0);
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
		if (role === "leader") {
			for (const follower of this.forwardController.forwardFollowers) {
				if (follower.destroyed || !follower.connection) issues.push(follower.guildId);
			}
		} else if (role === "follower" && (!this.forwardController.forwardLeader || this.forwardController.forwardLeader.destroyed)) {
			issues.push("missing leader");
		}
		return {
			guildId: this.guildId,
			healthy: role === "leader" ? true : issues.length === 0,
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

	private isCurrentSession(sessionId: number): boolean {
		const session = this.orchestrator.currentSession;
		return !!session && session.owns(sessionId);
	}
	private async handleResourceRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		try {
			const session = this.orchestrator.currentSession;
			if (!session?.track || !session.isActive()) throw new Error("No active playback session");
			const sessionId = session.id;
			const position = event.position ?? session.position ?? 0;
			const info = await this.resolveFreshStream(session.track);
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed during resource refresh");
			if (!info?.stream && !info?.url) throw new Error("No stream available for resource refresh");
			if (info.remote) throw new Error("Cannot refresh a remote playback resource");
			await this.bus.action({
				type: "FILTER_SET_SOURCE_TYPE",
				streamType: info.type ?? "arbitrary",
				requestId: createPlayerRequestId(),
			});
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter source update");
			await this.bus.action({
				type: "FILTER_APPLY_AND_SEEK",
				streamInfo: info,
				position: Math.max(0, position),
				requestId: createPlayerRequestId(),
			});
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter seek");
			const processed = await this.bus.query("filteredStream");
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed while reading filtered stream");
			if (!processed) throw new Error("Filter controller did not produce a stream");
			const active = await this.streamController.replace(processed, session);
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after stream replacement");
			const resource = this.playbackController.createResource(active.stream, session.track);
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed before resource activation");
			session.setResource(resource);
			this.playbackController.activeResource = resource;
			this.playbackController.play(resource, session);
			session.markPlaying(Math.max(0, position));
			this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
			this.bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, session: session.snapshot() });
		} catch (error) {
			this.bus.emitOutput({
				type: "[Resource]->[Player]:error",
				requestId: event.requestId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
	private async resolveFreshStream(track: Track): Promise<StreamInfo | null> {
		let stream = await this.extensionManager.provideStream(track);
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream) return stream;
		stream = await this.pluginManager.getStream(track);
		if (stream?.stream || stream?.remote) return stream;
		throw new Error(`No stream available for track: ${track.title}`);
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.eventBridge.dispose();
		this.dispose();
		this.emit("playerDestroy");
		this.removeAllListeners();
	}
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachConnectionSubscription();
		this.audioPlayerSubscription?.unsubscribe();
		this.connection = null;
		this.detachResourceRefresh();
		this.filterController.destroy();
		this.lifecycleController.dispose();
		this.forwardController.dispose();
		this.volumeController.dispose();
		void this.connectionController.dispose();
		this.actionExecutor.dispose();
		this.orchestrator.dispose();
		this.preloadController.dispose();
		this.preloadManager.cancelPreload();
		this.streamController.dispose();
		this.streamManager.destroyAll();
		this.queueController.dispose();
		this.playbackController.dispose();
		this.ttsController.dispose();
		this.pluginManager.clear();
		this.extensionManager.destroy?.();
		this.debugTracer.dispose();
		this.bus.publish("destroyed");
		this.bus.clear();
	}
}
