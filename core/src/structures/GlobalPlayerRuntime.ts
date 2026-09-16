import type { AudioPlayer } from "@discordjs/voice";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware, PlayerRuntimeGraph } from "../types";
import type { PlayerManager } from "./PlayerManager";
import type { Player } from "./Player";
import { PlayerBus } from "./PlayerBus";
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
import { PlayerConnectionBridge } from "../controller/PlayerConnectionBridge";
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
	bus: PlayerBus;
	manager?: PlayerManager;
	options?: PlayerOptions;
	debugSink?: (...args: any[]) => void;
}

/** Global owner of one guild/player controller graph and its PlayerBus. */
export class GlobalPlayerRuntime {
	readonly bus: PlayerBus;
	controllers!: PlayerRuntimeGraph;
	readonly playerId: string;
	private disposed = false;
	private readonly disposables = new Map<string, () => void | Promise<void>>();
	private readonly errors: Array<{ name: string; error: unknown }> = [];
	private globalRegistration?: GlobalControllerRegistration<unknown>;

	public constructor(
		playerId: string,
		options: PlayerOptions = {},
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	) {
		this.playerId = playerId;
		this.bus = new PlayerBus();
		this.controllers = this.createControllerGraph({
			playerId: this.playerId,
			bus: this.bus,
			options,
			manager,
			debugSink,
		});
	}

	public static create(
		playerId: string,
		options: PlayerOptions = {},
		manager?: PlayerManager,
		debugSink?: (...args: any[]) => void,
	): GlobalPlayerRuntime {
		return new GlobalPlayerRuntime(playerId, options, manager, debugSink);
	}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public get disposalErrors(): ReadonlyArray<{ name: string; error: unknown }> {
		return this.errors;
	}

	public attachPlayer(player: Player): void {
		this.controllers?.extensionManager?.attachPlayer(player);
		this.controllers?.playerConnectionBridge?.attachPlayer(player);
		this.controllers?.eventBridge?.attachPlayer(player);
	}

	public initialize(params: {
		playerId: string;
		manager?: PlayerManager;
		options?: PlayerOptions;
		debugSink?: (...args: any[]) => void;
	}): PlayerRuntimeGraph {
		if (this.disposed) throw new Error("GlobalPlayerRuntime is disposed");
		this.controllers = this.createControllerGraph({
			playerId: params.playerId,
			bus: this.bus,
			manager: params.manager,
			options: params.options ?? {},
			debugSink: params.debugSink,
		});
		return this.controllers;
	}

