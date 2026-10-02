import type { Bus } from "../structures/Bus";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlayerMessageContext, Track } from "../types";
import { PlaybackMode } from "../types";
import { BUS_EVENT, BUS_REQUEST, CONTROLLER_RPC, PLAYER_QUERY } from "../structures/BusContract";

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
		if (context.signal.aborted) return;
		const mode = bus.querySync(playerId, PLAYER_QUERY.playbackMode);
		if (mode === PlaybackMode.REMOTE) {
			const track = session?.track ?? (bus.querySync(playerId, PLAYER_QUERY.currentTrack) as Track | null);
			if (!track) throw new Error("No current track to seek");
			const duration = track.duration > 1000 ? track.duration : track.duration * 1000;
			if (position < 0 || position > duration) {
				throw new Error(`Invalid seek position: ${position}ms (track duration: ${duration}ms)`);
			}
			await bus.requestRpc(playerId, CONTROLLER_RPC.playbackRemoteSeek, { position });
			if (context.signal.aborted) return;
			bus.event(playerId, { type: BUS_EVENT.seek, track, position });
			return;
		}
		if (!session?.track || !session.ownsContext(context.sessionId)) {
			throw new Error("No current track to seek");
		}
		const duration = session.track.duration > 1000 ? session.track.duration : session.track.duration * 1000;
		if (position < 0 || position > duration) {
			throw new Error(`Invalid seek position: ${position}ms (track duration: ${duration}ms)`);
		}
		try {
			await bus.request(
				playerId,
				{ type: BUS_REQUEST.resourceRefresh, requestId: context.requestId, position },
				{ signal: context.signal, timeoutMs: 65000 },
			);
			if (context.signal.aborted || !this.isCurrent(playerId, session, context)) return;
			bus.event(playerId, { type: BUS_EVENT.seek, track: session.track, position });
		} catch (error) {
			if (!context.signal.aborted && this.isCurrent(playerId, session, context)) {
				bus.event(playerId, {
					type: BUS_EVENT.trackError,
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
			throw error;
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
