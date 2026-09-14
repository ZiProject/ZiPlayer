import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext } from "../types";
import type { PlaybackSkipControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Owns manual skip and its autoplay/queue fallback workflow. Talks to sibling
 * playback controllers only through PlayerBus queries/RPCs — never by holding
 * a direct reference to them. */
export class PlaybackSkipController {
	private readonly bus: PlayerBus;
	private readonly nextThroughBus: PlaybackSkipControllerOptions["nextThroughBus"];
	private readonly stopPlayback: PlaybackSkipControllerOptions["stopPlayback"];
	private readonly publishState: PlaybackSkipControllerOptions["publishState"];
	private readonly setWaitingForQueue: PlaybackSkipControllerOptions["setWaitingForQueue"];

	public constructor(options: PlaybackSkipControllerOptions) {
		this.bus = options.bus;
		this.nextThroughBus = options.nextThroughBus;
		this.stopPlayback = options.stopPlayback;
		this.publishState = options.publishState;
		this.setWaitingForQueue = options.setWaitingForQueue;
	}

	private currentSession(): PlaybackSession | null {
		return this.bus.querySync("playbackSessionInternal") ?? null;
	}

	public async skip(context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const oldSession = this.currentSession();
		const from = oldSession?.track ?? null;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		this.bus.requestRpcSync("playback.transitionLock", { active: true });
		try {
			let next = await this.nextThroughBus(true, context);
			if (!next && this.bus.querySync("queueAutoPlay") && oldSession) {
				const candidate = await this.bus.requestRpc(CONTROLLER_RPC.playbackPrepareAutoplay, { session: oldSession, context });
				if (candidate) {
					this.bus.requestRpcSync("queue.willNext", { track: null });
					if (!this.bus.querySync("queueNextTrack")) this.bus.requestRpcSync("queue.addMultiple", { tracks: [candidate] });
					next = await this.nextThroughBus(true, context);
				}
			}
			if (oldSession?.isActive()) {
				this.bus.event({ type: "TRACK_END", session: oldSession.snapshot() });
				oldSession.markEnded();
			}
			if (!next) {
				this.stopPlayback(context.signal);
				this.publishState();
				this.setWaitingForQueue(true);
				this.bus.event({ type: "queueEnd" });
				return;
			}
			this.setWaitingForQueue(false);
			await this.bus.requestRpc(CONTROLLER_RPC.playbackStart, { track: next, context, from });
		} finally {
			this.bus.requestRpcSync("playback.transitionLock", { active: false });
		}
	}
}
