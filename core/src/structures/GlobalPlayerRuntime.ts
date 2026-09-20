import type { AudioPlayer } from "@discordjs/voice";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware, PlayerRuntimeGraph } from "../types";
import type { PlayerManager } from "./PlayerManager";
import type { Player } from "./Player";
import { Bus } from "./Bus";
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
import { PlayerEventDebug } from "../controller/PlayerEventDebug";
import { ResourceRefreshController } from "../controller/ResourceRefreshController";
import { PluginController } from "../controller/PluginController";
import { ExtensionController } from "../controller/ExtensionController";
import { SearchController } from "../controller/SearchController";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { SaveController } from "../controller/SaveController";
import { PlaybackSessionController } from "../controller/PlaybackSessionController";
import { globalControllerRegistry, type GlobalControllerRegistration } from "../controller/GlobalControllerRegistry";
import type { Track, PlayerDebugLevel } from "../types";

export interface CreateControllerGraphParams {
	playerId: string;
	bus: Bus;
	manager?: PlayerManager;
	options?: PlayerOptions;
	debugSink?: (...args: any[]) => void;
}

/**
 * Controllers shared by every player in the process. Created exactly once (lazily,
 * the first time a player is created, or eagerly by calling `ensureSharedControllers()`
 * from PlayerManager's constructor) and reused for every guild afterwards. Each
 * controller keeps its own per-player state internally, keyed by playerId, and is wired
 * up for a given player through its `attach(playerId, ...)` method.
 */
export interface SharedControllerGraph {
	readonly bus: Bus;
	readonly extensionController: ExtensionController;
	readonly pluginController: PluginController;
	readonly queueController: QueueController;
	readonly volumeController: VolumeController;
	readonly transitionController: TransitionController;
	readonly antiStuckController: AntiStuckController;
	readonly searchController: SearchController;
	readonly ttsController: TTSController;
	readonly saveController: SaveController;
	readonly filterController: FilterController;
	readonly streamController: StreamController;
	readonly lifecycleController: LifecycleController;
	readonly resourceRefreshController: ResourceRefreshController;
	readonly sessionController: PlaybackSessionController;
	readonly forwardController: ForwardController;
	readonly eventBridge: PlayerEventBridge;
	readonly connectionController: ConnectionController;
	readonly trackResolver: TrackResolver;
	readonly preloadManager: PreloadManager;
	readonly trackLoader: TrackLoader;
	readonly playbackController: PlaybackController;
	readonly preloadController: PreloadController;
	readonly orchestrator: PlaybackOrchestrator;
}

let sharedControllerGraph: SharedControllerGraph | null = null;
let globalRuntimeInstance: GlobalPlayerRuntime | null = null;

/** Creates the shared controller graph on first use (or returns the existing one).
 * PlayerManager calls this eagerly in its constructor so the controllers exist as soon
 * as the manager does, before any player is created. */
