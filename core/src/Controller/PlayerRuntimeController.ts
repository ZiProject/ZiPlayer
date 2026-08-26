import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";
import type { AudioPlayer } from "@discordjs/voice";
import type { PlayerOptions, TrackMiddleware } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import { PlayerBus } from "../structures/PlayerBus";
import { PlayerAction } from "../structures/PlayerAction";
import { PlaybackOrchestrator } from "../structures/PlaybackOrchestrator";
import { TrackLoader } from "../structures/TrackLoader";
import { PlaybackController } from "./PlaybackController";
import { StreamController } from "./StreamController";
import { QueueController } from "./QueueController";
import { AntiStuckController } from "./AntiStuckController";
import { TransitionController } from "./TransitionController";
import { PreloadController } from "./PreloadController";
import { Queue } from "../structures/Queue";
import { StreamManager } from "../structures/StreamManager";
import { PreloadManager } from "../structures/PreloadManager";
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
	public readonly queue: Queue;
	public readonly audioPlayer: AudioPlayer;
	public readonly streamManager: StreamManager;
	public readonly preloadManager: PreloadManager;
	public readonly queueController: QueueController;
	public readonly trackLoader: TrackLoader;
	public readonly playbackController: PlaybackController;
	public readonly streamController: StreamController;
	public readonly antiStuckController: AntiStuckController;
	public readonly transitionController: TransitionController;
	public readonly preloadController: PreloadController;
	public readonly orchestrator: PlaybackOrchestrator;

	private disposed = false;

	public constructor(options: PlayerRuntimeControllerOptions) {
		const { player, manager, options: playerOptions } = options;
		const middleware: TrackMiddleware[] = [
			...manager.getTrackMiddlewareChain(),
			...(Array.isArray(playerOptions.trackMiddleware) ? playerOptions.trackMiddleware : playerOptions.trackMiddleware ? [playerOptions.trackMiddleware] : []),
		];

		this.queue = new Queue();
		this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.streamManager = new StreamManager({ maxConcurrentStreams: playerOptions.maxStreamStore ?? 4, streamTimeout: 5 * 60 * 1000, maxListenersPerStream: 15, enableMetrics: true, autoDestroy: true });
		this.queueController = new QueueController({ queue: this.queue, bus: this.bus });
		this.preloadManager = new PreloadManager({
			streamManager: this.streamManager,
			debug: options.debug,
			getNextTrack: () => this.queue.loop() === "track" ? this.queue.currentTrack : this.queue.nextTrack,
			getStream: (track) => player.getStream(track),
			removeTrackFromQueue: (track) => {
				const nextTrack = this.queue.nextTrack;
				const matches = nextTrack === track || (nextTrack?.id !== undefined && track.id !== undefined && nextTrack.id === track.id) || (nextTrack?.url !== undefined && track.url !== undefined && nextTrack.url === track.url);
				return matches ? this.queue.remove(0) !== null : false;
			},
			isDestroyed: () => this.disposed,
			isEnabled: () => playerOptions.preload?.enabled ?? true,
		});
		this.trackLoader = new TrackLoader({ middleware, context: { player, manager }, resolvers: [(track) => player.getStream(track)], recovery: playerOptions.antiStuck, preloadManager: this.preloadManager, debug: options.debug });
		this.playbackController = new PlaybackController({ audioPlayer: this.audioPlayer, bus: this.bus });
		this.streamController = new StreamController({ streamManager: this.streamManager, bus: this.bus });
		this.antiStuckController = new AntiStuckController({ ...playerOptions.antiStuck, bus: this.bus });
		this.transitionController = new TransitionController({ enabled: playerOptions.crossfade?.enabled ?? true, durationMs: playerOptions.crossfade?.durationMs, smartEnabled: playerOptions.smartTransition?.enabled ?? true, genreAware: playerOptions.smartTransition?.genreAware ?? true, beatAlign: playerOptions.smartTransition?.beatAlign ?? true, baseDurationMs: playerOptions.smartTransition?.baseDurationMs ?? playerOptions.crossfade?.durationMs, minDurationMs: playerOptions.smartTransition?.minDurationMs, maxDurationMs: playerOptions.smartTransition?.maxDurationMs, beatAlignMaxWaitMs: playerOptions.smartTransition?.beatAlignMaxWaitMs, genreDurations: playerOptions.smartTransition?.genreDurations });
		this.preloadController = new PreloadController({ loader: this.trackLoader, manager: this.preloadManager, bus: this.bus });
		this.orchestrator = new PlaybackOrchestrator(this.bus, { trackLoader: this.trackLoader, streamController: this.streamController, playbackController: this.playbackController, queueController: this.queueController, antiStuckController: this.antiStuckController, transitionController: this.transitionController, preloadController: this.preloadController });
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.actionExecutor.dispose();
		this.orchestrator.dispose();
		this.preloadController.dispose();
		this.preloadManager.cancelPreload();
		this.streamController.dispose();
		this.streamManager.destroyAll();
		this.queueController.dispose();
		this.playbackController.dispose();
		this.bus.publish("destroyed");
		this.bus.clear();
	}
}
