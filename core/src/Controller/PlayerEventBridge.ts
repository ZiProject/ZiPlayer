import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { PlayerEventType, PlayerBus } from "../structures/PlayerBus";
import { PlayerEventDebug } from "./PlayerEventDebug";

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
	private readonly debugTracer: PlayerEventDebug;
	private disposed = false;

	public constructor(
		private readonly player: Player,
		private readonly manager: PlayerManager,
		private readonly bus: PlayerBus,
	) {
		this.debugTracer = new PlayerEventDebug(bus, player.guildId);
		this.debug("attached");

		const events: PlayerEventType[] = [
			"initialized",
			"ready",
			"destroyed",
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
		if (this.disposed || this.player.destroyed) {
			this.debug("DROP EVENT", { type: event?.type, reason: this.disposed ? "disposed" : "player-destroyed" });
			return;
		}

		const publicType = this.toPublicEventName(event.type);
		if (!publicType) {
			this.debug("UNMAPPED BUS EVENT", event.type);
			return;
		}

		const args = this.toArgs(event);
		this.debug("BUS -> PLAYER", {
			busEvent: event.type,
			playerEvent: publicType,
			args: this.describeArgs(args),
		});

		try {
			this.player.emit(publicType, ...args);
			this.debug("PLAYER EMIT OK", publicType);
		} catch (error) {
			this.debug("PLAYER EMIT ERROR", { event: publicType, error });
		}

		// Manager events intentionally receive the originating Player first. This
		// keeps manager-level listeners able to identify the guild/player while the
		// Player-level event keeps the legacy payload shape.
		this.emitManager(publicType, args);
	}

	private toPublicEventName(type: PlayerEventType): string | null {
		switch (type) {
			case "initialized": return "initialized";
			case "ready": return "ready";
			case "destroyed": return "destroyed";
			case "TRACK_LOADING": return "trackLoading";
			case "TRACK_LOADED": return "trackLoaded";
			case "TRACK_STARTED": return "trackStart";
			case "TRACK_ERROR": return "playerError";
			case "TRACK_END": return "trackEnd";
			case "STREAM_ABORTED": return "streamAborted";
			case "STUCK_DETECTED": return "trackStuck";
			case "RECOVERY_STARTED": return "recoveryStart";
			case "RECOVERY_FAILED": return "recoveryFailed";
			case "preloadStateChanged": return "preloadStateChanged";
			case "preloadPromoted": return "preloadPromoted";
			case "preloadCancelled": return "preloadCancelled";
			case "queueChanged": return "queueChange";
			case "volumeRequested": return "volumeChange";
			case "playbackStateChanged": return "playbackStateChanged";
			case "playbackSessionCreated": return "playbackSessionCreated";
			case "trackRequested": return "trackRequested";
			case "stateChanged": return "stateChanged";
			default: return null;
		}
	}

	private toArgs(event: any): any[] {
		switch (event.type) {
			case "TRACK_ERROR": return [event.error, event.session?.track];
			case "STUCK_DETECTED": return [event.session?.track, event.reason];
			case "RECOVERY_FAILED": return [event.session, event.error];
			case "trackRequested": return [event.track, event.session];
			case "stateChanged": return [event.oldState, event.newState];
			case "queueChanged": return [event.queue];
			case "volumeRequested": return [event.volume];
			case "preloadStateChanged": return [event.state];
			case "preloadPromoted": return [event.track];
			case "preloadCancelled": return [];
			case "initialized":
			case "ready":
			case "destroyed": return [];
			default: return event.session ? [event.session] : [];
		}
	}

	private emitManager(event: string, args: any[]): void {
		try {
			this.debug("PLAYER -> MANAGER", { event, args: this.describeArgs(args) });
			(this.manager.emit as any)(event, this.player, ...args);
			this.debug("MANAGER EMIT OK", event);
		} catch (error) {
			this.debug("MANAGER EMIT ERROR", { event, error });
		}
	}

	private describeArgs(args: any[]): unknown[] {
		return args.map((arg) => {
			if (!arg || typeof arg !== "object") return arg;
			const value = arg as any;
			return {
				id: value.id,
				title: value.title,
				status: value.status,
				trackId: value.track?.id,
				track: value.track?.title,
			};
		});
	}

	private debug(message: string, value?: unknown): void {
		if (value === undefined) console.debug(`[PlayerEventBridge:${this.player.guildId}] ${message}`);
		else console.debug(`[PlayerEventBridge:${this.player.guildId}] ${message}`, value);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.debug("disposing");
		for (const detach of this.detach.splice(0)) detach();
		this.debugTracer.dispose();
	}
}
