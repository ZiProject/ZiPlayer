import type { Player } from "../structures/Player";
import type { PlayerEventType, Bus, PlayerEvent } from "../structures/Bus";
import { BUS_OUTPUT, CONTROLLER_RPC } from "../structures/BusContract";
import { PlayerEventDebug } from "./PlayerEventDebug";
import { describeEvent, traceEvent } from "./PlayerEventTrace";

const EVENT_TYPES: PlayerEventType[] = [
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

interface PlayerEventBridgeSlot {
	player: Player | null;
	eventDebug: PlayerEventDebug;
	previousQueue: any[];
	recent: Map<string, number>;
	disposed: boolean;
}

/**
 * Bridges canonical Bus events (and the `player.emitTtsStart`/`emitTtsEnd` RPCs) to the
 * public Player event API.
 *
 * Singleton — created once and shared by every player in the process. The two RPCs and the
 * `[Connection]->[Player]:error` output are registered a single time for the whole
 * process (their dispatch is already global, routed by `ctx.playerId`/`event.playerId`).
 * The ~30 canonical event types are scoped per player by `Bus.subscribe(playerId, ...)`,
 * so those subscriptions are (re)created once per `attach(playerId, ...)` call rather
 * than once per bridge instance; `PlayerManager.destroy(playerId)` (which triggers
 * `controller.detach(playerId)`) tears down per-player state while shared controllers
 * remain alive.
 */
export class PlayerEventBridge {
	private readonly slots = new Map<string, PlayerEventBridgeSlot>();

	public constructor(private readonly bus: Bus) {
		bus.registerRpc<{ track: any }, void>(CONTROLLER_RPC.playerEmitTtsStart, ({ track }, ctx) => {
			const slot = this.slots.get(ctx.playerId);
			if (slot && !slot.disposed && slot.player && !slot.player.destroyed) slot.player.emit("ttsStart", { track });
		});
		bus.registerRpc<void, void>(CONTROLLER_RPC.playerEmitTtsEnd, (_req, ctx) => {
			const slot = this.slots.get(ctx.playerId);
			if (slot && !slot.disposed && slot.player && !slot.player.destroyed) slot.player.emit("ttsEnd");
		});
		bus.onOutput(BUS_OUTPUT.connectionError, (event) => {
			const slot = this.slots.get(event.playerId);
			if (!slot || slot.disposed || !slot.player || slot.player.destroyed) return;
			slot.player.emit("connectionError", event.error);
		});
	}

	/** Opens a slot for `playerId` and subscribes to every canonical event type for it.
	 *  Called from `createControllerGraph()`, before the Player instance exists yet
	 *  (see `attachPlayer()`) — events that fire in that window are traced but not
	 *  emitted anywhere, matching the previous per-instance bridge's behavior. */
	public attach(playerId: string, eventDebug: PlayerEventDebug): void {
		const slot: PlayerEventBridgeSlot = {
			player: null,
			eventDebug,
			previousQueue: this.bus.querySync(playerId, "queue") ?? [],
			recent: new Map(),
			disposed: false,
		};
		this.slots.set(playerId, slot);
		this.debug(slot, "attached", { queueSize: slot.previousQueue.length });
		for (const type of EVENT_TYPES) this.bus.subscribe(playerId, type, (event) => this.forward(playerId, event));
	}

	/** Registers the (now-existing) Player facade for `playerId`. */
	public attachPlayer(playerId: string, player: Player): void {
		const slot = this.slots.get(playerId);
		if (slot) slot.player = player;
	}

	/** Closes `playerId`'s slot. Bus event subscriptions are torn down separately by
	 *  `Bus.disposePlayer(playerId)`. */
	public detach(playerId: string): void {
		const slot = this.slots.get(playerId);
		if (slot) {
			slot.disposed = true;
			slot.recent.clear();
		}
		this.slots.delete(playerId);
	}

	private forward(playerId: string, event: PlayerEvent): void {
		const slot = this.slots.get(playerId);
		if (!slot) return;
		if (slot.disposed || (slot.player && slot.player.destroyed)) {
			this.debug(slot, "DROP EVENT", { ...describeEvent(event), reason: slot.disposed ? "disposed" : "player-destroyed" });
			return;
		}
		const trace = traceEvent(event);
		const publicType = this.toPublicEventName(event.type);
		if (!publicType) {
			this.debug(slot, "UNMAPPED BUS EVENT", { ...describeEvent(event), sequence: trace.sequence });
			return;
		}
		const args = this.toArgs(event);
		const previous = slot.recent.get(trace.fingerprint);
		if (previous !== undefined) {
			this.debug(slot, "DUPLICATE PROPAGATION", {
				sequence: trace.sequence,
				previousSequence: previous,
				fingerprint: trace.fingerprint,
				...describeEvent(event),
			});
		}
		slot.recent.set(trace.fingerprint, trace.sequence);
		this.debug(slot, "BUS -> PLAYER", {
			sequence: trace.sequence,
			busEvent: event.type,
			playerEvent: publicType,
			args: this.describeArgs(slot, event, args),
		});
		try {
			slot.player?.emit(publicType, ...args);
			this.emitQueueCompatibilityEvents(slot, event);
			this.debug(slot, "PLAYER EMIT OK", { sequence: trace.sequence, event: publicType });
		} catch (error) {
			this.debug(slot, "PLAYER EMIT ERROR", { sequence: trace.sequence, event: publicType, error });
		}
	}

	private toPublicEventName(type: PlayerEventType): string | null {
		switch (type) {
			case "initialized":
				return "initialized";
			case "ready":
				return "ready";
			case "destroyed":
				return "destroyed";
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
			case "willPlay":
				return "willPlay";
			case "queueEnd":
				return "queueEnd";
			case "playerPause":
				return "playerPause";
			case "playerResume":
				return "playerResume";
			case "playerStop":
				return "playerStop";
			case "seek":
				return "seek";
			case "filterApplied":
				return "filterApplied";
			case "filterRemoved":
				return "filterRemoved";
			case "filtersCleared":
				return "filtersCleared";
			case "streamError":
				return "streamError";
			case "forwardModeStart":
				return "forwardModeStart";
			case "forwardModeEnd":
				return "forwardModeEnd";
			default:
				return null;
		}
	}

	private toArgs(event: PlayerEvent): any[] {
		switch (event.type) {
			case "TRACK_STARTED":
				return [event.track];
			case "TRACK_ERROR":
				return [event.error, event.session.track ?? undefined];
			case "TRACK_END":
				return event.session.track ? [event.session.track] : [];
			case "STUCK_DETECTED":
				return [event.session.track ?? null];
			case "RECOVERY_FAILED":
				return [];
			case "trackRequested":
				return [event.track, event.session];
			case "stateChanged":
				return [event.oldState, event.newState];
			case "queueChanged":
				return [event.queue];
			case "volumeRequested":
				return [event.oldVolume, event.newVolume];
			case "willPlay":
				return [event.track, event.upcomingTracks];
			case "playerPause":
			case "playerResume":
				return [event.track];
			case "seek":
				return [{ track: event.track, position: event.position }];
			case "filterApplied":
			case "filterRemoved":
				return [event.filter];
			case "streamError":
				return [event.error, event.track];
			case "forwardModeStart":
				return [event.leader];
			case "forwardModeEnd":
				return [event.leader, event.reason];
			case "preloadStateChanged":
				return [event.state];
			case "preloadPromoted":
				return [event.track];
			case "preloadCancelled":
				return [];
			case "initialized":
			case "ready":
			case "destroyed":
				return [];
			default:
				return "session" in event && event.session ? [event.session] : [];
		}
	}

	private emitQueueCompatibilityEvents(slot: PlayerEventBridgeSlot, event: PlayerEvent): void {
		if (event.type !== "queueChanged") return;
		const next = event.queue;
		const previous = slot.previousQueue;
		slot.previousQueue = [...next];
		if (next.length > previous.length) {
			const added = next.filter((track) => !previous.some((old) => this.trackIdentity(old) === this.trackIdentity(track)));
			if (added.length === 1) slot.player?.emit("queueAdd", added[0]);
			else if (added.length > 1) slot.player?.emit("queueAddList", added);
		} else if (next.length < previous.length) {
			const removed = previous.filter(
				(track) => !next.some((current) => this.trackIdentity(current) === this.trackIdentity(track)),
			);
			if (removed.length === 1) {
				const track = removed[0];
				slot.player?.emit("queueRemove", track, previous.indexOf(track));
			}
		}
	}

	private trackIdentity(track: any): string | undefined {
		return track?.id ?? track?.url;
	}
	private describeArgs(slot: PlayerEventBridgeSlot, event: PlayerEvent, args: any[]): any {
		if (event.type === "TRACK_ERROR") return { error: event.error?.message, track: event.session.track?.id };
		return args.map((arg) => this.describeDebugArg(slot, arg));
	}
	private describeDebugArg(slot: PlayerEventBridgeSlot, arg: any): any {
		if (arg === slot.player) {
			return { type: "Player", guildId: slot.player?.playerId, destroyed: slot.player?.destroyed ?? false };
		}
		return arg;
	}
	private debug(slot: PlayerEventBridgeSlot, message: string, ...args: any[]): void {
		try {
			slot.eventDebug.bridge(`[PlayerEventBridge:${slot.player?.playerId ?? "unattached"}] ${message}`, ...args);
		} catch {
			/* Debugging must never affect playback/event propagation. */
		}
	}
}
