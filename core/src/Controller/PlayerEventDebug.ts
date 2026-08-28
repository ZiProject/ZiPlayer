import type { PlayerBus, PlayerEvent, PlayerAction } from "../structures/PlayerBus";

/** Verbose diagnostics for the PlayerBus pipeline. */
export class PlayerEventDebug {
	private readonly detachEvent: () => void;
	private readonly detachAction: () => void;

	constructor(private readonly bus: PlayerBus, private readonly id = "unknown") {
		this.detachEvent = bus.onEvent((event) => this.event(event));
		this.detachAction = bus.onAction((action) => this.action(action));
		this.log("ATTACHED");
	}

	dispose() {
		this.log("DETACHED");
		this.detachEvent();
		this.detachAction();
	}

	private event(event: PlayerEvent) {
		const value = event as unknown as Record<string, unknown>;
		this.log("EVENT", {
			type: event.type,
			requestId: value.requestId,
			sessionId: (value.session as { id?: string } | undefined)?.id,
			track: (value.session as { track?: { title?: string } } | undefined)?.track?.title,
		});
	}

	private action(action: PlayerAction) {
		this.log("ACTION", { type: action.type, action });
	}

	private log(message: string, value?: unknown) {
		if (value === undefined) console.debug(`[PlayerBus:${this.id}] ${message}`);
		else console.debug(`[PlayerBus:${this.id}] ${message}`, value);
	}
}
