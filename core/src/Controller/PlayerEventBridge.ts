import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { PlayerEventType, PlayerBus } from "../structures/PlayerBus";

/**
 * Bridges the internal PlayerBus event stream to the public Player EventEmitter
 * and then to PlayerManager.
 *
 * Controllers only publish canonical events to PlayerBus. This adapter is the
 * single boundary that restores the legacy public event surface without making
 * controllers depend on Player/PlayerManager.
 */
export class PlayerEventBridge {
	private readonly detach: Array<() => void> = [];
	private disposed = false;

	public constructor(
		private readonly player: Player,
		private readonly manager: PlayerManager,
		private readonly bus: PlayerBus,
	) {
		const events: PlayerEventType[] = [
			"TRACK_LOADING",
			"TRACK_LOADED",
			"TRACK_STARTED",
			"TRACK_ERROR",
			"TRACK_END",
			"STREAM_ABORTED",
			"playbackStateChanged",
			"playbackSessionCreated",
			"trackRequested",
			"stateChanged",
			"STUCK_DETECTED",
			"RECOVERY_STARTED",
			"RECOVERY_FAILED",
			"preloadStateChanged",
			"preloadPromoted",
			"preloadCancelled",
			"queueChanged",
			"volumeRequested",
		];

		for (const type of events) {
			this.detach.push(this.bus.subscribe(type, (event) => this.forward(event as any)));
		}
	}

	private forward(event: any): void {
		if (this.disposed || this.player.destroyed) return;

		const publicType = this.toPublicEventName(event.type);
		if (!publicType) return;

		const args = this.toArgs(event);
		this.player.emit(publicType, ...args);

		// Manager events intentionally receive the originating Player first. This
		// keeps manager-level listeners able to identify the guild/player while the
		// Player-level event keeps the legacy payload shape.
		this.emitManager(publicType, args);
	}

	private toPublicEventName(type: PlayerEventType): string | null {
		switch (type) {
			case "TRACK_LOADING":
				return "trackLoading";
			case "TRACK_LOADED":
				return "trackLoaded";
			case "TRACK_STARTED":
				return "trackStart";
			case "TRACK_ERROR":
				return "playerError";
			case "TRACK_END":
				return "trackEnd";
			case "STREAM_ABORTED":
				return "streamAborted";
			case "STUCK_DETECTED":
				return "trackStuck";
			case "RECOVERY_STARTED":
				return "recoveryStart";
			case "RECOVERY_FAILED":
				return "recoveryFailed";
			case "preloadStateChanged":
				return "preloadStateChanged";
			case "preloadPromoted":
				return "preloadPromoted";
			case "preloadCancelled":
				return "preloadCancelled";
			case "queueChanged":
				return "queueChange";
			case "volumeRequested":
				return "volumeChange";
			case "playbackStateChanged":
				return "playbackStateChanged";
			case "playbackSessionCreated":
				return "playbackSessionCreated";
			case "trackRequested":
				return "trackRequested";
			case "stateChanged":
				return "stateChanged";
			default:
				return null;
		}
	}

	private toArgs(event: any): any[] {
		switch (event.type) {
			case "TRACK_ERROR":
				return [event.error, event.session?.track];
			case "STUCK_DETECTED":
				return [event.session?.track, event.reason];
			case "RECOVERY_FAILED":
				return [event.session, event.session?.track];
			case "trackRequested":
				return [event.track, event.session];
			case "stateChanged":
				return [event.oldState, event.newState];
			case "queueChanged":
			case "volumeRequested":
			case "preloadStateChanged":
			case "preloadPromoted":
				return event.type === "queueChanged"
					? [event.queue]
					: event.type === "volumeRequested"
						? [event.volume]
						: event.type === "preloadStateChanged"
							? [event.state]
							: [event.track];
			case "preloadCancelled":
				return [];
			default:
				return event.session ? [event.session] : [];
		}
	}

	private emitManager(event: string, args: any[]): void {
		try {
			(this.manager.emit as any)(event, this.player, ...args);
		} catch (error) {
			this.player.debug(`[PlayerEventBridge] manager event "${event}" failed:`, error);
		}
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const detach of this.detach.splice(0)) detach();
	}
}
