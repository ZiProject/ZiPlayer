import type { PlayerOptions, TrackMiddleware } from "../types";
import type { PlayerManager } from "./PlayerManager";
import { Player as LegacyPlayer } from "./Player.old";
import {
	PlayerBus,
	type PlayerAction,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
} from "./PlayerBus";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { PlaybackController } from "./PlaybackController";
import { StreamController } from "./StreamController";
import { QueueController } from "./QueueController";
import { TrackLoader } from "./TrackLoader";
import { AntiStuckController } from "./AntiStuckController";
import { TransitionController } from "./TransitionController";
import { PreloadController } from "./PreloadController";

/**
 * Public Player facade.
 *
 * The legacy implementation is kept behind this boundary while playback
 * ownership moves into the controller graph. PlayerBus is the communication
 * surface between the facade and the subsystem graph; it is intentionally
 * not a playback command queue.
 */
export class Player extends LegacyPlayer {
	public readonly bus: PlayerBus;
	public readonly orchestrator: PlaybackOrchestrator;

	public readonly trackLoader: TrackLoader;
	public readonly streamController: StreamController;
	public readonly playbackController: PlaybackController;
	public readonly queueController: QueueController;
	public readonly antiStuckController: AntiStuckController;
	public readonly transitionController: TransitionController;
	public readonly preloadController: PreloadController;

	public constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super(guildId, options, manager);

		this.bus = new PlayerBus();

		const middleware: TrackMiddleware[] = [
			...manager.getTrackMiddlewareChain(),
			...(Array.isArray(options.trackMiddleware)
				? options.trackMiddleware
				: options.trackMiddleware
					? [options.trackMiddleware]
					: []),
		];

		this.queueController = new QueueController({ queue: this.queue, bus: this.bus });

		this.trackLoader = new TrackLoader({
			middleware,
			context: { player: this, manager },
			resolvers: [(track) => this.getStream(track)],
			recovery: options.antiStuck,
			preloadManager: this.preloadManager,
			debug: this.debug.bind(this),
		});

		this.playbackController = new PlaybackController({
			audioPlayer: this.audioPlayer,
			bus: this.bus,
		});

		this.streamController = new StreamController({
			streamManager: this.streamManager,
			bus: this.bus,
		});

		this.antiStuckController = new AntiStuckController({
			...options.antiStuck,
			bus: this.bus,
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

		this.preloadController = new PreloadController({
			loader: this.trackLoader,
			manager: this.preloadManager,
			bus: this.bus,
		});

		this.orchestrator = new PlaybackOrchestrator(this.bus, {
			trackLoader: this.trackLoader,
			streamController: this.streamController,
			playbackController: this.playbackController,
			queueController: this.queueController,
			antiStuckController: this.antiStuckController,
			transitionController: this.transitionController,
			preloadController: this.preloadController,
		});

		// PlaybackController owns the AudioPlayer state listener and forwards it
		// through PlayerBus. Do not attach a second facade-level listener here.
		this.bus.publish("initialized");
		this.bus.publish("ready");
	}

	public action(action: PlayerAction): Promise<void> {
		return this.bus.action(action);
	}

	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		return this.bus.query(query);
	}

	public subscribe<K extends PlayerEventType>(
		type: K,
		listener: (event: Extract<PlayerEvent, { type: K }>) => void,
	): () => void {
		return this.bus.subscribe(type, listener);
	}

	public override destroy(): void {
		if (this.destroyed) return;
		this.bus.publish("destroyed");
		this.orchestrator.dispose();
		this.bus.clear();
		super.destroy();
	}
}
