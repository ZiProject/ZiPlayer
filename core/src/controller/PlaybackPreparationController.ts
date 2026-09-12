import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, Track } from "../types";
import type { PlaybackPreparationControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Owns related-track and autoplay preparation after a track starts. */
export class PlaybackPreparationController {
	private readonly bus: PlayerBus;
	private readonly isCurrentSession: PlaybackPreparationControllerOptions["isCurrentSession"];
	private readonly queueSnapshot: PlaybackPreparationControllerOptions["queueSnapshot"];
	private readonly setQueueRelated: PlaybackPreparationControllerOptions["setQueueRelated"];
	private readonly detachRpc: () => void;
	private readonly detachRelatedRpc: () => void;

	constructor(options: PlaybackPreparationControllerOptions) {
		this.bus = options.bus;
		this.isCurrentSession = options.isCurrentSession;
		this.queueSnapshot = options.queueSnapshot;
		this.setQueueRelated = options.setQueueRelated;
		this.detachRpc = this.bus.registerRpc<{ session: PlaybackSession; context: PlayerMessageContext }, Promise<Track | null>>(
			CONTROLLER_RPC.playbackPrepareAutoplay,
			({ session, context }) => this.prepareAutoplay(session, context),
		);
		this.detachRelatedRpc = this.bus.registerRpc<{ track?: Track | null }, Promise<Track[]>>(
			CONTROLLER_RPC.playbackCreateRelatedTracks,
			({ track }) => this.createRelatedTracks(track),
		);
	}

	public dispose(): void {
		this.detachRpc();
		this.detachRelatedRpc();
	}

	public async prepareTrack(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		await this.prepareRelated(session, context);
		if (this.bus.querySync("queueAutoPlay")) await this.prepareAutoplay(session, context);
	}

	/** Regenerates related tracks for the supplied track or the current track. */
	public async createRelatedTracks(track?: Track | null): Promise<Track[]> {
		const source = track ?? this.bus.querySync("currentTrack");
		if (!source) {
			this.setQueueRelated([]);
			return [];
		}

		let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(
			"plugin.relatedTracks",
			{ track: source, history: this.bus.querySync("previousTracks") },
		);
		related = related ?? [];
		const upcoming = new Set(this.queueSnapshot().map((item) => item.id ?? item.url));
		related = related.filter((item) => item !== source && !upcoming.has(item.id ?? item.url));
		this.setQueueRelated(related);
		return related.slice();
	}

	public async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<Track | null> {
		if (!this.bus.querySync("queueAutoPlay") || context.signal.aborted || !this.isCurrentSession(session, context)) return null;
		if (this.bus.querySync("queueLoop") === "track") {
			this.bus.requestRpcSync("queue.willNext", { track: null });
			return null;
		}
		const related = (this.bus.querySync("relatedTracks") as Track[] | null) ?? [];
		if (!related.length) return null;
		const pool = related.slice(0, Math.min(5, related.length));
		const next = (this.bus.querySync("queueNextTrack") as Track | null) ?? pool[Math.floor(Math.random() * pool.length)];
		if (!next || !this.isCurrentSession(session, context)) return null;
		await this.requestPreload(next, context);
		if (context.signal.aborted || !this.isCurrentSession(session, context)) return null;
		this.bus.requestRpcSync("queue.willNext", { track: next });
		return next;
	}

	private async prepareRelated(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const source = session.track;
		if (!source || context.signal.aborted || !this.isCurrentSession(session, context)) return;
		try {
			let related = await this.bus.requestRpc<{ track: Track; history?: Track[] }, Track[]>(
				"plugin.relatedTracks",
				{ track: source, history: this.bus.querySync("previousTracks") },
				{ signal: context.signal },
			);
			related = related ?? [];
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			const upcoming = new Set(this.queueSnapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url));
			this.setQueueRelated(related);
		} catch (error) {
			if (!context.signal.aborted && this.isCurrentSession(session, context)) {
				this.bus.event({
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
				{ type: "[Player]->[Preload]:request", requestId: context.requestId, track },
				{ signal: context.signal, timeoutMs: 30000 },
			);
		} catch {}
	}
}
