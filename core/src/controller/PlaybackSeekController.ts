import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlayerMessageContext, Track } from "../types";

/** Owns seek validation and resource-refresh coordination for the active session. */
export class PlaybackSeekController {
	public constructor(
		private readonly bus: PlayerBus,
		private readonly sessionController: PlaybackSessionController,
	) {}

	public async seek(position: number, context: PlayerMessageContext): Promise<void> {
		const session = this.sessionController.current;
		if (!session?.track || context.signal.aborted || !session.ownsContext(context.sessionId)) return;
		const duration = session.track.duration > 1000 ? session.track.duration : session.track.duration * 1000;
		if (position < 0 || position > duration) return;
		try {
			await this.bus.request(
				{ type: "[Player]->[Resource]:refresh", requestId: context.requestId, position },
				{ signal: context.signal, timeoutMs: 30000 },
			);
			if (context.signal.aborted || !this.isCurrent(session, context)) return;
			this.bus.event({ type: "seek", track: session.track, position });
		} catch (error) {
			if (!context.signal.aborted && this.isCurrent(session, context)) {
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private isCurrent(
		session: { sessionId: string; track: Track | null; ownsContext: (id?: string) => boolean },
		context: PlayerMessageContext,
	): boolean {
		return this.sessionController.current === session && session.ownsContext(context.sessionId);
	}
}