export function ensureSharedControllers(): SharedControllerGraph {
	if (sharedControllerGraph) return sharedControllerGraph;
	const bus = new Bus();
	// A few singletons depend on one another at construction time (TrackLoader needs the
	// PreloadManager it reuses buffered streams from; PreloadController needs both; the
	// PlaybackOrchestrator needs the PlaybackSessionController) — built as locals first so
	// they can be threaded through, then assigned into the graph below.
	const sessionController = new PlaybackSessionController(bus);
	const preloadManager = new PreloadManager(bus);
	const trackLoader = new TrackLoader(bus, preloadManager);
	sharedControllerGraph = {
		bus,
		extensionController: new ExtensionController(bus),
		pluginController: new PluginController(bus),
		queueController: new QueueController(bus),
		volumeController: new VolumeController(bus),
		transitionController: new TransitionController(bus),
		antiStuckController: new AntiStuckController(bus),
		searchController: new SearchController(bus),
		ttsController: new TTSController(bus),
		saveController: new SaveController(bus),
		filterController: new FilterController(bus),
		streamController: new StreamController(bus),
		lifecycleController: new LifecycleController(bus),
		resourceRefreshController: new ResourceRefreshController(bus),
		sessionController,
		forwardController: new ForwardController(bus),
		eventBridge: new PlayerEventBridge(bus),
		connectionController: new ConnectionController(bus),
		trackResolver: new TrackResolver(bus),
		preloadManager,
		trackLoader,
		playbackController: new PlaybackController(bus),
		preloadController: new PreloadController(bus, { loader: trackLoader, manager: preloadManager }),
		orchestrator: new PlaybackOrchestrator(bus, { sessionController }),
	};
	// runtime.ping / runtime.dispose are the only two RPCs owned directly by
	// GlobalPlayerRuntime itself; registered once here and routed to whichever
	// runtime instance is currently registered for that playerId.
	bus.registerRpc<{ playerId: string }, { playerId: string; timestamp: number }>("runtime.ping", ({ playerId: pingId }, ctx) => {
		if (pingId !== ctx.playerId || !globalRuntimeInstance?.has(ctx.playerId)) throw new Error(`Player id mismatch: ${pingId}`);
		return { playerId: ctx.playerId, timestamp: Date.now() };
	});
	bus.registerRpc<void, boolean>("runtime.dispose", async (_req, ctx) => {
		if (globalRuntimeInstance) await globalRuntimeInstance.detach(ctx.playerId);
		return true;
	});
	return sharedControllerGraph;
}

interface PlayerRuntimeSlice {
	readonly playerId: string;
	readonly controllers: PlayerRuntimeGraph;
	readonly disposables: Map<string, () => void | Promise<void>>;
	readonly errors: Array<{ name: string; error: unknown }>;
	globalRegistration?: GlobalControllerRegistration<unknown>;
	disposed: boolean;
}

/** Owner of per-player resources (voice connection, audio player, queue/playback
 * state slice, etc.) against the shared, process-wide controller graph and Bus. */
export class GlobalPlayerRuntime {
	readonly bus: Bus;
	private readonly slices = new Map<string, PlayerRuntimeSlice>();
	private disposed = false;
	private readonly errors: Array<{ name: string; error: unknown }> = [];

	public constructor(bus?: Bus);
	public constructor(
		playerId: string,
		options?: PlayerOptions,
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	);
	public constructor(
		busOrPlayerId?: Bus | string,
		options?: PlayerOptions,
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	) {
		const isLegacy = typeof busOrPlayerId === "string";
		const bus = isLegacy ? undefined : (busOrPlayerId as Bus | undefined);
		this.bus = bus ?? ensureSharedControllers().bus;
		globalRuntimeInstance = this;
		if (isLegacy && busOrPlayerId) {
			this.attach(busOrPlayerId, options ?? {}, manager, debugSink);
		}
	}

	public static create(
		playerId?: string,
		options: PlayerOptions = {},
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	): GlobalPlayerRuntime {
		const runtime = globalRuntimeInstance ?? new GlobalPlayerRuntime();
		if (playerId) {
			runtime.attach(playerId, options, manager, debugSink);
		}
		return runtime;
	}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public get disposalErrors(): ReadonlyArray<{ name: string; error: unknown }> {
		return this.errors;
	}

	public has(playerId: string): boolean {
		return this.slices.has(playerId);
	}

	public get controllers(): PlayerRuntimeGraph | undefined {
		return this.slices.values().next().value?.controllers;
	}

	public get playerId(): string {
		return this.slices.keys().next().value ?? "";
	}

	public getGraph(playerId: string): PlayerRuntimeGraph | undefined {
		return this.slices.get(playerId)?.controllers;
	}

	public attachPlayer(player: Player): void;
	public attachPlayer(playerId: string, player: Player): void;
	public attachPlayer(playerIdOrPlayer: string | Player, maybePlayer?: Player): void {
		const playerId = typeof playerIdOrPlayer === "string" ? playerIdOrPlayer : playerIdOrPlayer.playerId;
		const player = typeof playerIdOrPlayer === "string" ? maybePlayer! : playerIdOrPlayer;
		const slice = this.slices.get(playerId);
		slice?.controllers?.extensionManager?.attachPlayer(player);
		const shared = ensureSharedControllers();
		shared.eventBridge.attachPlayer(playerId, player);
	}

