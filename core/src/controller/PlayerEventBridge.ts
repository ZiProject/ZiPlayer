import type { Player } from "../structures/Player";
import type { PlayerEventType, PlayerBus, PlayerEvent } from "../structures/PlayerBus";

import { PlayerEventDebug } from "./PlayerEventDebug";
import { describeEvent, traceEvent } from "./PlayerEventTrace";

/** Bridges canonical PlayerBus events to the public Player event API. */
export class PlayerEventBridge {
	private readonly detach: Array<() => void> = [];
	private disposed = false;
	private readonly recent = new Map<string, number>();
	private previousQueue: any[];

	public constructor(
		private readonly player: Player,
		private readonly manager: any,
		private readonly bus: PlayerBus,
		private readonly eventDebug: PlayerEventDebug,
	) {
		this.previousQueue = player.queueController.snapshot();
		this.debug("attached", { queueSize: this.previousQueue.length });

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
		for (const type of events) this.detach.push(this.bus.subscribe(type, (event) => this.forward(event)));

		this.detach.push(
			this.bus.onOutput("[Connection]->[Player]:error", (event) => {
				if (this.disposed || this.player.destroyed) return;
				this.player.emit("connectionError", event.error);
			}),
		);
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
			this.emitQueueCompatibilityEvents(event);
			this.debug("PLAYER EMIT OK", { sequence: trace.sequence, event: publicType });
		} catch (error) {
			this.debug("PLAYER EMIT ERROR", { sequence: trace.sequence, event: publicType, error });
		}
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
			case "TRACK_STARTED": return [event.track];
			case "TRACK_ERROR": return [event.error, event.session.track ?? undefined];
			case "TRACK_END": return event.session.track ? [event.session.track] : [];
			case "STUCK_DETECTED": return [event.session.track ?? null];
			case "RECOVERY_FAILED": return [];
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

	private emitQueueCompatibilityEvents(event: PlayerEvent): void {
		if (event.type !== "queueChanged") return;
		const next = event.queue;
		const previous = this.previousQueue;
		this.previousQueue = [...next];

		if (next.length > previous.length) {
			const added = next.filter((track) => !previous.some((old) => old?.id === track?.id));
			if (added.length === 1) this.player.emit("queueAdd", added[0]);
			else if (added.length > 1) this.player.emit("queueAddList", added);
		} else if (next.length < previous.length) {
			const removed = previous.filter((track) => !next.some((current) => current?.id === track?.id));
			if (removed.length === 1) {
				const track = removed[0];
				this.player.emit("queueRemove", track, previous.indexOf(track));
			}
		}
	}

	private describeArgs(event: PlayerEvent, args: any[]): any {
		if (event.type === "TRACK_ERROR") return { error: event.error?.message, track: event.session.track?.id };
		return args;
	}

	private debug(message: string, ...args: any[]): void {
		try {
			this.eventDebug.emit("debug", `[PlayerEventBridge:${this.player.guildId}] ${message}`, ...args);
		} catch {
			// Debugging must never affect playback/event propagation.
		}
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.detach.splice(0)) {
			try { unsubscribe(); } catch { /* noop */ }
		}
		this.recent.clear();
	}
}
