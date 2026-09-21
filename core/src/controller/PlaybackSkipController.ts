import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext } from "../types";
import type { PlaybackSkipControllerOptions } from "../types";
import { BUS_EVENT, CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

/** Owns manual skip and its autoplay/queue fallback workflow. Talks to sibling
 * playback controllers only through Bus queries/RPCs — never by holding
 * a direct reference to them. */
export class PlaybackSkipController {
	private readonly bus: Bus;
	private readonly playerId: string;
	private readonly nextThroughBus: PlaybackSkipControllerOptions["nextThroughBus"];
	private readonly stopPlayback: PlaybackSkipControllerOptions["stopPlayback"];
	private readonly publishState: PlaybackSkipControllerOptions["publishState"];
	private readonly setWaitingForQueue: PlaybackSkipControllerOptions["setWaitingForQueue"];

	public constructor(options: PlaybackSkipControllerOptions & { playerId: string }) {
		this.bus = options.bus;
		this.playerId = options.playerId;
		this.nextThroughBus = options.nextThroughBus;
		this.stopPlayback = options.stopPlayback;
		this.publishState = options.publishState;
		this.setWaitingForQueue = options.setWaitingForQueue;
	}

	private currentSession(): PlaybackSession | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playbackSessionInternal) ?? null;
	}

	public async skip(context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const oldSession = this.currentSession();
		const from = oldSession?.track ?? null;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackTransitionLock, { active: true });
		try {
			let next = await this.nextThroughBus(true, context);
			if (!next && this.bus.querySync(this.playerId, PLAYER_QUERY.queueAutoPlay) && oldSession) {
				const candidate = await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackPrepareAutoplay, {
					session: oldSession,
					context,
				});
				if (candidate) {
					this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track: null });
					if (!this.bus.querySync(this.playerId, PLAYER_QUERY.queueNextTrack))
						this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueAddMultiple, { tracks: [candidate] });
					next = await this.nextThroughBus(true, context);
				}
			}
			if (oldSession?.isActive()) {
				this.bus.event(this.playerId, { type: BUS_EVENT.trackEnd, session: oldSession.snapshot() });
				oldSession.markEnded();
			}
			if (!next) {
				this.stopPlayback(context.signal);
				this.publishState();
				this.setWaitingForQueue(true);
				this.bus.event(this.playerId, { type: BUS_EVENT.queueEnd });
				return;
			}
			this.setWaitingForQueue(false);
			await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackStart, { track: next, context, from });
		} finally {
			this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackTransitionLock, { active: false });
		}
	}
}
