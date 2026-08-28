import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { ManagerEvents } from "../types";
import type { PlayerEventType, PlayerBus, PlayerEvent, PlaybackSessionSnapshot } from "../structures/PlayerBus";
import { PlayerEventDebug } from "./PlayerEventDebug";
import { describeEvent, traceEvent } from "./PlayerEventTrace";

/** Bridges canonical PlayerBus events to the typed public Player/PlayerManager event APIs. */
export class PlayerEventBridge {
	private readonly detach: Array<() => void> = [];
	private readonly debugTracer: PlayerEventDebug;
	private disposed = false;
	private readonly recent = new Map<string, number>();
	private lastVolume: number;

	public constructor(
		private readonly player: Player,
		private readonly manager: PlayerManager,
		private readonly bus: PlayerBus,
	) {
		this.debugTracer = new PlayerEventDebug(bus, player.guildId);
		this.lastVolume = player.volume;
		this.debug("attached", { volume: this.lastVolume });

		const events: PlayerEventType[] = [
			"initialized", "ready", "destroyed", "TRACK_LOADING", "TRACK_LOADED", "TRACK_STARTED",
			"TRACK_ERROR", "TRACK_END", "STREAM_ABORTED", "playbackStateChanged", "playbackSessionCreated",
			"trackRequested", "stateChanged", "STUCK_DETECTED", "RECOVERY_STARTED", "RECOVERY_FAILED",
			"preloadStateChanged", "preloadPromoted", "preloadCancelled", "queueChanged", "volumeRequested",
		];
		for (const type of events) this.detach.push(this.bus.subscribe(type, (event) => this.forward(event)));
	}

	private forward(event: PlayerEvent): void {
		if (this.disposed || this.player.destroyed) {
			this.debug("DROP EVENT", { ...describeEvent(event), reason: this.disposed ? "disposed" : "player-destroyed" });
			return;
		}

		const trace = traceEvent(event);
		const publicType = this.toPublicEventName(event.type);
		if (!publicType) {
			this.debug("UNMAPPED BUS EVENT", { ...describeEvent(event), sequence: trace.sequence });
			return;
		}

		const args = this.toArgs(event);
		const previous = this.recent.get(trace.fingerprint);
		if (previous !== undefined) {
			this.debug("DUPLICATE PROPAGATION", {
				sequence: trace.sequence,
				previousSequence: previous,
				fingerprint: trace.fingerprint,
				...describeEvent(event),
			});
		}
		this.recent.set(trace.fingerprint, trace.sequence);

		this.debug("BUS -> PLAYER", {
			sequence: trace.sequence,
			busEvent: event.type,
			playerEvent: publicType,
			args: this.describeArgs(event, args),
		});

		try {
			this.player.emit(publicType, ...args);
			this.debug("PLAYER EMIT OK", { sequence: trace.sequence, event: publicType });
		} catch (error) {
			this.debug("PLAYER EMIT ERROR", { sequence: trace.sequence, event: publicType, error });
		}

		this.emitManager(trace.sequence, event);
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

	private toArgs(event: PlayerEvent): any[] {
		switch (event.type) {
			case "TRACK_ERROR": return [event.session, event.error];
			case "STUCK_DETECTED": return [event.session, event.reason];
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

	/**
	 * Translate canonical bus events into the public ManagerEvents contract.
	 * Internal-only bus events are deliberately not forwarded to the manager.
	 */
	private emitManager(sequence: number, event: PlayerEvent): void {
		try {
			switch (event.type) {
				case "TRACK_STARTED": {
					const track = this.resolveTrack(event.session);
					if (track) this.emitTypedManager("trackStart", track);
					else this.debug("SKIP MANAGER EVENT", { sequence, event: "trackStart", reason: "missing-track" });
					break;
				}
				case "TRACK_END": {
					const track = this.resolveTrack(event.session);
					if (track) this.emitTypedManager("trackEnd", track);
					else this.debug("SKIP MANAGER EVENT", { sequence, event: "trackEnd", reason: "missing-track" });
					break;
				}
				case "TRACK_ERROR": {
					const track = this.resolveTrack(event.session);
					this.emitTypedManager("playerError", event.error, track ?? undefined);
					break;
				}
				case "trackRequested": {
					this.emitTypedManager("willPlay", event.track, this.player.queueController.snapshot());
					break;
				}
				case "volumeRequested": {
					const oldVolume = this.lastVolume;
					this.lastVolume = event.volume;
					this.emitTypedManager("volumeChange", oldVolume, event.volume);
					break;
				}
				case "stateChanged":
					this.emitAudioStateManagerEvent(sequence, event.oldState.status, event.newState.status);
					break;
				case "playbackStateChanged":
					// Session-state notifications are public Player events, but there is no
					// corresponding ManagerEvents member. Do not leak the wrong payload shape.
					break;
				case "initialized":
				case "ready":
				case "destroyed":
				case "TRACK_LOADING":
				case "TRACK_LOADED":
				case "STREAM_ABORTED":
				case "playbackSessionCreated":
				case "STUCK_DETECTED":
				case "RECOVERY_STARTED":
				case "RECOVERY_FAILED":
				case "preloadStateChanged":
				case "preloadPromoted":
				case "preloadCancelled":
				case "queueChanged":
					break;
			}
		} catch (error) {
			this.debug("MANAGER EMIT ERROR", { sequence, event: event.type, error });
		}
	}

	private emitAudioStateManagerEvent(
		sequence: number,
		oldStatus: string,
		newStatus: string,
	): void {
		const track = this.player.currentTrack;

		if (newStatus === "paused") {
			if (track) this.emitTypedManager("playerPause", track);
			else this.debug("SKIP MANAGER EVENT", { sequence, event: "playerPause", reason: "missing-track" });
		} else if (newStatus === "playing" && oldStatus !== "playing") {
			if (track) this.emitTypedManager("playerResume", track);
			else this.debug("SKIP MANAGER EVENT", { sequence, event: "playerResume", reason: "missing-track" });
		} else if ((newStatus === "idle" || newStatus === "stopped") && oldStatus !== newStatus) {
			this.emitTypedManager("playerStop");
			if (newStatus === "idle" && this.player.currentTrack === null) this.emitTypedManager("queueEnd");
		}
	}

	private resolveTrack(session: PlaybackSessionSnapshot): NonNullable<PlaybackSessionSnapshot["track"]> | null {
		return session.track ?? this.player.currentTrack ?? null;
	}

	private emitTypedManager<K extends keyof ManagerEvents>(event: K, ...args: ManagerEvents[K]): void {
		this.debug("PLAYER -> MANAGER", { event, args });
		this.manager.emit(event, ...args);
		this.debug("MANAGER EMIT OK", { event });
	}

	private describeArgs(event: PlayerEvent, args: any[]): unknown[] {
		return args.map((arg) => {
			if (!arg || typeof arg !== "object") return arg;
			if (event.type === "queueChanged") return {
				kind: "queue",
				size: Array.isArray(arg) ? arg.length : undefined,
				trackIds: Array.isArray(arg) ? arg.map((t: any) => t?.id) : undefined,
			};
			if (event.type === "stateChanged") return { kind: "state", status: arg.status, state: arg.state };
			if (event.type === "preloadStateChanged") return {
				kind: "preload",
				requestedTrackId: arg.requestedTrack?.id,
				valid: arg.valid,
			};
			const value = arg as any;
			return {
				kind: "object",
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
