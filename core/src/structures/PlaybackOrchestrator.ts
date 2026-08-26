import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import type { Track } from "../types";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "./StreamController";
import type { PlaybackController } from "./PlaybackController";
import type { QueueController } from "./QueueController";
import type { AntiStuckController } from "./AntiStuckController";
import type { TransitionController } from "./TransitionController";
import type { PreloadController } from "./PreloadController";

export interface PlaybackOrchestratorOptions {
	trackLoader?: TrackLoader;
	streamController?: StreamController;
	playbackController?: PlaybackController;
	queueController?: QueueController;
	antiStuckController?: AntiStuckController;
	transitionController?: TransitionController;
	preloadController?: PreloadController;
}

/** Coordinates playback controllers while keeping Player as the public facade. */
export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private readonly detachAction: () => void;
	private readonly detachQueries: Array<() => void> = [];
	private readonly trackLoader?: TrackLoader;
	private readonly streamController?: StreamController;
	private readonly playbackController?: PlaybackController;
	private readonly queueController?: QueueController;
	private readonly antiStuckController?: AntiStuckController;
	private readonly transitionController?: TransitionController;
	private readonly preloadController?: PreloadController;

	public constructor(private readonly bus: PlayerBus, options: PlaybackOrchestratorOptions = {}) {
		this.trackLoader = options.trackLoader;
		this.streamController = options.streamController;
		this.playbackController = options.playbackController;
		this.queueController = options.queueController;
		this.antiStuckController = options.antiStuckController;
		this.transitionController = options.transitionController;
		this.preloadController = options.preloadController;

		this.detachAction = this.bus.onAction((action) => this.handleAction(action));
		this.detachQueries.push(
			this.bus.registerQuery("currentTrack", () => this.session?.track ?? this.queueController?.queue.currentTrack ?? null),
			this.bus.registerQuery("playerState", () => this.session?.status ?? "idle"),
			this.bus.registerQuery("queue", () => this.queueController?.snapshot() ?? []),
			this.bus.registerQuery("playbackSession", () => this.session?.snapshot() ?? null),
			this.bus.registerQuery("position", () => this.session?.position ?? null),
			this.bus.registerQuery("volume", () => 100),
			this.bus.registerQuery("isPlaying", () => this.session?.status === "playing"),
			this.bus.registerQuery("isPaused", () => this.session?.status === "paused"),
		);
	}

	public get currentSession(): PlaybackSession | null { return this.session; }
	public get transitionPolicy(): TransitionController | undefined { return this.transitionController; }

	public dispose(): void {
		this.detachAction();
		for (const detach of this.detachQueries) detach();
		this.antiStuckController?.dispose();
		this.preloadController?.dispose();
		this.playbackController?.dispose();
		this.streamController?.dispose();
		this.session?.destroy();
		this.session = null;
	}

	private async handleAction(action: PlayerAction): Promise<void> {
		switch (action.type) {
			case "PLAY":
				if (action.track) await this.start(action.track);
				return;
			case "PAUSE":
				this.playbackController?.pause();
				this.session?.markPaused();
				this.publishState();
				return;
			case "RESUME":
				this.playbackController?.resume();
				this.session?.markPlaying();
				this.publishState();
				return;
			case "SEEK":
				this.session?.updatePosition(action.position);
				this.publishState();
				return;
			case "STOP":
				this.playbackController?.stop();
				this.antiStuckController?.clear(this.session ?? undefined);
				this.session?.markStopped();
				this.streamController?.abortCurrent();
				this.trackLoader?.cancelPreload();
				this.publishState();
				return;
			case "SKIP":
				this.playbackController?.stop();
				if (this.session) {
					this.antiStuckController?.clear(this.session);
					this.session.markEnded();
					this.bus.event({ type: "TRACK_END", session: this.session.snapshot() });
				}
				this.streamController?.abortCurrent();
				this.trackLoader?.cancelPreload();
				return;
			case "SET_VOLUME":
				this.bus.publish("volumeRequested", action.volume);
				return;
		}
	}

	private async start(track: Track): Promise<void> {
		this.playbackController?.stop();
		this.streamController?.abortCurrent();
		this.antiStuckController?.clear(this.session ?? undefined);
		this.trackLoader?.resetRecovery(this.session?.track ?? undefined);
		this.trackLoader?.cancelPreload();
		this.session?.destroy();

		const session = new PlaybackSession();
		this.session = session;
		session.begin(track);
		this.queueController?.queue.setCurrentTrack(track);
		this.bus.event({ type: "TRACK_LOADING", session: session.snapshot() });

		if (!this.trackLoader || !this.streamController || !this.playbackController) {
			this.bus.publish("playbackSessionCreated", session.snapshot());
			this.bus.publish("trackRequested", track, session);
			return;
		}

		try {
			const loaded = await this.trackLoader.loadWithRecovery(track, session);
			if (!this.session?.owns(session.id)) return;
			this.bus.event({ type: "TRACK_LOADED", session: session.snapshot() });

			if (loaded.stream.remote && loaded.stream.handle) {
				this.bus.publish("trackRequested", loaded.track, session);
				return;
			}

			const activeStream = await this.streamController.replace(loaded.stream, session);
			if (!this.session?.owns(session.id)) return;
			const resource = this.playbackController.createResource(activeStream.stream);
			session.setResource(resource);
			this.playbackController.play(resource, session);
			session.markPlaying();
			this.bus.event({ type: "TRACK_STARTED", session: session.snapshot() });
			void this.trackLoader.preloadNext().catch(() => undefined);
		} catch (error) {
			if (!session.signal.aborted) {
				this.bus.event({ type: "TRACK_ERROR", session: session.snapshot(), error: error instanceof Error ? error : new Error(String(error)) });
			}
		}
	}

	private publishState(): void {
		if (!this.session) return;
		this.bus.publish("playbackStateChanged", this.session.snapshot());
	}
}
