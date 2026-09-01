import type { PlayerBus, PlayerEvent, PlayerAction, PlayerEventType } from "../structures/PlayerBus";
import { describeEvent, traceEvent } from "./PlayerEventTrace";
import type { PlayerDebugLevel, PlayerEventDebugLogger } from "../types";

const DEBUG_PRIORITY: Record<PlayerDebugLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	verbose: 5,
};

/** Verbose diagnostics for the complete PlayerBus pipeline. */
export class PlayerEventDebug {
	private readonly detach: Array<() => void> = [];
	private readonly recent = new Map<string, number>();
	private level: PlayerDebugLevel;

	constructor(
		private readonly bus: PlayerBus,
		private readonly id = "unknown",
		private readonly logger?: PlayerEventDebugLogger,
		level: PlayerDebugLevel = "info",
	) {
		this.level = level;
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
		for (const type of eventTypes) this.detach.push(this.bus.subscribe(type, (event) => this.event(event)));
		this.detach.push(this.bus.onAction((action, context) => this.action(action, context)));
		this.log("info", "ATTACHED");
	}

	public get debugLevel(): PlayerDebugLevel {
		return this.level;
	}

	public setDebugLevel(level: PlayerDebugLevel): void {
		this.level = level;
	}

	dispose() {
		this.log("info", "DETACHED");
		for (const detach of this.detach.splice(0)) detach();
		this.recent.clear();
	}

	private event(event: PlayerEvent) {
		if (!this.enabled("verbose")) return;
		const info = traceEvent(event);
		const data = describeEvent(event);
		const previous = this.recent.get(info.fingerprint);
		if (previous !== undefined) {
			this.log("warn", "DUPLICATE EVENT", { ...data, previousSequence: previous });
		}
		this.recent.set(info.fingerprint, info.sequence);
		this.log("verbose", "EVENT", data);
	}

	private action(action: PlayerAction, context: { requestId: string; priority: number; signal: AbortSignal }) {
		if (!this.enabled("debug")) return;
		this.log("debug", "ACTION", {
			type: action.type,
			requestId: context.requestId,
			priority: context.priority,
			aborted: context.signal.aborted,
			action,
		});
	}

	private enabled(level: PlayerDebugLevel): boolean {
		return DEBUG_PRIORITY[this.level] >= DEBUG_PRIORITY[level];
	}

	private log(level: PlayerDebugLevel, message: string, value?: unknown) {
		if (!this.enabled(level)) return;
		this.logger?.(`[PlayerEventDebug:${this.id}] ${message}`, value);
	}
}
