import type { Bus, PlayerEvent, PlayerAction, PlayerEventType, PlayerActionExecutionContext } from "../structures/Bus";
import { describeEvent, traceEvent } from "./PlayerEventTrace";
import { BusLatencyTrace } from "./BusLatencyTrace";
import type { PlayerDebugLevel, PlayerEventDebugLogger } from "../types";

/**
 * Lower number = more severe / always-shown. A level is "enabled" when the
 * configured `level` is at least as severe (numerically <=) as the level
 * being logged, e.g. level="debug" (4) shows error/warn/info/debug but not
 * verbose/time.
 */
export const DEBUG_PRIORITY: Record<PlayerDebugLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	verbose: 5,
	time: 6,
};

/** Matches messages/args that look like a failure so a channel can auto-escalate its priority. */
const ERROR_LIKE = /\b(error|failed|failure|exception|timeout|aborted)\b|⚠️|❌/i;

/**
 * Central debug hub for a player (or, without a `bus`, for the manager).
 *
 * Everything that used to poke `manager.emit("debug", ...)` or
 * `this.emit("debug", ...)` directly - controllers, PluginManager,
 * ExtensionManager, extensions - should instead obtain a leveled logger via
 * {@link PlayerEventDebug.channel} (or call {@link PlayerEventDebug.log}
 * directly) so every message is gated by the same PRIORITY threshold
 * (`debugLevel` / `PlayerManagerOptions.debugLevel`), and tagged consistently.
 *
 * When a `bus` is supplied it additionally attaches verbose EVENT/ACTION
 * tracing for the complete Bus pipeline; this part is optional so the
 * same class can serve as a bus-less, manager-wide tracer too.
 */
export class PlayerEventDebug {
	private readonly detach: Array<() => void> = [];
	private readonly recent = new Map<string, number>();
	private readonly latencyTrace: BusLatencyTrace;
	private readonly internalTag: string;
	private level: PlayerDebugLevel;

	constructor(
		private readonly bus: Bus | undefined,
		private readonly id = "unknown",
		private readonly logger?: PlayerEventDebugLogger,
		level: PlayerDebugLevel = "info",
	) {
		this.level = level;
		this.internalTag = `PlayerEventDebug:${id}`;
		this.latencyTrace = new BusLatencyTrace(logger, level);
		if (this.bus) {
			// Latency tracing is a bus-wide (not per-player) diagnostic knob on the
			// shared Bus; the most recently attached tracer wins.
			this.bus.setLatencyTrace(this.latencyTrace);
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
				"willPlay",
				"queueEnd",
				"playerPause",
				"playerResume",
				"playerStop",
				"seek",
				"filterApplied",
				"filterRemoved",
				"filtersCleared",
				"streamError",
				"forwardModeStart",
				"forwardModeEnd",
			];
			for (const type of eventTypes) this.detach.push(this.bus.subscribe(this.id, type, (event) => this.event(event)));
			this.detach.push(
				this.bus.onAction((action, context) => {
					if (context.playerId === this.id) this.action(action, context);
				}),
			);
		}
		this.log("info", this.internalTag, "ATTACHED");
	}

	public get debugLevel(): PlayerDebugLevel {
		return this.level;
	}

	public setDebugLevel(level: PlayerDebugLevel): void {
		this.level = level;
		this.latencyTrace.setDebugLevel(level);
	}

	/** Whether a message logged at `level` would actually reach the logger right now. */
	public isEnabled(level: PlayerDebugLevel): boolean {
		return this.enabled(level);
	}

	/**
	 * Generic, tag-based logging entry point and the single place every debug
	 * message in the runtime eventually funnels through. `defaultLevel` is the
	 * PRIORITY the call site asks for; it is auto-escalated to at least `warn`
	 * when the message/args look like a failure (an `Error` instance, or text
	 * matching "error"/"failed"/"⚠️"/etc.) so problems aren't silently buried
	 * under a quiet default level.
	 */
	public log(defaultLevel: PlayerDebugLevel, tag: string, message?: any, ...args: any[]): void {
		const level = PlayerEventDebug.resolveLevel(defaultLevel, message, args);
		if (!this.enabled(level)) return;
		const text =
			message === undefined ? ""
			: typeof message === "string" ? message
			: String(message);
		this.logger?.(`[${tag}] ${text}`.trimEnd(), ...args);
	}

	/**
	 * Returns a drop-in replacement for the legacy `(message?, ...args) => void`
	 * debug callback, pre-bound to `tag` and `defaultLevel`. Existing call sites
	 * (`this.debug("Registered plugin: X")`, `this.debug("X failed:", err)`, ...)
	 * do not need to change - only what they're wired up to does.
	 */
	public channel(tag: string, defaultLevel: PlayerDebugLevel = "debug"): PlayerEventDebugLogger {
		return (message?: any, ...args: any[]) => this.log(defaultLevel, tag, message, ...args);
	}

	/** Priority auto-escalation shared by {@link log} and {@link channel}. */
	public static resolveLevel(defaultLevel: PlayerDebugLevel, message: unknown, args: unknown[]): PlayerDebugLevel {
		const looksLikeError =
			message instanceof Error ||
			args.some((value) => value instanceof Error) ||
			(typeof message === "string" && ERROR_LIKE.test(message));
		if (!looksLikeError) return defaultLevel;
		// Never *downgrade* an already-strict level (e.g. an explicit "error" stays "error").
		return DEBUG_PRIORITY[defaultLevel] > DEBUG_PRIORITY.warn ? "warn" : defaultLevel;
	}

	dispose() {
		this.log("info", this.internalTag, "DETACHED");
		for (const detach of this.detach.splice(0)) detach();
		this.recent.clear();
		if (this.bus) this.bus.setLatencyTrace(undefined);
	}

	private event(event: PlayerEvent) {
		if (!this.enabled("verbose")) return;
		const info = traceEvent(event);
		const data = describeEvent(event);
		const previous = this.recent.get(info.fingerprint);
		if (previous !== undefined) {
			this.log("warn", this.internalTag, "DUPLICATE EVENT", { ...data, previousSequence: previous });
		}
		this.recent.set(info.fingerprint, info.sequence);
		this.log("verbose", this.internalTag, "EVENT", data);
	}

	private action(action: PlayerAction, context: PlayerActionExecutionContext) {
		if (!this.enabled("debug")) return;
		this.log("debug", this.internalTag, "ACTION", {
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

	public bridge(message: string, ...value: any[]): void {
		this.log("verbose", this.internalTag, message, ...value);
	}
}
