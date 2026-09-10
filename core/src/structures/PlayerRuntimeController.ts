import type { AudioPlayer } from "@discordjs/voice";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware } from "../types";
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
import { SearchController } from "../controller/SearchController";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { SaveController } from "../controller/SaveController";
import type { Track } from "../types";

export interface PlayerRuntimeGraph {
	connectionController: ConnectionController;
	lifecycleController: LifecycleController;
	forwardController: ForwardController;
	audioPlayer: AudioPlayer;
	streamManager: StreamManager;
	preloadManager: PreloadManager;
	pluginManager: PluginManager;
	extensionManager: ExtensionManager;
	queueController: QueueController;
	trackLoader: TrackLoader;
	playbackController: PlaybackController;
	streamController: StreamController;
	saveController: SaveController;
	filterController: FilterController;
	antiStuckController: AntiStuckController;
	transitionController: TransitionController;
	volumeController: VolumeController;
	preloadController: PreloadController;
	resourceRefreshController: ResourceRefreshController;
	orchestrator: PlaybackOrchestrator;
	ttsController: TTSController;
	debugTracer: PlayerEventDebug;
	searchController: SearchController;
	eventBridge: PlayerEventBridge;
}

/** Composition root and lifecycle owner. It contains no playback workflow. */
export class PlayerRuntimeController {
	private disposed = false;
	private readonly disposables = new Map<string, () => void | Promise<void>>();
	private readonly errors: Array<{ name: string; error: unknown }> = [];

	public constructor(public readonly bus: PlayerBus) {}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public get disposalErrors(): ReadonlyArray<{ name: string; error: unknown }> {
		return this.errors;
	}