	public attach(
		playerId: string,
		options: PlayerOptions = {},
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	): PlayerRuntimeGraph {
		if (this.disposed) throw new Error("GlobalPlayerRuntime is disposed");
		if (this.slices.has(playerId)) {
			void this.detach(playerId);
		}
		return this.createControllerGraph({
			playerId,
			bus: this.bus,
			options,
			manager,
			debugSink,
		});
	}

	public initialize(params: {
		playerId: string;
		manager?: PlayerManager;
		options?: PlayerOptions;
		debugSink?: (...args: any[]) => void;
	}): PlayerRuntimeGraph {
		return this.attach(params.playerId, params.options, params.manager, params.debugSink);
	}

	public createControllerGraph(params: CreateControllerGraphParams): PlayerRuntimeGraph {
		if (this.disposed) throw new Error("GlobalPlayerRuntime is disposed");
		const { playerId, bus, manager, options = {}, debugSink } = params;
		const shared = ensureSharedControllers();
		const disposables = new Map<string, () => void | Promise<void>>();
		const errors: Array<{ name: string; error: unknown }> = [];
		let sliceDisposed = false;

		const monitorCleanup = (name: string, cleanup: () => void | Promise<void>) => {
			if (sliceDisposed) throw new Error(`Player ${playerId} runtime is disposed; cannot register ${name}`);
			disposables.set(name, cleanup);
		};

		const resolveDispose = (controller: unknown): (() => void | Promise<void>) | null => {
			if (!controller || typeof controller !== "object") return null;
			const value = controller as { dispose?: unknown; destroy?: unknown };
			if (typeof value.dispose === "function") return () => (value.dispose as () => void | Promise<void>)();
			if (typeof value.destroy === "function") return () => (value.destroy as () => void | Promise<void>)();
			return null;
		};

		const monitor = (name: string, controller: unknown) => {
			if (sliceDisposed) throw new Error(`Player ${playerId} runtime is disposed; cannot register ${name}`);
			const dispose = resolveDispose(controller);
			if (dispose) disposables.set(name, dispose);
		};

		const debugTracer = new PlayerEventDebug(bus, playerId, debugSink ?? (() => undefined), manager?.debugLevel ?? "info");
		const channel = (tag: string, level: PlayerDebugLevel = "debug") => debugTracer.channel(tag, level);
		const middleware: TrackMiddleware[] = [
			...(manager?.getTrackMiddlewareChain() ?? []),
			...(Array.isArray(options.trackMiddleware) ? options.trackMiddleware
			: options.trackMiddleware ? [options.trackMiddleware]
			: []),
		];
		const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		shared.connectionController.attach(playerId, {
			audioPlayer,
			options,
			debug: channel("ConnectionController"),
		});
		shared.lifecycleController.attach(playerId, options, channel("LifecycleController"));
		shared.forwardController.attach(playerId);
		const streamManager = new StreamManager({
			maxConcurrentStreams: options.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		streamManager.on("debug", channel("StreamManager"));
		const pluginManager = new PluginManager(null, manager ?? null, {
			extractorTimeout: options.extractorTimeout,
			debug: channel("Plugins"),
		});
		pluginManager.setStreamManager(streamManager);
		const extensionManager = new ExtensionManager(null as any, manager ?? (null as any), channel("Extensions"));
		shared.pluginController.attach(playerId, pluginManager);
		shared.extensionController.attach(playerId, extensionManager);
		shared.ttsController.attach(playerId, {
			pluginManager,
			extensionManager,
			audioPlayer,
			debug: channel("TTSController"),
			maxTimeTts: options.tts?.maxTimeTts,
			volume: options.tts?.volume ?? options.volume ?? 100,
		});
		shared.queueController.attach(playerId);
		shared.trackResolver.attach(playerId, {
			streamManager,
			pluginManager,
			extensionManager,
			isDestroyed: () => sliceDisposed,
		});
		shared.preloadManager.attach(playerId, {
			streamManager,
			debug: channel("Preload"),
			isDestroyed: () => sliceDisposed,
			isEnabled: () =>
				options.lowPerformance && options.preload?.autoDisableInLowPerformance ? false : (options.preload?.enabled ?? true),
		});
		shared.trackLoader.attach(playerId, {
			middleware,
			context: { playerId, manager } as any,
			resolvers: [(track, session) => bus.requestRpc(playerId, "stream.resolve", { track }, { signal: session.signal })],
			debug: channel("TrackLoader"),
		});
		shared.transitionController.attach(playerId, {
			enabled:
				options.lowPerformance && options.crossfade?.autoDisableInLowPerformance ?
					false
				:	(options.crossfade?.enabled ?? options.crossfade?.autoEnable ?? true),
			durationMs: options.crossfade?.durationMs,
			smartEnabled: options.smartTransition?.enabled ?? true,
			genreAware: options.smartTransition?.genreAware ?? true,
			beatAlign: options.smartTransition?.beatAlign ?? true,
			baseDurationMs: options.smartTransition?.baseDurationMs ?? options.crossfade?.durationMs,
			minDurationMs: options.smartTransition?.minDurationMs,
			maxDurationMs: options.smartTransition?.maxDurationMs,
			beatAlignMaxWaitMs: options.smartTransition?.beatAlignMaxWaitMs,
			genreDurations: options.smartTransition?.genreDurations,
		});
		shared.volumeController.attach(playerId, {
			initialVolume: options.volume ?? 100,
			loudness: options.loudnessNormalization,
		});
		shared.antiStuckController.attach(playerId, { ...options.antiStuck });
		shared.playbackController.attach(playerId, { audioPlayer, stuckTimeoutMs: options.antiStuck?.stuckTimeoutMs });
		shared.streamController.attach(playerId, streamManager);
		shared.saveController.attach(playerId, {
			middleware: [async (track) => shared.trackLoader.applyMiddleware(playerId, track)],
			middlewareContext: { playerId, manager } as any,
			resolveStream: (track) => pluginManager.getStream(track),
			resolveVideoStream: (track) => pluginManager.getVideo(track),
			debug: channel("SaveController"),
		});
		shared.preloadController.attach(playerId);
		shared.filterController.attach(playerId, undefined, channel("FilterController"), {
			initialFilters: Array.isArray(options.filters) ? options.filters : [],
			onFilterApplied: (filter) => bus.event(playerId, { type: "filterApplied", filter }),
			onFilterRemoved: (filter) => bus.event(playerId, { type: "filterRemoved", filter }),
			onFiltersCleared: () => bus.event(playerId, { type: "filtersCleared" }),
			onProcessingError: (error) => {
				void bus.requestRpc(playerId, "playback.reportFilterError", { error }).catch(() => undefined);
			},
		});
		shared.sessionController.attach(playerId);
		shared.orchestrator.attach(playerId, { debug: channel("PlaybackOrchestrator") });
		shared.resourceRefreshController.attach(playerId);
		shared.searchController.attach(playerId, {
			extensionManager,
			pluginManager,
			debug: channel("SearchController"),
		});
		shared.eventBridge.attach(playerId, debugTracer);
		const graph: PlayerRuntimeGraph = {
			connectionController: shared.connectionController,
			lifecycleController: shared.lifecycleController,
			forwardController: shared.forwardController,
			audioPlayer,
			streamManager,
			preloadManager: shared.preloadManager,
			trackResolver: shared.trackResolver,
			pluginManager,
			extensionManager,
			pluginController: shared.pluginController,
			extensionController: shared.extensionController,
			queueController: shared.queueController,
			trackLoader: shared.trackLoader,
			playbackController: shared.playbackController,
			streamController: shared.streamController,
			saveController: shared.saveController,
			filterController: shared.filterController,
			antiStuckController: shared.antiStuckController,
			transitionController: shared.transitionController,
			volumeController: shared.volumeController,
			preloadController: shared.preloadController,
			resourceRefreshController: shared.resourceRefreshController,
			orchestrator: shared.orchestrator,
			sessionController: shared.sessionController,
			ttsController: shared.ttsController,
			debugTracer,
			searchController: shared.searchController,
		};

		monitorCleanup("sharedControllers", async () => {
			shared.orchestrator.detach(playerId);
			shared.preloadController.detach(playerId);
			shared.playbackController.detach(playerId);
			shared.trackLoader.detach(playerId);
			shared.trackResolver.detach(playerId);
			shared.preloadManager.detach(playerId);
			await shared.connectionController.detach(playerId);
			shared.lifecycleController.detach(playerId);
			shared.forwardController.detach(playerId);
			shared.pluginController.detach(playerId);
			shared.extensionController.detach(playerId);
			shared.ttsController.detach(playerId);
			shared.queueController.detach(playerId);
			shared.transitionController.detach(playerId);
			shared.volumeController.detach(playerId);
			shared.antiStuckController.detach(playerId);
			shared.streamController.detach(playerId);
			shared.saveController.detach(playerId);
			shared.filterController.detach(playerId);
			shared.resourceRefreshController.detach(playerId);
			shared.searchController.detach(playerId);
			shared.sessionController.detach(playerId);
			shared.eventBridge.detach(playerId);
		});

		const globalRegistration = globalControllerRegistry.register(playerId, bus, graph, () => this.detach(playerId));

		const lifecycleOrder: Array<keyof PlayerRuntimeGraph> = ["streamManager", "pluginManager", "extensionManager", "debugTracer"];
		for (const name of lifecycleOrder) monitor(name, graph[name]);

		const slice: PlayerRuntimeSlice = {
			playerId,
			controllers: graph,
			disposables,
			errors,
			globalRegistration,
			disposed: false,
		};
		this.slices.set(playerId, slice);
		return graph;
	}

	public async detach(playerId: string): Promise<void> {
		const slice = this.slices.get(playerId);
		if (!slice || slice.disposed) return;
		slice.disposed = true;
		this.slices.delete(playerId);
		slice.globalRegistration?.unregister();
		slice.globalRegistration = undefined;
		for (const [name, cleanup] of [...slice.disposables.entries()].reverse()) {
			try {
				const result = cleanup();
				if (result && typeof (result as Promise<void>).then === "function") {
					await result;
				}
			} catch (error) {
				slice.errors.push({ name, error });
				this.errors.push({ name, error });
			}
		}
		slice.disposables.clear();
		this.bus.disposePlayer(playerId);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const playerId of [...this.slices.keys()]) {
			await this.detach(playerId);
		}
	}

	public hasTTSPlayer(playerId?: string): boolean {
		const id = playerId ?? this.playerId;
		return this.bus.querySync(id, "tts.hasPlayer") ?? false;
	}
	public getAudioPlayer(playerId?: string): AudioPlayer | null {
		const id = playerId ?? this.playerId;
		return this.bus.querySync(id, "audioPlayer") ?? null;
	}
	public setCurrentTrack(track: Track | null, playerId?: string): void {
		const id = playerId ?? this.playerId;
		this.bus.requestRpcSync(id, "queue.setCurrent", { track });
	}
	public getQueueSnapshot(playerId?: string): Track[] {
		const id = playerId ?? this.playerId;
		return this.bus.querySync(id, "queue") ?? [];
	}
	public serializeQueue(playerId?: string): object | undefined {
		const id = playerId ?? this.playerId;
		return this.bus.requestRpcSync(id, "queue.serialize", undefined);
	}
	public restoreQueue(state: object, playerId?: string): void {
		const id = playerId ?? this.playerId;
		this.bus.requestRpcSync(id, "queue.restore", { state });
	}
	public getStreamManagerStats(playerId?: string): ReturnType<StreamManager["getStats"]> | undefined {
		const id = playerId ?? this.playerId;
		return this.bus.querySync(id, "stream.stats") ?? undefined;
	}
}

