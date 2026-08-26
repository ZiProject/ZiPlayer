import type { PlayerBus } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import type { PlayerAction } from "./PlayerBus";
import type { Track } from "../types";

/**
 * Coordinates playback lifecycle without owning the public Player API.
 *
 * The orchestrator communicates through PlayerBus only. Concrete loaders and
 * playback/stream controllers can subscribe to the same bus in later steps.
 */
export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private readonly detachAction: () => void;
	private readonly detachQueries: Array<() => void> = [];

	public constructor(private readonly bus: PlayerBus) {
		this.detachAction = this.bus.onAction((action) => this.handleAction(action));

		this.detachQueries.push(
			this.bus.registerQuery("currentTrack", () => this.session?.track ?? null),
			this.bus.registerQuery("position", () => this.session?.position ?? null),
			this.bus.registerQuery("isPlaying", () => this.session?.status === "playing"),
			this.bus.registerQuery("isPaused", () => this.session?.status === "paused"),
		);
	}

	public get currentSession(): PlaybackSession | null {
		return this.session;
	}

	public dispose(): void {
		this.detachAction();
		for (const detach of this.detachQueries) detach();
		this.session?.destroy();
		this.session = null;
	}

	private async handleAction(action: PlayerAction): Promise<void> {
		switch (action.type) {
			case "play": {
				if (!action.track) return;
				await this.start(action.track);
				return;
			}
			case "pause":
				this.session?.markPaused();
				this.publishState();
				return;
			case "resume":
				if (this.session?.track) this.session.markPlaying();
				this.publishState();
				return;
			case "seek":
				this.session?.updatePosition(action.position);
				this.publishState();
				return;
			case "stop":
				this.session?.markStopped();
				this.publishState();
				return;
			case "skip":
				this.session?.markEnded();
				this.publishState();
				return;
			case "setVolume":
				this.bus.publish("volumeRequested", action.volume);
				return;
		}
	}

	private async start(track: Track): Promise<void> {
		this.session?.destroy();
		const session = new PlaybackSession();
		this.session = session;
		session.begin(track);

		this.bus.publish("playbackSessionCreated", session.snapshot());
		this.bus.publish("trackRequested", track, session);
	}

	private publishState(): void {
		if (!this.session) return;
		this.bus.publish("playbackStateChanged", this.session.snapshot());
	}
}