	public initialize(
		player: Player,
		manager: PlayerManager,
		options: PlayerOptions,
		debug: (...args: any[]) => void,
	): PlayerRuntimeGraph {
		if (this.disposed) throw new Error("PlayerRuntimeController is disposed");

		const guildId = player.guildId;
		const middleware: TrackMiddleware[] = [
			...manager.getTrackMiddlewareChain(),
			...(Array.isArray(options.trackMiddleware)
				? options.trackMiddleware
				: options.trackMiddleware
					? [options.trackMiddleware]
					: []),
		];

		const audioPlayer = createAudioPlayer({
			behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 },
		});
		const connectionController = new ConnectionController({ guildId, bus: this.bus, audioPlayer, options, debug });
		const lifecycleController = new LifecycleController({ bus: this.bus, options, debug });
		const forwardController = new ForwardController(player, { bus: this.bus, debug });
		const streamManager = new StreamManager({
			maxConcurrentStreams: options.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		const pluginManager = new PluginManager(player, manager, { extractorTimeout: options.extractorTimeout });
		pluginManager.setStreamManager(streamManager);
		const extensionManager = new ExtensionManager(player, manager);
		const ttsController = new TTSController({
			pluginManager,
			extensionManager,
			audioPlayer,
			debug,
			maxTimeTts: options.tts?.maxTimeTts,
			volume: options.tts?.volume ?? options.volume ?? 100,
			onStart: (track) => player.emit("ttsStart", { track }),
			onEnd: () => player.emit("ttsEnd"),
			bus: this.bus,
		});

		const queueController = new QueueController({ bus: this.bus });
		const resolver = new TrackResolver({ streamManager, pluginManager, extensionManager });
		const preloadManager = new PreloadManager({
			streamManager,
			debug,
			getNextTrack: () => (queueController.loop() === "track" ? queueController.currentTrack : queueController.nextTrack),
			getStream: (track) => resolver.resolve(track, () => player.destroyed),
			removeTrackFromQueue: (track) => {
				const next = queueController.nextTrack;
				const same =
					next === track ||
					(next?.id !== undefined && track.id !== undefined && next.id === track.id) ||
					(next?.url !== undefined && track.url !== undefined && next.url === track.url);
				return same ? queueController.remove(0) !== null : false;
			},
			isDestroyed: () => player.destroyed,
			isEnabled: () =>
				!(options.lowPerformance && options.preload?.autoDisableInLowPerformance) &&
				(options.preload?.enabled ?? true),
		});
		const trackLoader = new TrackLoader({
			middleware,
			context: { player, manager },
			resolvers: [(track) => resolver.resolve(track, () => player.destroyed)],
			recovery: options.antiStuck,
			preloadManager,
			qualityController: {
				get: () => options.quality,
				set: (quality) => {
					options.quality = quality;
				},
			},
			debug,
			bus: this.bus,
		});
		const transitionController = new TransitionController({
			enabled:
				options.lowPerformance && options.crossfade?.autoDisableInLowPerformance
					? false
					: (options.crossfade?.enabled ?? options.crossfade?.autoEnable ?? true),
			durationMs: options.crossfade?.durationMs,
			smartEnabled: options.smartTransition?.enabled ?? true,
			genreAware: options.smartTransition?.genreAware ?? true,
			beatAlign: options.smartTransition?.beatAlign ?? true,
			baseDurationMs: options.smartTransition?.baseDurationMs ?? options.crossfade?.durationMs,
			minDurationMs: options.smartTransition?.minDurationMs,
			maxDurationMs: options.smartTransition?.maxDurationMs,
			beatAlignMaxWaitMs: options.smartTransition?.beatAlignMaxWaitMs,
			genreDurations: options.smartTransition?.genreDurations,
			bus: this.bus,
		});
		const volumeController = new VolumeController(this.bus, {
			initialVolume: options.volume ?? 100,
			loudness: options.loudnessNormalization,
		});
		const antiStuckController = new AntiStuckController({ ...options.antiStuck, bus: this.bus });
		const playbackController = new PlaybackController({
			audioPlayer,
			bus: this.bus,
			stuckTimeoutMs: options.antiStuck?.stuckTimeoutMs,
		});
		const streamController = new StreamController({ streamManager, bus: this.bus });
		const saveController = new SaveController({
			middleware: [async (track) => trackLoader.applyMiddleware(track)],
			middlewareContext: { player, manager },
			resolveStream: (track) => pluginManager.getStream(track),
			resolveVideoStream: (track) => pluginManager.getVideo(track),
			debug,
			bus: this.bus,
		});
		const preloadController = new PreloadController({ loader: trackLoader, manager: preloadManager, bus: this.bus });
		const filterController = new FilterController(undefined, debug, this.bus, {
			initialFilters: Array.isArray(options.filters) ? options.filters : [],
			onFilterApplied: (filter) => this.bus.event({ type: "filterApplied", filter }),
			onFilterRemoved: (filter) => this.bus.event({ type: "filterRemoved", filter }),
			onFiltersCleared: () => this.bus.event({ type: "filtersCleared" }),
			onProcessingError: (error) => playbackController.reportFilterError(error),
		});
		const resourceRefreshController = new ResourceRefreshController({ bus: this.bus });
		const orchestrator = new PlaybackOrchestrator(this.bus, {
			debug,
			relatedTrackResolver: (track, ctx) =>
				pluginManager.getRelatedTracks(track, ctx ?? { history: player.previousTracks }),
		});
		const searchController = new SearchController({ extensionManager, pluginManager, debug, bus: this.bus });
		const debugTracer = new PlayerEventDebug(this.bus, guildId, debug, manager.debugLevel ?? "info");
		const eventBridge = new PlayerEventBridge(player, manager, this.bus, debugTracer);

		const graph: PlayerRuntimeGraph = {
			connectionController,
			lifecycleController,
			forwardController,
			audioPlayer,
			streamManager,
			preloadManager,
			pluginManager,
			extensionManager,
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
			orchestrator,
			ttsController,
			debugTracer,
			searchController,
			eventBridge,
		};

		for (const [name, controller] of Object.entries(graph)) this.monitor(name, controller);
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
		if (this.disposed) throw new Error(`PlayerRuntimeController is disposed; cannot register ${name}`);
		const dispose = this.resolveDispose(controller);
		if (dispose) this.disposables.set(name, dispose);
	}

	public monitorCleanup(name: string, cleanup: () => void | Promise<void>): void {
		if (this.disposed) throw new Error(`PlayerRuntimeController is disposed; cannot register ${name}`);
		this.disposables.set(name, cleanup);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.errors.length = 0;
		for (const [name, cleanup] of [...this.disposables.entries()].reverse()) {
			try {
				await cleanup();
			} catch (error) {
				this.errors.push({ name, error });
			}
		}
		this.disposables.clear();
	}

	private resolveDispose(controller: unknown): (() => void | Promise<void>) | null {
		if (!controller || typeof controller !== "object") return null;
		const value = controller as { dispose?: unknown; destroy?: unknown };
		if (typeof value.dispose === "function") return () => (value.dispose as () => void | Promise<void>)();
		if (typeof value.destroy === "function") return () => (value.destroy as () => void | Promise<void>)();
		return null;
	}
}