	public createControllerGraph(params: CreateControllerGraphParams): PlayerRuntimeGraph {
		if (this.disposed) throw new Error("GlobalPlayerRuntime is disposed");
		const { playerId, bus, manager, options = {}, debugSink } = params;
		const debugTracer = new PlayerEventDebug(bus, playerId, debugSink ?? (() => undefined), manager?.debugLevel ?? "info");
		const channel = (tag: string, level: PlayerDebugLevel = "debug") => debugTracer.channel(tag, level);
		const middleware: TrackMiddleware[] = [
			...(manager?.getTrackMiddlewareChain() ?? []),
			...(Array.isArray(options.trackMiddleware) ? options.trackMiddleware
			: options.trackMiddleware ? [options.trackMiddleware]
			: []),
		];
		const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		const connectionController = new ConnectionController({
			guildId: playerId,
			bus,
			audioPlayer,
			options,
			debug: channel("ConnectionController"),
		});
		const lifecycleController = new LifecycleController({ bus, options, debug: channel("LifecycleController") });
		const forwardController = new ForwardController({ playerId, bus, debug: channel("ForwardController") });
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
		const pluginController = new PluginController({ pluginManager, bus });
		const extensionController = new ExtensionController({ extensionManager, bus });
		const ttsController = new TTSController({
			pluginManager,
			extensionManager,
			audioPlayer,
			debug: channel("TTSController"),
			maxTimeTts: options.tts?.maxTimeTts,
			volume: options.tts?.volume ?? options.volume ?? 100,
			bus,
		});
		const queueController = new QueueController({ bus });
		const resolver = new TrackResolver({
			streamManager,
			pluginManager,
			extensionManager,
			bus,
			isDestroyed: () => this.disposed,
		});
		const preloadManager = new PreloadManager({
			streamManager,
			debug: channel("PreloadManager"),
			bus,
			isDestroyed: () => this.disposed,
			isEnabled: () =>
				!(options.lowPerformance && options.preload?.autoDisableInLowPerformance) && (options.preload?.enabled ?? true),
		});
		const trackLoader = new TrackLoader({
			middleware,
			context: { playerId, manager } as any,
			resolvers: [(track) => resolver.resolve(track, () => this.disposed)],
			recovery: options.antiStuck,
			preloadManager,
			qualityController: {
				get: () => options.quality,
				set: (quality) => {
					options.quality = quality;
				},
			},
			debug: channel("TrackLoader"),
			bus,
		});
		const transitionController = new TransitionController({
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
			bus,
		});
		const volumeController = new VolumeController(bus, {
			initialVolume: options.volume ?? 100,
			loudness: options.loudnessNormalization,
		});
		const antiStuckController = new AntiStuckController({ ...options.antiStuck, bus });
		const playbackController = new PlaybackController({
			audioPlayer,
			bus,
			stuckTimeoutMs: options.antiStuck?.stuckTimeoutMs,
		});
		const streamController = new StreamController({ streamManager, bus });
		const saveController = new SaveController({
			middleware: [async (track) => trackLoader.applyMiddleware(track)],
			middlewareContext: { playerId, manager } as any,
			resolveStream: (track) => pluginManager.getStream(track),
			resolveVideoStream: (track) => pluginManager.getVideo(track),
			debug: channel("SaveController"),
			bus,
		});
		const preloadController = new PreloadController({ loader: trackLoader, manager: preloadManager, bus });
		const filterController = new FilterController(undefined, channel("FilterController"), bus, {
			initialFilters: Array.isArray(options.filters) ? options.filters : [],
			onFilterApplied: (filter) => bus.event({ type: "filterApplied", filter }),
			onFilterRemoved: (filter) => bus.event({ type: "filterRemoved", filter }),
			onFiltersCleared: () => bus.event({ type: "filtersCleared" }),
			onProcessingError: (error) => {
				void bus.requestRpc("playback.reportFilterError", { error }).catch(() => undefined);
			},
		});
		const playerConnectionBridge = new PlayerConnectionBridge({
			bus,
			debug: channel("PlayerConnectionBridge"),
			guildId: playerId,
		});
		const sessionController = new PlaybackSessionController(bus);
		const orchestrator = new PlaybackOrchestrator(bus, { debug: channel("PlaybackOrchestrator"), sessionController });
		const resourceRefreshController = new ResourceRefreshController({ bus });
		const searchController = new SearchController({
			extensionManager,
			pluginManager,
			debug: channel("SearchController"),
			bus,
		});
		const eventBridge = new PlayerEventBridge(null, manager, bus, debugTracer);
		const graph: PlayerRuntimeGraph = {
			connectionController,
			lifecycleController,
			forwardController,
			audioPlayer,
			streamManager,
			preloadManager,
			trackResolver: resolver,
			pluginManager,
			extensionManager,
			pluginController,
			extensionController,
			queueController,
			trackLoader,
			playbackController,
			streamController,
			saveController,
			filterController,
			antiStuckController,
			transitionController,
			volumeController,
			preloadController,
			resourceRefreshController,
			playerConnectionBridge,
			orchestrator,
			sessionController,
			ttsController,
			debugTracer,
			searchController,
			eventBridge,
		};

		this.monitorCleanup(
			"globalControllerPing",
			bus.registerRpc("runtime.ping", ({ playerId: pingId }: { playerId: string }) => {
				if (pingId !== playerId) throw new Error(`Player id mismatch: ${pingId}`);
				return { playerId, timestamp: Date.now() };
			}),
		);
		this.monitorCleanup(
			"runtimeDispose",
			bus.registerRpc("runtime.dispose", () => {
				void this.dispose();
				return true;
			}),
		);

		this.globalRegistration = globalControllerRegistry.register(playerId, bus, graph, () => this.dispose());
		const lifecycleOrder: Array<keyof PlayerRuntimeGraph> = [
			"connectionController",
			"lifecycleController",
			"forwardController",
			"streamManager",
			"preloadManager",
			"trackResolver",
			"pluginManager",
			"extensionManager",
			"pluginController",
			"extensionController",
			"queueController",
			"trackLoader",
			"playbackController",
			"streamController",
			"saveController",
			"filterController",
			"antiStuckController",
			"transitionController",
			"volumeController",
			"preloadController",
			"playerConnectionBridge",
			"sessionController",
			"orchestrator",
			"resourceRefreshController",
			"ttsController",
			"debugTracer",
			"searchController",
			"eventBridge",
		];
		for (const name of lifecycleOrder) this.monitor(name, graph[name]);
		return graph;
	}

	public hasTTSPlayer(): boolean {
		return this.bus.querySync("tts.hasPlayer") ?? false;
	}
	public getAudioPlayer(): AudioPlayer | null {
		return this.bus.querySync("audioPlayer") ?? null;
	}
	public setCurrentTrack(track: Track | null): void {
		this.bus.requestRpcSync("queue.setCurrent", { track });
	}
	public getQueueSnapshot(): Track[] {
		return this.bus.querySync("queue") ?? [];
	}
	public serializeQueue(): object | undefined {
		return this.bus.requestRpcSync("queue.serialize", undefined);
	}
	public restoreQueue(state: object): void {
		this.bus.requestRpcSync("queue.restore", { state });
	}
	public getStreamManagerStats(): ReturnType<StreamManager["getStats"]> | undefined {
		return this.bus.querySync("stream.stats") ?? undefined;
	}
	public monitor(name: string, controller: unknown): void {
		if (this.disposed) throw new Error(`GlobalPlayerRuntime is disposed; cannot register ${name}`);
		const dispose = this.resolveDispose(controller);
		if (dispose) this.disposables.set(name, dispose);
	}
	public monitorCleanup(name: string, cleanup: () => void | Promise<void>): void {
		if (this.disposed) throw new Error(`GlobalPlayerRuntime is disposed; cannot register ${name}`);
		this.disposables.set(name, cleanup);
	}
	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.errors.length = 0;
		this.globalRegistration?.unregister();
		this.globalRegistration = undefined;
		for (const [name, cleanup] of [...this.disposables.entries()].reverse()) {
			try {
				const result = cleanup();
				if (result && typeof (result as Promise<void>).then === "function") {
					await result;
				}
			} catch (error) {
				this.errors.push({ name, error });
			}
		}
		this.disposables.clear();
		this.bus.dispose();
	}
	private resolveDispose(controller: unknown): (() => void | Promise<void>) | null {
		if (!controller || typeof controller !== "object") return null;
		const value = controller as { dispose?: unknown; destroy?: unknown };
		if (typeof value.dispose === "function") return () => (value.dispose as () => void | Promise<void>)();
		if (typeof value.destroy === "function") return () => (value.destroy as () => void | Promise<void>)();
		return null;
	}
}
