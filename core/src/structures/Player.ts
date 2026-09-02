import { EventEmitter } from "events";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { AudioPlayer, PlayerSubscription, VoiceConnection } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware, StreamInfo, Track, VoiceChannel, SearchResult } from "../types";
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
import { PlaybackController } from "../Controller/PlaybackController";
import { StreamController } from "../Controller/StreamController";
import { FilterController } from "../Controller/FilterController";
import { QueueController } from "../Controller/QueueController";
import { AntiStuckController } from "../Controller/AntiStuckController";
import { TransitionController } from "../Controller/TransitionController";
import { VolumeController } from "../Controller/VolumeController";
import { PreloadController } from "../Controller/PreloadController";
import { ConnectionController } from "../Controller/ConnectionController";
import { LifecycleController } from "../Controller/LifecycleController";
import { ForwardController } from "../Controller/ForwardController";
import { TTSController } from "../Controller/TTSController";
import { PlayerEventBridge } from "../Controller/PlayerEventBridge";
import { SearchController } from "../Controller/SearchController";
import { PlayerEventDebug } from "../Controller/PlayerEventDebug";
import { Queue } from "./Queue";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";

/**
 * The player is the composition root and the single owner of runtime state.
 * Controllers own individual responsibilities; this class owns their lifetime
 * and exposes the public facade. There is intentionally no separate runtime
 * wrapper object.
 */
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
	public currentResource: any;

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
			...(Array.isArray(this.options.trackMiddleware) ? this.options.trackMiddleware : this.options.trackMiddleware ? [this.options.trackMiddleware] : []),
		];
		this.connectionController = new ConnectionController({ guildId, bus: this.bus, options: this.options, debug });
		this.lifecycleController = new LifecycleController({ bus: this.bus, options: this.options, debug });
		this.forwardController = new ForwardController(this, { debug });
		this.queue = new Queue();
		this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.streamManager = new StreamManager({ maxConcurrentStreams: this.options.maxStreamStore ?? 4, streamTimeout: 5 * 60 * 1000, maxListenersPerStream: 15, enableMetrics: true, autoDestroy: true });
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
		Object.defineProperty(this, "relatedTracks", { enumerable: true, configurable: true, get: () => this.queueController.relatedTracks });
		const resolver = new TrackResolver(this.streamManager);
		this.preloadManager = new PreloadManager({
			streamManager: this.streamManager,
			debug,
			getNextTrack: () => (this.queue.loop() === "track" ? this.queue.currentTrack : this.queue.nextTrack),
			getStream: (t) => resolver.resolve(this, t),
			removeTrackFromQueue: (t) => {
				const n = this.queue.nextTrack;
				return (n === t || (n?.id !== undefined && t.id !== undefined && n.id === t.id) || (n?.url !== undefined && t.url !== undefined && n.url === t.url)) ? this.queue.remove(0) !== null : false;
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
			qualityController: { get: () => this.options.quality, set: (quality) => { this.options.quality = quality; } },
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
		this.volumeController = new VolumeController(this.bus, { initialVolume: (this.options as any).volume ?? 100, loudness: this.options.loudnessNormalization });
		this.playbackController = new PlaybackController({ audioPlayer: this.audioPlayer, bus: this.bus, volumeController: this.volumeController, transitionController: this.transitionController });
		this.streamController = new StreamController({ streamManager: this.streamManager, bus: this.bus });
		this.antiStuckController = new AntiStuckController({ ...this.options.antiStuck, bus: this.bus });
		this.preloadController = new PreloadController({ loader: this.trackLoader, manager: this.preloadManager, bus: this.bus });
		this.filterController = new FilterController({
			refreshPlayerResource: (position) => this.bus.request({ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position }, { timeoutMs: 30000 }).then(() => true).catch(() => false),
		}, debug, this.bus);
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
		this.searchController = new SearchController({ extensionManager: this.extensionManager, pluginManager: this.pluginManager, debug });
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
		this.detachResourceRefresh = this.bus.onInput("[Player]->[Resource]:refresh", (event) => { void this.handleResourceRefresh(event); });
		this.bus.subscribe("volumeRequested", ({ volume }) => this.volumeController.setVolume(volume));
		if (Array.isArray(this.options.filters) && this.options.filters.length > 0)
			void this.filterController.applyFilters(this.options.filters).catch((error) => debug("[FilterController] Initial filter error:", error));
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.listenerCount("debug") > 0 || this.manager.debugEnabled) this.manager.emit("debug", `[Player:${this.guildId}] ${message}`, ...optionalParams);
	}
	public get currentTrack(): Track | null { return this.queueController.current ?? null; }
	public get queueSize(): number { return this.queueController.snapshot().length; }
	public get isPlaying(): boolean { return this.playbackController.status === "playing"; }
	public get isPaused(): boolean { return this.playbackController.status === "paused"; }
	public get isLive(): boolean { if (this.playbackMode === "FORWARD") return this.forwardLeader?.isLive ?? false; return Boolean(this.currentTrack?.isLive); }
	public get isIdle(): boolean { if (this.playbackMode === "FORWARD") return this.forwardLeader?.isIdle ?? true; return this.playbackController.status === "idle"; }
	public get isBuffering(): boolean { if (this.playbackMode === "FORWARD") return this.forwardLeader?.isBuffering ?? false; return this.playbackController.status === "buffering"; }
	public get volume(): number { return this.volumeController.value; }
	public set volume(value: number) { this.volumeController.setVolume(value); }

	public search(query: string, requestedBy: string): Promise<SearchResult> { return this.searchController.search(query, requestedBy); }
	public clearSearchCache(): void { this.searchController.clear(); }
	public debugSearchQuery(query: string): ReturnType<SearchController["debug"]> { return this.searchController.debug(query); }
	public async connect(channel: VoiceChannel): Promise<VoiceConnection> { return this.bus.request({ type: "[Player]->[Connection]:connect", requestId: createPlayerRequestId(), channel }).then((e) => e.connection); }
	public async disconnect(): Promise<void> { return this.bus.request({ type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId() }).then(() => undefined); }
	public async play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		if (this.destroyed) return false;
		if (query === null) return this.isPlaying || this.isPaused ? true : this.playNext();
		let tracks: Track[];
		try { tracks = typeof query === "string" ? (await this.search(query, requestedBy || "Unknown")).tracks : "tracks" in query ? query.tracks : [query]; }
		catch (error) { this.debug("[Player] Play search error:", error); this.emit("playerError", error as Error); return false; }
		if (tracks.length === 0) return false;
		if (tracks.length === 1 && this.options.tts?.interrupt !== false && this.ttsController.isTTS(tracks[0])) { await this.ttsController.play(tracks[0]); return true; }
		this.queueController.addMultiple(tracks);
		if (this.isPlaying || this.isPaused) { void this.preloadController.preload().catch((error) => this.debug("[Player] Preload after queue add error:", error)); return true; }
		return this.playNext();
	}
	public async playNext(): Promise<boolean> { if (this.destroyed) return false; return this.action({ type: "SKIP" }).then(() => this.isPlaying || this.currentTrack !== null).catch(() => false); }
	public pause(): boolean { void this.action({ type: "PAUSE" }); return true; }
	public resume(): boolean { void this.action({ type: "RESUME" }); return true; }
	public stop(): boolean { void this.action({ type: "STOP" }); return true; }
	public async seek(position: number): Promise<boolean> { return this.action({ type: "SEEK", position }).then(() => true).catch(() => false); }
	public skip(): boolean { void this.action({ type: "SKIP" }); return true; }
	public action(action: PlayerActionMessage): Promise<void> { return this.actionExecutor.enqueue(action); }
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> { return this.bus.query(query); }
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void { return this.bus.subscribe(type, listener); }
	public addPlugin(plugin: BasePlugin): void { this.pluginManager.register(plugin); }
	public removePlugin(name: string): boolean { return this.pluginManager.unregister(name); }
	public attachExtension(extension: BaseExtension): void { this.extensionManager.register(extension); }
	public detachExtension(extension: BaseExtension): boolean { return this.extensionManager.unregister(extension); }

	private isCurrentSession(sessionId: number): boolean { const session = this.orchestrator.currentSession; return !!session && session.owns(sessionId); }
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
			await this.bus.action({ type: "FILTER_SET_SOURCE_TYPE", streamType: info.type ?? "arbitrary", requestId: createPlayerRequestId() });
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter source update");
			await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo: info, position: Math.max(0, position), requestId: createPlayerRequestId() });
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter seek");
			const processed = await this.bus.query("filteredStream");
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed while reading filtered stream");
			if (!processed) throw new Error("Filter controller did not produce a stream");
			const active = await this.streamController.replace(processed, session);
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after stream replacement");
			const resource = this.playbackController.createResource(active.stream, session.track);
			if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed before resource activation");
			session.setResource(resource);
			this.currentResource = resource;
			this.playbackController.play(resource, session);
			session.markPlaying(Math.max(0, position));
			this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
			this.bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, session: session.snapshot() });
		} catch (error) {
			this.bus.emitOutput({ type: "[Resource]->[Player]:error", requestId: event.requestId, error: error instanceof Error ? error : new Error(String(error)) });
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
