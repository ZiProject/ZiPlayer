import type { Bus } from "../structures/Bus";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlayerMessageContext, Track } from "../types";

/** Shared, singleton controller: owns seek validation and resource-refresh coordination
 *  for the active session of whichever player the seek was requested for. */
export class PlaybackSeekController {
	public constructor(
		private readonly bus: Bus,
		private readonly sessionController: PlaybackSessionController,
	) {}

	public async seek(position: number, context: PlayerMessageContext): Promise<void> {
		const { playerId } = context;
		const bus = this.bus;
		const session = this.sessionController.current(playerId);
		if (!session?.track || context.signal.aborted || !session.ownsContext(context.sessionId)) return;
		const duration = session.track.duration > 1000 ? session.track.duration : session.track.duration * 1000;
		if (position < 0 || position > duration) return;
		try {
			await bus.request(
				playerId,
				{ type: "[Player]->[Resource]:refresh", requestId: context.requestId, position },
				{ signal: context.signal, timeoutMs: 30000 },
			);
			if (context.signal.aborted || !this.isCurrent(playerId, session, context)) return;
			bus.event(playerId, { type: "seek", track: session.track, position });
		} catch (error) {
			if (!context.signal.aborted && this.isCurrent(playerId, session, context)) {
				bus.event(playerId, {
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private isCurrent(
		playerId: string,
		session: { sessionId: string; track: Track | null; ownsContext: (id?: string) => boolean },
		context: PlayerMessageContext,
	): boolean {
		return this.sessionController.current(playerId) === session && session.ownsContext(context.sessionId);
	}
}
