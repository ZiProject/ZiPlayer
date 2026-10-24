import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, Track } from "../types";
import type { PlaybackPreparationControllerOptions } from "../types";
import { BUS_EVENT, BUS_REQUEST, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

/**
 * Owns related-track and autoplay preparation after a track starts.
 *
 * Per-player controller instance held by the shared `PlaybackOrchestrator` state for
 * `playerId`. Registers no RPC of its own: `playback.prepareAutoplay` and
 * `playback.createRelatedTracks` are registered once in the orchestrator and routed by
 * `ctx.playerId`.
 */
export class PlaybackPreparationController {
	private readonly playerId: string;
	private readonly bus: Bus;
	private readonly isCurrentSession: PlaybackPreparationControllerOptions["isCurrentSession"];
	private readonly queueSnapshot: PlaybackPreparationControllerOptions["queueSnapshot"];
	private readonly setQueueRelated: PlaybackPreparationControllerOptions["setQueueRelated"];
	private readonly debug: PlaybackPreparationControllerOptions["debug"];

	constructor(playerId: string, options: PlaybackPreparationControllerOptions) {
		this.playerId = playerId;
		this.bus = options.bus;
		this.isCurrentSession = options.isCurrentSession;
		this.queueSnapshot = options.queueSnapshot;
		this.setQueueRelated = options.setQueueRelated;
		this.debug = options.debug;
	}

	public dispose(): void {
		// No module-level registration to release; kept for a uniform per-player lifecycle API.
	}

	public async prepareTrack(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		await this.prepareRelated(session, context);
		await this.prepareAutoplay(session, context);
	}

	/** Regenerates related tracks for the supplied track or the current track. */
	public async createRelatedTracks(track?: Track | null): Promise<Track[]> {
		const previous = (this.bus.querySync(this.playerId, PLAYER_QUERY.previousTracks) as Track[] | null) ?? [];
		const source = track ?? previous.at(-1) ?? this.bus.querySync(this.playerId, PLAYER_QUERY.currentTrack);
		if (!source) {
			this.setQueueRelated([]);
			return [];
		}

		if (!this.bus.hasRpc(PLAYER_RPC.pluginRelatedTracks)) {
			this.setQueueRelated([]);
			return [];
		}

		let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(
			this.playerId,
			PLAYER_RPC.pluginRelatedTracks,
			{
				track: source,
				history: previous,
			},
		);
		related = related ?? [];
		const upcoming = new Set(this.queueSnapshot().map((item) => item.id ?? item.url));
		related = related.filter((item) => item !== source && !upcoming.has(item.id ?? item.url));
		this.setQueueRelated(related);
		return related.slice();
	}

	public async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted || !this.isCurrentSession(session, context)) return null;
		if (this.bus.querySync(this.playerId, PLAYER_QUERY.queueLoop) === "track") {
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track: null });
			return null;
		}

		const queueNext = (this.bus.querySync(this.playerId, PLAYER_QUERY.queueNextTrack) as Track | null) ?? null;
		let related = (this.bus.querySync(this.playerId, PLAYER_QUERY.relatedTracks) as Track[] | null) ?? [];
		if (!related.length && !this.queueSnapshot().length) {
			try {
				related = await this.createRelatedTracks(session.track);
			} catch (error) {
				this.reportStreamError(session.track, error);
				related = [];
			}
		}
		if (!related.length) {
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track: queueNext });
			if (queueNext) {
				this.bus.event(this.playerId, {
					type: BUS_EVENT.willPlay,
					track: queueNext,
					upcomingTracks: this.queueSnapshot(),
					relatedTracks: [],
				});
				await this.requestPreload(queueNext, context);
			}
			return queueNext;
		}
		const pool = related.slice(0, Math.min(5, related.length));
		const next = queueNext ?? pool[Math.floor(Math.random() * pool.length)];
		if (!next || !this.isCurrentSession(session, context)) return null;
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track: next });
		this.bus.event(this.playerId, {
			type: BUS_EVENT.willPlay,
			track: next,
			upcomingTracks: this.queueSnapshot(),
			relatedTracks: related,
		});
		const autoPlayEnabled = Boolean(this.bus.querySync(this.playerId, PLAYER_QUERY.queueAutoPlay));
		if (queueNext || autoPlayEnabled) {
			await this.requestPreload(next, context);
		}
		if (context.signal.aborted || !this.isCurrentSession(session, context)) return null;
		return next;
	}

	private async prepareRelated(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const previousTracks = (this.bus.querySync(this.playerId, PLAYER_QUERY.previousTracks) as Track[] | null) ?? [];
		const source = previousTracks.at(-1) ?? session.track;
		if (!source || context.signal.aborted || !this.isCurrentSession(session, context)) return;
		if (!this.bus.hasRpc(PLAYER_RPC.pluginRelatedTracks)) return;
		try {
			let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(
				this.playerId,
				PLAYER_RPC.pluginRelatedTracks,
				{ track: source, history: previousTracks },
				{ signal: context.signal },
			);
			related = related ?? [];
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			const upcoming = new Set(this.queueSnapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url));
			this.setQueueRelated(related);
		} catch (error) {
			this.debug?.("[PlaybackPreparationController] Error preparing related tracks:", error);
			if (!context.signal.aborted) this.reportStreamError(session.track, error);
		}
	}

	private async requestPreload(track: Track, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		try {
			await this.bus.request(
				this.playerId,
				{ type: BUS_REQUEST.preloadRequest, requestId: context.requestId, track },
				{ signal: context.signal, timeoutMs: 30000 },
			);
		} catch (error) {
			if (!context.signal.aborted) this.reportStreamError(track, error);
		}
	}

	private reportStreamError(track: Track | null, error: unknown): void {
		try {
			this.bus.event(this.playerId, {
				type: BUS_EVENT.streamError,
				error: error instanceof Error ? error : new Error(String(error)),
				track,
			});
		} catch (reportError) {
			console.error("Failed to report playback stream error", reportError);
		}
	}
}
