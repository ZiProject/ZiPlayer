import type { PlayerBus, PlayerEvent, PlayerAction, PlayerEventType } from "../structures/PlayerBus";
import { describeEvent, traceEvent } from "./PlayerEventTrace";

/** Verbose diagnostics for the complete PlayerBus pipeline. */
export class PlayerEventDebug {
	private readonly detach: Array<() => void> = [];
	private readonly recent = new Map<string, number>();

	constructor(private readonly bus: PlayerBus, private readonly id = "unknown") {
		const eventTypes: PlayerEventType[] = [
			"initialized", "ready", "destroyed", "TRACK_LOADING", "TRACK_LOADED", "TRACK_STARTED",
			"TRACK_ERROR", "TRACK_END", "STREAM_ABORTED", "playbackStateChanged", "playbackSessionCreated",
			"trackRequested", "stateChanged", "STUCK_DETECTED", "RECOVERY_STARTED", "RECOVERY_FAILED",
			"preloadStateChanged", "preloadPromoted", "preloadCancelled", "queueChanged", "volumeRequested",
		];
		for (const type of eventTypes) this.detach.push(this.bus.subscribe(type, (event) => this.event(event)));
		this.detach.push(this.bus.onAction((action, context) => this.action(action, context)));
		this.log("ATTACHED");
	}

	dispose() {
		this.log("DETACHED");
		for (const detach of this.detach.splice(0)) detach();
	}

	private event(event: PlayerEvent) {
		const info = traceEvent(event);
		const data = describeEvent(event);
		const previous = this.recent.get(info.fingerprint);
		if (previous !== undefined) {
			this.log("DUPLICATE EVENT", { ...data, previousSequence: previous });
		}
		this.recent.set(info.fingerprint, info.sequence);
		this.log("EVENT", data);
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
