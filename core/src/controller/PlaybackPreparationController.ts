import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, Track } from "../types";
import type { PlaybackPreparationControllerOptions } from "../types";

/**
 * Owns related-track and autoplay preparation after a track starts.
 *
 * Per-player worker — created by the shared `PlaybackOrchestrator` in `attach(playerId, ...)`
 * and discarded in `detach(playerId)`. Registers no RPC of its own: `playback.prepareAutoplay`
 * and `playback.createRelatedTracks` are registered exactly once, in `PlaybackOrchestrator`'s
 * constructor, and routed to the right worker via `ctx.playerId`.
 */
export class PlaybackPreparationController {
	private readonly playerId: string;
	private readonly bus: Bus;
	private readonly isCurrentSession: PlaybackPreparationControllerOptions["isCurrentSession"];
	private readonly queueSnapshot: PlaybackPreparationControllerOptions["queueSnapshot"];
	private readonly setQueueRelated: PlaybackPreparationControllerOptions["setQueueRelated"];

	constructor(playerId: string, options: PlaybackPreparationControllerOptions) {
		this.playerId = playerId;
		this.bus = options.bus;
		this.isCurrentSession = options.isCurrentSession;
		this.queueSnapshot = options.queueSnapshot;
		this.setQueueRelated = options.setQueueRelated;
	}

	public dispose(): void {
		// No module-level registration to release; kept for a uniform worker lifecycle API.
	}

	public async prepareTrack(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		await this.prepareRelated(session, context);
		if (this.bus.querySync(this.playerId, "queueAutoPlay")) await this.prepareAutoplay(session, context);
	}

	/** Regenerates related tracks for the supplied track or the current track. */
	public async createRelatedTracks(track?: Track | null): Promise<Track[]> {
		const source = track ?? this.bus.querySync(this.playerId, "currentTrack");
		if (!source) {
			this.setQueueRelated([]);
			return [];
		}

		let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(this.playerId, "plugin.relatedTracks", {
			track: source,
			history: this.bus.querySync(this.playerId, "previousTracks"),
		});
		related = related ?? [];
		const upcoming = new Set(this.queueSnapshot().map((item) => item.id ?? item.url));
		related = related.filter((item) => item !== source && !upcoming.has(item.id ?? item.url));
		this.setQueueRelated(related);
		return related.slice();
	}

	public async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<Track | null> {
		if (!this.bus.querySync(this.playerId, "queueAutoPlay") || context.signal.aborted || !this.isCurrentSession(session, context))
			return null;
		if (this.bus.querySync(this.playerId, "queueLoop") === "track") {
			this.bus.requestRpcSync(this.playerId, "queue.willNext", { track: null });
			return null;
		}
		const related = (this.bus.querySync(this.playerId, "relatedTracks") as Track[] | null) ?? [];
		if (!related.length) return null;
		const pool = related.slice(0, Math.min(5, related.length));
		const next =
			(this.bus.querySync(this.playerId, "queueNextTrack") as Track | null) ?? pool[Math.floor(Math.random() * pool.length)];
		if (!next || !this.isCurrentSession(session, context)) return null;
		await this.requestPreload(next, context);
		if (context.signal.aborted || !this.isCurrentSession(session, context)) return null;
		this.bus.requestRpcSync(this.playerId, "queue.willNext", { track: next });
		return next;
	}

	private async prepareRelated(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const source = session.track;
		if (!source || context.signal.aborted || !this.isCurrentSession(session, context)) return;
		try {
			let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(
				this.playerId,
				"plugin.relatedTracks",
				{ track: source, history: this.bus.querySync(this.playerId, "previousTracks") },
				{ signal: context.signal },
			);
			related = related ?? [];
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			const upcoming = new Set(this.queueSnapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url));
			this.setQueueRelated(related);
		} catch (error) {
			if (!context.signal.aborted && this.isCurrentSession(session, context)) {
				this.bus.event(this.playerId, {
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private async requestPreload(track: Track, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		try {
			await this.bus.request(
				this.playerId,
				{ type: "[Player]->[Preload]:request", requestId: context.requestId, track },
				{ signal: context.signal, timeoutMs: 30000 },
			);
		} catch {}
	}
}
