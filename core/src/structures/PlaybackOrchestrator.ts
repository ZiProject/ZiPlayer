import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import { createPlayerRequestId } from "./PlayerBus";
import type { PlayerMessageContext, Track, SearchResult } from "../types";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "../controller/StreamController";
import type { FilterController } from "../controller/FilterController";
import type { PlaybackController } from "../controller/PlaybackController";
import type { QueueController } from "../controller/QueueController";
import type { TransitionController } from "../controller/TransitionController";
import type { PreloadController } from "../controller/PreloadController";
import type { TTSController } from "../controller/TTSController";

export interface PlaybackOrchestratorOptions {
	trackLoader?: TrackLoader;
	streamController?: StreamController;
	filterController?: FilterController;
	playbackController?: PlaybackController;
	queueController?: QueueController;
	transitionController?: TransitionController;
	preloadController?: PreloadController;
	ttsController?: TTSController;
	searchResolver?: (query: string, requestedBy: string) => Promise<SearchResult | null>;
	relatedTrackResolver?: (track: Track) => Promise<Track[] | null | undefined>;
}

export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private readonly detachAction: () => void;
	private readonly detachTrackEnd: () => void;
	private readonly detachPlayRpc: () => void;
	private readonly detachQueries: Array<() => void> = [];

	constructor(private readonly bus: PlayerBus, private readonly o: PlaybackOrchestratorOptions = {}) {
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c));
		this.detachPlayRpc = bus.registerRpc("play", async (request: { query: string | Track | SearchResult | null; requestedBy?: string }) =>
			this.play(request.query, request.requestedBy ?? "Unknown"),
		);
		this.detachTrackEnd = bus.subscribe("TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			if (!this.session || this.session.id !== session.id) return;
			void this.advanceAfterTrackEnd(session);
		});
		this.detachQueries.push(
			bus.registerQuery("playerState", () => this.session?.status ?? "idle"),
			bus.registerQuery("playbackSession", () => this.session?.snapshot() ?? null),
			bus.registerQuery("position", () => this.session?.position ?? null),
			bus.registerQuery("isPlaying", () => this.session?.status === "playing"),
			bus.registerQuery("isPaused", () => this.session?.status === "paused"),
		);
	}
	get currentSession() { return this.session; }
	get transitionPolicy() { return this.o.transitionController; }
	dispose() { this.detachAction(); this.detachPlayRpc(); this.detachTrackEnd(); for (const d of this.detachQueries) d(); this.session?.destroy(); this.session = null; }

	private async play(query: string | Track | SearchResult | null, requestedBy: string): Promise<boolean> {
		if (query === null) return this.session?.status === "playing" || this.session?.status === "paused" ? true : this.startNext(requestedBy);
		let tracks: Track[];
		try {
			tracks = typeof query === "string"
				? (await this.o.searchResolver?.(query, requestedBy))?.tracks ?? []
				: "tracks" in query ? query.tracks : [query];
		} catch {
			return false;
		}
		if (tracks.length === 0) return false;
		if (tracks.length === 1 && this.o.ttsController?.isTTS(tracks[0])) {
			await this.o.ttsController.play(tracks[0]);
			return true;
		}
		this.o.queueController?.addMultiple(tracks);
		if (this.o.queueController && (this.session?.status === "playing" || this.session?.status === "paused")) {
			if (this.o.preloadController) await this.o.preloadController.preload().catch(() => undefined);
			return true;
		}
		await this.bus.action({ type: "SKIP" });
		return this.bus.query("isPlaying").then((playing) => playing || this.bus.query("currentTrack").then((track) => track !== null));
	}

	private async startNext(_requestedBy: string): Promise<boolean> {
		await this.bus.action({ type: "SKIP" });
		return this.bus.query("isPlaying").then((playing) => playing || this.bus.query("currentTrack").then((track) => track !== null));
	}

	private async handleAction(a: PlayerAction, context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		switch (a.type) {
			case "PLAY": if (a.track) await this.start(a.track, context); break;
			case "SEEK": await this.seek(a.position, context); break;
			case "SKIP": await this.skip(context); break;
			case "PAUSE": {
				const session = this.session;
				if (session?.isActive() && this.matchesContext(session, context) && this.o.playbackController?.pause()) {
					session.markPaused(); this.publishState();
				}
				break;
			}
			case "RESUME": {
				const session = this.session;
				if (session?.isActive() && this.matchesContext(session, context) && this.o.playbackController?.resume()) {
					session.markPlaying(); this.publishState();
				}
				break;
			}
			case "STOP": {
				const session = this.session;
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(context.signal);
				if (session?.isActive()) session.markStopped();
				this.publishState();
				break;
			}
		}
	}

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean { return session.ownsContext(context.sessionId); }
	private childContext(context: PlayerMessageContext, sessionId?: string): PlayerMessageContext { return { requestId: context.requestId, sessionId, source: context.source, signal: context.signal, timestamp: context.timestamp, priority: context.priority }; }
	private stopPlayback(s: AbortSignal) { if (s.aborted) return; this.o.playbackController?.stop(); this.o.trackLoader?.cancelPreload(); }
	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> { if (context.signal.aborted) return null; await this.bus.action({ type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context); return this.bus.query("queueCurrent"); }
	private async setCurrentThroughBus(track: Track | null, context: PlayerMessageContext) { if (context.signal.aborted) return; await this.bus.action({ type: "QUEUE_SET_CURRENT", track, requestId: context.requestId }, context); }
	private async filterStreamThroughBus(streamInfo: NonNullable<Parameters<NonNullable<FilterController["applyFiltersAndSeek"]>>[0]>, position: number, context: PlayerMessageContext) { if (context.signal.aborted) return null; await this.bus.action({ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId }, context); await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: context.requestId }, context); return this.bus.query("filteredStream"); }
	private async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<void> { const queue = this.o.queueController; const source = session.track; if (!queue || !source || context.signal.aborted || !this.matchesContext(session, context) || !this.o.relatedTrackResolver) return; try { let related = await this.o.relatedTrackResolver(source); if (context.signal.aborted || !this.matchesContext(session, context)) return; if (!related?.length) return; const upcoming = new Set(queue.snapshot().map((track) => track.id ?? track.url)); related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url)); if (!related.length || !this.matchesContext(session, context)) return; queue.setRelated(related); const pool = related.slice(0, Math.min(5, related.length)); const next = queue.nextTrack ?? pool[Math.floor(Math.random() * pool.length)]; if (!next || !this.matchesContext(session, context)) return; queue.setWillNext(next); if (!queue.autoPlay) return; if (this.o.preloadController) await this.requestPreload(next, context); } catch (error) { if (!context.signal.aborted && this.matchesContext(session, context)) this.bus.event({ type: "TRACK_ERROR", session: session.snapshot(), error: error instanceof Error ? error : new Error(String(error)) }); } }
	private async advanceAfterTrackEnd(snapshot: ReturnType<PlaybackSession["snapshot"]>) { if (!this.session || this.session.id !== snapshot.id || this.session.status === "ended" || this.session.status === "stopped") return; const next = await this.nextThroughBus(false, { requestId: createPlayerRequestId(), signal: new AbortController().signal, timestamp: Date.now(), priority: 10 }); if (next) await this.start(next, this.childContext({ requestId: createPlayerRequestId(), signal: new AbortController().signal, timestamp: Date.now(), priority: 10 }, this.session.id)); }
	private async start(track: Track, context: PlayerMessageContext): Promise<void> { const session = new PlaybackSession(track, context); this.session?.destroy(); this.session = session; this.bus.event({ type: "TRACK_STARTED", session: session.snapshot(), track }); session.markPlaying(); this.publishState(); await this.prepareAutoplay(session, context); }
	private async seek(_position: number, _context: PlayerMessageContext): Promise<void> {}
	private async skip(context: PlayerMessageContext): Promise<void> { const next = await this.nextThroughBus(false, context); if (next) await this.start(next, context); }
	private async requestPreload(_track: Track, _context: PlayerMessageContext): Promise<void> {}
	private publishState(): void { if (this.session) this.bus.event({ type: "playbackStateChanged", session: this.session.snapshot() }); }
}
