import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlaybackPreparationController } from "./PlaybackPreparationController";
import type { PlaybackStartController } from "./PlaybackStartController";
import type { PlayerMessageContext, Track } from "../types";
import type { PlaybackSkipControllerOptions } from "../types";

/** Owns manual skip and its autoplay/queue fallback workflow. */
export class PlaybackSkipController {
	private readonly bus: PlayerBus;
	private readonly sessionController: PlaybackSessionController;
	private readonly preparationController: PlaybackPreparationController;
	private readonly startController: PlaybackStartController;
	private readonly nextThroughBus: PlaybackSkipControllerOptions["nextThroughBus"];
	private readonly stopPlayback: PlaybackSkipControllerOptions["stopPlayback"];
	private readonly publishState: PlaybackSkipControllerOptions["publishState"];
	private readonly setWaitingForQueue: PlaybackSkipControllerOptions["setWaitingForQueue"];
	private readonly setTrackEndTransition: PlaybackSkipControllerOptions["setTrackEndTransition"];

	public constructor(options: PlaybackSkipControllerOptions) {
		this.bus = options.bus;
		this.sessionController = options.sessionController;
		this.preparationController = options.preparationController;
		this.startController = options.startController;
		this.nextThroughBus = options.nextThroughBus;
		this.stopPlayback = options.stopPlayback;
		this.publishState = options.publishState;
		this.setWaitingForQueue = options.setWaitingForQueue;
		this.setTrackEndTransition = options.setTrackEndTransition;
	}

	public async skip(context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const from = this.sessionController.current?.track ?? null;
		const oldSession = this.sessionController.current;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		this.setTrackEndTransition(true);
		try {
			let next = await this.nextThroughBus(true, context);
			if (!next && this.bus.querySync("queueAutoPlay") && oldSession) {
				const candidate = await this.preparationController.prepareAutoplay(oldSession, context);
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
			await this.startController.start(next, context, from);
		} finally {
			this.setTrackEndTransition(false);
		}
	}
}
