import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { AudioPlayer, PlayerSubscription } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware, StreamInfo, Track } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import { PlayerBus, createPlayerRequestId, type PlayerInput } from "../structures/PlayerBus";
import { PlayerAction } from "../structures/PlayerAction";
import { PlaybackOrchestrator } from "../structures/PlaybackOrchestrator";
import { TrackLoader } from "../structures/TrackLoader";
import { TrackResolver } from "../structures/TrackResolver";
import { PlaybackController } from "./PlaybackController";
import { StreamController } from "./StreamController";
import { FilterController } from "./FilterController";
import { QueueController } from "./QueueController";
import { AntiStuckController } from "./AntiStuckController";
import { TransitionController } from "./TransitionController";
import { VolumeController } from "./VolumeController";
import { PreloadController } from "./PreloadController";
import { ConnectionController } from "./ConnectionController";
import { LifecycleController } from "./LifecycleController";
import { ForwardController } from "./ForwardController";
import { TTSController } from "./TTSController";
import { Queue } from "../structures/Queue";
import { StreamManager } from "../structures/StreamManager";
import { PreloadManager } from "../structures/PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import type { Player } from "../structures/Player";
export interface PlayerRuntimeControllerOptions {
	player: Player;
	manager: PlayerManager;
	options: PlayerOptions;
	debug: (...args: any[]) => void;
}
export class PlayerRuntimeController {
	public readonly bus = new PlayerBus();
	public readonly actionExecutor = new PlayerAction(this.bus);
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
	private disposed = false;
	private readonly player: Player;
	private readonly detachResourceRefresh: () => void;
	private readonly detachConnectionSubscription: () => void;
	private audioPlayerSubscription: PlayerSubscription | null = null;
	public constructor(o: PlayerRuntimeControllerOptions) {
		const { player, manager, options } = o;
		const middleware: TrackMiddleware[] = [
			...manager.getTrackMiddlewareChain(),
			...(Array.isArray(options.trackMiddleware) ? options.trackMiddleware
			: options.trackMiddleware ? [options.trackMiddleware]
			: []),
		];
		this.player = player;
		this.connectionController = new ConnectionController({ guildId: player.guildId, bus: this.bus, options, debug: o.debug });
		this.lifecycleController = new LifecycleController({ bus: this.bus, options, debug: o.debug });
		this.forwardController = new ForwardController(player, { debug: o.debug });
		this.queue = new Queue();
		this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.streamManager = new StreamManager({
			maxConcurrentStreams: options.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		this.pluginManager = new PluginManager(player, manager, { extractorTimeout: options.extractorTimeout });
		this.extensionManager = new ExtensionManager(player, manager);
		player.pluginManager = this.pluginManager;
		player.extensionManager = this.extensionManager;
		player.streamManager = this.streamManager;
		this.ttsController = new TTSController({
			pluginManager: this.pluginManager,
			extensionManager: this.extensionManager,
			audioPlayer: this.audioPlayer,
			debug: o.debug,
			maxTimeTts: options.tts?.maxTimeTts,
			volume: options.tts?.volume ?? options.volume ?? 100,
			onStart: (track) => this.player.emit("ttsStart", { track }),
			onEnd: () => this.player.emit("ttsEnd"),
		});
		this.queueController = new QueueController({ queue: this.queue, bus: this.bus });
		Object.defineProperty(player, "relatedTracks", {
			enumerable: true,
			configurable: true,
			get: () => this.queueController.relatedTracks,
		});
		const resolver = new TrackResolver(this.streamManager);
		this.preloadManager = new PreloadManager({
			streamManager: this.streamManager,
			debug: o.debug,
			getNextTrack: () => (this.queue.loop() === "track" ? this.queue.currentTrack : this.queue.nextTrack),
			getStream: (t) => resolver.resolve(player, t),
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
			isEnabled: () => options.preload?.enabled ?? true,
		});
		this.trackLoader = new TrackLoader({
			middleware,
			context: { player, manager },
			resolvers: [(t) => resolver.resolve(player, t)],
			recovery: options.antiStuck,
			preloadManager: this.preloadManager,
			qualityController: {
				get: () => options.quality,
				set: (quality) => {
					options.quality = quality;
				},
			},
			debug: o.debug,
		});
		this.transitionController = new TransitionController({
			enabled: options.crossfade?.enabled ?? true,
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
		this.volumeController = new VolumeController(this.bus, {
			initialVolume: (options as any).volume ?? 100,
			loudness: options.loudnessNormalization,
		});
		this.playbackController = new PlaybackController({
			audioPlayer: this.audioPlayer,
			bus: this.bus,
			volumeController: this.volumeController,
			transitionController: this.transitionController,
		});
		this.streamController = new StreamController({ streamManager: this.streamManager, bus: this.bus });
		this.antiStuckController = new AntiStuckController({ ...options.antiStuck, bus: this.bus });
		this.preloadController = new PreloadController({ loader: this.trackLoader, manager: this.preloadManager, bus: this.bus });
		this.filterController = new FilterController(
			{
				refreshPlayerResource: (position) =>
					this.bus
						.request({ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position }, { timeoutMs: 30000 })
						.then(() => true)
						.catch(() => false),
			},
			o.debug,
			this.bus,
		);
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
		this.detachConnectionSubscription = this.bus.onOutput("[Connection]->[Player]:connected", (event) => {
			if (this.player.connection === event.connection) return;
			this.audioPlayerSubscription?.unsubscribe();
			this.audioPlayerSubscription = event.connection.subscribe(this.audioPlayer) ?? null;
			this.ttsController.setConnection(event.connection);
			this.player.connection = event.connection;
			o.debug(`[PlayerRuntimeController] AudioPlayer subscribed guild=${player.guildId} session=${event.sessionId}`);
		});
		this.bus.onOutput("[Connection]->[Player]:disconnected", (event) => {
			this.audioPlayerSubscription?.unsubscribe();
			this.audioPlayerSubscription = null;
			this.ttsController.setConnection(null);
			this.player.connection = null;
			o.debug(`[PlayerRuntimeController] AudioPlayer unsubscribed guild=${player.guildId} reason=${event.reason ?? "unknown"}`);
		});
		this.detachResourceRefresh = this.bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.handleResourceRefresh(event);
		});
		this.bus.subscribe("volumeRequested", ({ volume }) => this.volumeController.setVolume(volume));
		if (Array.isArray(options.filters) && options.filters.length > 0)
			void this.filterController
				.applyFilters(options.filters)
				.catch((error) => o.debug("[FilterController] Initial filter error:", error));
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}
	private async handleResourceRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		try {
			const session = this.orchestrator.currentSession;
			if (!session?.track || !session.isActive()) throw new Error("No active playback session");
			const position = event.position ?? session.position ?? 0;
			const info = await this.resolveFreshStream(session.track);
			if (!info?.stream && !info?.url) throw new Error("No stream available for resource refresh");
			if (info.remote) throw new Error("Cannot refresh a remote playback resource");
			await this.bus.action({
				type: "FILTER_SET_SOURCE_TYPE",
				streamType: info.type ?? "arbitrary",
				requestId: createPlayerRequestId(),
			});
			await this.bus.action({
				type: "FILTER_APPLY_AND_SEEK",
				streamInfo: info,
				position: Math.max(0, position),
				requestId: createPlayerRequestId(),
			});
			const processed = await this.bus.query("filteredStream");
			if (!processed) throw new Error("Filter controller did not produce a stream");
			if (!session.isActive()) throw new Error("Playback session became inactive during resource refresh");
			const active = await this.streamController.replace(processed, session);
			if (!session.isActive()) throw new Error("Playback session became inactive after stream replacement");
			const resource = this.playbackController.createResource(active.stream, session.track);
			session.setResource(resource);
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
		let stream = await this.player.extensionManager.provideStream(track);
		if (stream?.remote && stream.handle) return stream;
		if (stream?.stream) return stream;
		stream = await this.player.pluginManager.getStream(track);
		if (stream?.stream || stream?.remote) return stream;
		throw new Error(`No stream available for track: ${track.title}`);
	}
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachConnectionSubscription();
		this.audioPlayerSubscription?.unsubscribe();
		this.player.connection = null;
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
		this.bus.publish("destroyed");
		this.bus.clear();
	}
}
