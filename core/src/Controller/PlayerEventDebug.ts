import type { PlayerBus, PlayerEvent, PlayerAction, PlayerEventType } from "../structures/PlayerBus";

/**
 * Verbose diagnostics for the complete PlayerBus pipeline.
 *
 * This intentionally logs every canonical event/action, including events
 * which are not mapped to the public Player API, so the decomposition can be
 * debugged end-to-end.
 */
export class PlayerEventDebug {
	private readonly detach: Array<() => void> = [];

	constructor(private readonly bus: PlayerBus, private readonly id = "unknown") {
		const eventTypes: PlayerEventType[] = [
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

		for (const type of eventTypes) {
			this.detach.push(this.bus.subscribe(type, (event) => this.event(event)));
		}
		this.detach.push(this.bus.onAction((action, context) => this.action(action, context)));
		this.log("ATTACHED");
	}

	dispose() {
		this.log("DETACHED");
		for (const detach of this.detach.splice(0)) detach();
	}

	private event(event: PlayerEvent) {
		const value = event as unknown as Record<string, unknown>;
		const session = value.session as { id?: string; status?: string; track?: { id?: string; title?: string } } | undefined;
		this.log("EVENT", {
			type: event.type,
			requestId: value.requestId,
			sessionId: session?.id,
			status: session?.status,
			trackId: session?.track?.id,
			track: session?.track?.title,
		});
	}

	private action(action: PlayerAction, context: { requestId: string; priority: number; signal: AbortSignal }) {
		this.log("ACTION", {
			type: action.type,
			requestId: context.requestId,
			priority: context.priority,
			aborted: context.signal.aborted,
			action,
		});
	}

	private log(message: string, value?: unknown) {
		const prefix = `[PlayerBus:${this.id}]`;
		if (value === undefined) console.debug(prefix, message);
		else console.debug(prefix, message, value);
	}
}
