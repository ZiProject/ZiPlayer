import type { AudioPlayer, PlayerSubscription } from "@discordjs/voice";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware, StreamInfo, PlayerInput } from "../types";
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
import { SearchController } from "../controller/SearchController";
import { PlayerEventDebug } from "../controller/PlayerEventDebug";
import { Queue } from "./Queue";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { SaveController } from "../controller/SaveController";
import type { Readable } from "stream";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { SaveOptions, SaveVideoOptions, Track } from "../types";

export interface PlayerRuntimeGraph {
	connectionController: ConnectionController;
	lifecycleController: LifecycleController;
	forwardController: ForwardController;
	queue: Queue;
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
	orchestrator: PlaybackOrchestrator;
	ttsController: TTSController;
	debugTracer: PlayerEventDebug;
	searchController: SearchController;
	eventBridge: PlayerEventBridge;
}

/** Composition root and lifecycle owner. It contains no playback workflow. */
export class PlayerRuntimeController {
	private disposed = false;
	private queue: Queue | null = null;
	private streamManager: StreamManager | null = null;
	private ttsController: TTSController | null = null;
	private audioPlayer: AudioPlayer | null = null;
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
			...(Array.isArray(options.trackMiddleware) ? options.trackMiddleware
			: options.trackMiddleware ? [options.trackMiddleware]
			: []),
		];
		const connectionController = new ConnectionController({ guildId, bus: this.bus, options, debug });
		const lifecycleController = new LifecycleController({ bus: this.bus, options, debug });
		const forwardController = new ForwardController(player, { bus: this.bus, debug });
		const queue = new Queue();
		this.queue = queue;
		const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.audioPlayer = audioPlayer;
		const streamManager = new StreamManager({
			maxConcurrentStreams: options.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		this.streamManager = streamManager;
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
		});
		this.ttsController = ttsController;
		const queueController = new QueueController({ queue, bus: this.bus });
		const resolver = new TrackResolver({ streamManager, pluginManager, extensionManager });
		const preloadManager = new PreloadManager({
			streamManager,
			debug,
			getNextTrack: () => (queue.loop() === "track" ? queue.currentTrack : queue.nextTrack),
			getStream: (track) => resolver.resolve(track, () => player.destroyed),
			removeTrackFromQueue: (track) => {
				const next = queue.nextTrack;
				return (
						next === track ||
							(next?.id !== undefined && track.id !== undefined && next.id === track.id) ||
							(next?.url !== undefined && track.url !== undefined && next.url === track.url)
					) ?
						queue.remove(0) !== null
					:	false;
			},
			isDestroyed: () => player.destroyed,
			isEnabled: () =>
				!(options.lowPerformance && options.preload?.autoDisableInLowPerformance) && (options.preload?.enabled ?? true),
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
			bus: this.bus,
		});
		const volumeController = new VolumeController(this.bus, {
			initialVolume: options.volume ?? 100,
			loudness: options.loudnessNormalization,
		});
		const detachVolumeSetRpc = this.bus.registerRpc<{ value: number }, number>("volume.set", ({ value }) =>
			volumeController.setVolume(value),
		);
		this.monitorCleanup("volume.set.rpc", detachVolumeSetRpc);

		const detachAvailablePluginsQuery = this.bus.registerQuery("availablePlugins", () => pluginManager.getAll());
		this.monitorCleanup("availablePlugins.query", detachAvailablePluginsQuery);
		const playbackController = new PlaybackController({ audioPlayer, bus: this.bus, volumeController, transitionController });
		const streamController = new StreamController({ streamManager, bus: this.bus });
		const saveController = new SaveController({
			middleware: [async (track) => trackLoader.applyMiddleware(track)],
			middlewareContext: { player, manager },
			resolveStream: (track) => pluginManager.getStream(track),
			resolveVideoStream: (track) => pluginManager.getVideo(track),
			debug,
		});
		this.monitorCleanup(
			"plugin.add.rpc",
			this.bus.registerRpc<{ plugin: BasePlugin }, void>("plugin.add", ({ plugin }) => pluginManager.register(plugin)),
		);
		this.monitorCleanup(
			"plugin.remove.rpc",
			this.bus.registerRpc<{ name: string }, boolean>("plugin.remove", ({ name }) => pluginManager.unregister(name)),
		);
		this.monitorCleanup(
			"extension.add.rpc",
			this.bus.registerRpc<{ extension: BaseExtension }, void>("extension.add", ({ extension }) =>
				extensionManager.register(extension),
			),
		);
		this.monitorCleanup(
			"extension.remove.rpc",
			this.bus.registerRpc<{ extension: BaseExtension }, boolean>("extension.remove", ({ extension }) =>
				extensionManager.unregister(extension),
			),
		);
		this.monitorCleanup(
			"extensions.query",
			this.bus.registerQuery("extensions", () => extensionManager.getAll()),
		);
		this.monitorCleanup(
			"save.rpc",
			this.bus.registerRpc<{ track: Track; options?: SaveOptions | string }, Readable>("save", ({ track, options }) =>
				saveController.save(track, options),
			),
		);
		this.monitorCleanup(
			"save.video.rpc",
			this.bus.registerRpc<{ track: Track; options?: SaveVideoOptions | string }, Readable>("save.video", ({ track, options }) =>
				saveController.saveVideo(track, options),
			),
		);
		this.monitorCleanup(
			"track.middleware.rpc",
			this.bus.registerRpc<{ track: Track }, Track>("track.middleware", ({ track }) => trackLoader.applyMiddleware(track)),
		);
		this.monitorCleanup(
			"stream.resolve.rpc",
			this.bus.registerRpc<{ track: Track }, StreamInfo | null>("stream.resolve", ({ track }) =>
				resolver.resolve(track, () => player.destroyed),
			),
		);
		const antiStuckController = new AntiStuckController({ ...options.antiStuck, bus: this.bus });
		const preloadController = new PreloadController({ loader: trackLoader, manager: preloadManager, bus: this.bus });
		const filterController = new FilterController(undefined, debug, this.bus, {
			onFilterApplied: (filter) => this.bus.event({ type: "filterApplied", filter }),
			onFilterRemoved: (filter) => this.bus.event({ type: "filterRemoved", filter }),
			onFiltersCleared: () => this.bus.event({ type: "filtersCleared" }),
		});
		const onStreamError = ({ error }: { error: Error }) =>
			this.bus.event({ type: "streamError", error, track: player.currentTrack });
		streamManager.on("streamError", onStreamError);
		this.monitorCleanup("stream.errors", () => {
			streamManager.off("streamError", onStreamError);
		});
		const orchestrator = new PlaybackOrchestrator(this.bus, {
			player,
			trackLoader,
			streamController,
			filterController,
			playbackController,
			queueController,
			transitionController,
			preloadController,
			ttsController,
			relatedTrackResolver: (track) => pluginManager.getRelatedTracks(track),
		});
		const searchController = new SearchController({ extensionManager, pluginManager, debug, bus: this.bus });
		const debugTracer = new PlayerEventDebug(this.bus, guildId, debug, manager.debugLevel ?? "info");
		const eventBridge = new PlayerEventBridge(player, manager, this.bus, debugTracer);
		this.attachPlayerWiring(player, audioPlayer, ttsController, filterController, options, debug, guildId);
		const graph: PlayerRuntimeGraph = {
			connectionController,
			lifecycleController,
			forwardController,
			queue,
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
		return !!this.ttsController?.ttsPlayer;
	}
	public getAudioPlayer(): AudioPlayer | null {
		return this.audioPlayer;
	}
	public setCurrentTrack(track: Track | null): void {
		this.queue?.setCurrentTrack(track);
	}
	public getQueueSnapshot(): Track[] {
		return this.bus.querySync("queue");
	}
	public serializeQueue(): object | undefined {
		return this.queue?.toJSON();
	}
	public restoreQueue(state: Parameters<Queue["fromJSON"]>[0]): void {
		this.queue?.fromJSON(state);
	}
	public getStreamManagerStats(): ReturnType<StreamManager["getStats"]> | undefined {
		return this.streamManager?.getStats();
	}
	private attachPlayerWiring(
		player: Player,
		audioPlayer: AudioPlayer,
		ttsController: TTSController,
		filterController: FilterController,
		options: PlayerOptions,
		debug: (...args: any[]) => void,
		guildId: string,
	): void {
		let audioPlayerSubscription: PlayerSubscription | null = null;
		const detachConnected = this.bus.onOutput("[Connection]->[Player]:connected", (event) => {
			if (player.connection === event.connection) return;
			audioPlayerSubscription?.unsubscribe();
			audioPlayerSubscription = event.connection.subscribe(audioPlayer) ?? null;
			ttsController.setConnection(event.connection);
			player.connection = event.connection;
			debug(`[Player] AudioPlayer subscribed guild=${guildId} session=${event.sessionId}`);
		});
		const detachDisconnected = this.bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			audioPlayerSubscription?.unsubscribe();
			audioPlayerSubscription = null;
			ttsController.setConnection(null);
			player.connection = null;
			debug(`[Player] AudioPlayer unsubscribed guild=${guildId} reason=${event.reason ?? "unknown"}`);
		});
		const detachResourceRefresh = this.bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.handleResourceRefresh(event);
		});
		this.monitorCleanup("player.wiring", () => {
			detachConnected();
			detachDisconnected();
			detachResourceRefresh();
			audioPlayerSubscription?.unsubscribe();
			audioPlayerSubscription = null;
			player.connection = null;
		});
		if (Array.isArray(options.filters) && options.filters.length > 0)
			void filterController
				.applyFilters(options.filters)
				.catch((error) => debug("[FilterController] Initial filter error:", error));
	}

	private async handleResourceRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		try {
			const session = await this.bus.requestRpc("playback.refreshResource", { position: event.position ?? 0 });
			this.bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, session });
		} catch (error) {
			this.bus.emitOutput({
				type: "[Resource]->[Player]:error",
				requestId: event.requestId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
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
		this.ttsController = null;
		this.streamManager = null;
		this.queue = null;
		this.audioPlayer = null;
	}
	private resolveDispose(controller: unknown): (() => void | Promise<void>) | null {
		if (!controller || typeof controller !== "object") return null;
		const value = controller as { dispose?: unknown; destroy?: unknown };
		if (typeof value.dispose === "function") return () => (value.dispose as () => void | Promise<void>)();
		if (typeof value.destroy === "function") return () => (value.destroy as () => void | Promise<void>)();
		return null;
	}
}
