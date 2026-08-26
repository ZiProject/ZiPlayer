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
import type { AudioPlayer } from "@discordjs/voice";

/**
 * Owns the decomposed runtime graph of a Player.
 *
 * This is deliberately independent from LegacyPlayer. The remaining legacy
 * dependency is injected only for compatibility while individual resources
 * are migrated into their controllers.
 */
export interface PlayerRuntimeControllerOptions {
	player: Player;
	manager: PlayerManager;
	options: PlayerOptions;
	audioPlayer: AudioPlayer;
	streamManager?: StreamManager;
	preloadManager?: PreloadManager;
	queue?: Queue;
	debug: (...args: any[]) => void;
}

export class PlayerRuntimeController {
	public readonly bus = new PlayerBus();
	public readonly actionExecutor = new PlayerAction(this.bus);
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
			...(Array.isArray(playerOptions.trackMiddleware)
				? playerOptions.trackMiddleware
				: playerOptions.trackMiddleware
					? [playerOptions.trackMiddleware]
					: []),
		];

		const queue = options.queue ?? new Queue();
		const streamManager = options.streamManager ?? new StreamManager({
			maxConcurrentStreams: playerOptions.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		const preloadManager = options.preloadManager ?? new PreloadManager({
			streamManager,
			debug: options.debug,
			getNextTrack: () => this.queueController?.queue.nextTrack ?? null,
			getStream: (track) => player.getStream(track),
			removeTrackFromQueue: (track) => {
				const nextTrack = this.queueController?.queue.nextTrack;
				if (!nextTrack) return false;
				const matches = nextTrack === track ||
					(nextTrack.id !== undefined && track.id !== undefined && nextTrack.id === track.id) ||
					(nextTrack.url !== undefined && track.url !== undefined && nextTrack.url === track.url);
				return matches ? this.queueController.queue.remove(0) !== null : false;
			},
			isDestroyed: () => this.disposed,
			isEnabled: () => playerOptions.preload?.enabled ?? true,
		});

		this.queueController = new QueueController({ queue, bus: this.bus });
		this.trackLoader = new TrackLoader({
			middleware,
			context: { player, manager },
			resolvers: [(track) => player.getStream(track)],
			recovery: playerOptions.antiStuck,
			preloadManager,
			debug: options.debug,
		});
		this.playbackController = new PlaybackController({ audioPlayer: options.audioPlayer, bus: this.bus });
		this.streamController = new StreamController({ streamManager, bus: this.bus });
		this.antiStuckController = new AntiStuckController({ ...playerOptions.antiStuck, bus: this.bus });
		this.transitionController = new TransitionController({
			enabled: playerOptions.crossfade?.enabled ?? true,
			durationMs: playerOptions.crossfade?.durationMs,
			smartEnabled: playerOptions.smartTransition?.enabled ?? true,
			genreAware: playerOptions.smartTransition?.genreAware ?? true,
			beatAlign: playerOptions.smartTransition?.beatAlign ?? true,
			baseDurationMs: playerOptions.smartTransition?.baseDurationMs ?? playerOptions.crossfade?.durationMs,
			minDurationMs: playerOptions.smartTransition?.minDurationMs,
			maxDurationMs: playerOptions.smartTransition?.maxDurationMs,
			beatAlignMaxWaitMs: playerOptions.smartTransition?.beatAlignMaxWaitMs,
			genreDurations: playerOptions.smartTransition?.genreDurations,
		});
		this.preloadController = new PreloadController({ loader: this.trackLoader, manager: preloadManager, bus: this.bus });
		this.orchestrator = new PlaybackOrchestrator(this.bus, {
			trackLoader: this.trackLoader,
			streamController: this.streamController,
			playbackController: this.playbackController,
			queueController: this.queueController,
			antiStuckController: this.antiStuckController,
			transitionController: this.transitionController,
			preloadController: this.preloadController,
		});

		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.actionExecutor.dispose();
		this.orchestrator.dispose();
		this.queueController.dispose();
		this.bus.publish("destroyed");
		this.bus.clear();
	}
}
