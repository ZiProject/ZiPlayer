import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import { createPlayerRequestId } from "./PlayerBus";
import type { PlayerMessageContext, Track } from "../types";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "../controller/StreamController";
import type { FilterController } from "../controller/FilterController";
import type { PlaybackController } from "../controller/PlaybackController";
import type { QueueController } from "../controller/QueueController";
import type { TransitionController } from "../controller/TransitionController";
import type { PreloadController } from "../controller/PreloadController";

export interface PlaybackOrchestratorOptions {
	trackLoader?: TrackLoader;
	streamController?: StreamController;
	filterController?: FilterController;
	playbackController?: PlaybackController;
	queueController?: QueueController;
	transitionController?: TransitionController;
	preloadController?: PreloadController;
	relatedTrackResolver?: (track: Track) => Promise<Track[] | null | undefined>;
}

export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private readonly detachAction: () => void;
	private readonly detachTrackEnd: () => void;
	private readonly detachQueries: Array<() => void> = [];

	constructor(private readonly bus: PlayerBus, private readonly o: PlaybackOrchestratorOptions = {}) {
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c));
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
	dispose() { this.detachAction(); this.detachTrackEnd(); for (const d of this.detachQueries) d(); this.session?.destroy(); this.session = null; }

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

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return session.ownsContext(context.sessionId);
	}

	private childContext(context: PlayerMessageContext, sessionId?: string): PlayerMessageContext {
		return {
			requestId: context.requestId,
			sessionId,
			source: context.source,
			signal: context.signal,
			timestamp: context.timestamp,
			priority: context.priority,
		};
	}

	private stopPlayback(s: AbortSignal) { if (s.aborted) return; this.o.playbackController?.stop(); this.o.trackLoader?.cancelPreload(); }

	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		await this.bus.action({ type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		return this.bus.query("queueCurrent");
	}

	private async setCurrentThroughBus(track: Track | null, context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		await this.bus.action({ type: "QUEUE_SET_CURRENT", track, requestId: context.requestId }, context);
	}

	private async filterStreamThroughBus(streamInfo: NonNullable<Parameters<NonNullable<FilterController["applyFiltersAndSeek"]>>[0]>, position: number, context: PlayerMessageContext) {
		if (context.signal.aborted) return null;
		await this.bus.action({ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId }, context);
		await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: context.requestId }, context);
		return this.bus.query("filteredStream");
	}

	private async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const queue = this.o.queueController;
		const source = session.track;
		if (!queue || !source || context.signal.aborted || !this.matchesContext(session, context) || !this.o.relatedTrackResolver) return;
		try {
			let related = await this.o.relatedTrackResolver(source);
			if (context.signal.aborted || !this.matchesContext(session, context)) return;
			if (!related?.length) return;
			const upcoming = new Set(queue.snapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url));
			if (!related.length || !this.matchesContext(session, context)) return;
			queue.setRelated(related);
			const pool = related.slice(0, Math.min(5, related.length));
			const next = queue.nextTrack ?? pool[Math.floor(Math.random() * pool.length)];
			if (!next || !this.matchesContext(session, context)) return;
			queue.setWillNext(next);
			if (!queue.autoPlay) return;
			if (this.o.preloadController) await this.requestPreload(next, context);
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(session, context)) this.bus.event({ type: "TRACK_ERROR", session: session.snapshot(), error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	private async advanceAfterTrackEnd(snapshot: ReturnType<PlaybackSession["snapshot"]>) {
		if (!this.session || this.session.id !== snapshot.id || this.session.status === "ended" || this.session.status === "stopped") return;
		const from = this.session.track;
		const endedSession = this.session;
		const context: PlayerMessageContext = {
			requestId: createPlayerRequestId(),
			sessionId: endedSession.sessionId,
			source: "PlaybackOrchestrator:track-end",
			signal: endedSession.signal,
			timestamp: Date.now(),
			priority: 50,
		};
		endedSession.markEnded();
		this.o.trackLoader?.cancelPreload();
		let next = await this.nextThroughBus(false, context);
		if (next) { await this.start(next, context, from); return; }
		if (this.o.queueController?.autoPlay) {
			next = this.o.queueController.willNext;
			if (next) {
				this.o.queueController.clearWillNext();
				this.o.queueController.add(next);
				const queuedNext = await this.nextThroughBus(false, context);
				if (queuedNext) { await this.start(queuedNext, context, from); return; }
			}
		}
		this.stopPlayback(context.signal);
		this.publishState();
	}

	private async seek(position: number, context: PlayerMessageContext) {
		const x = this.session;
		if (!x || !x.track || context.signal.aborted || !this.matchesContext(x, context)) return;
		const duration = x.track.duration > 1000 ? x.track.duration : x.track.duration * 1000;
		if (position < 0 || position > duration) return;
		try {
			await this.bus.request({ type: "[Player]->[Resource]:refresh", requestId: context.requestId, position }, { signal: context.signal, timeoutMs: 30000 });
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(x, context)) this.bus.event({ type: "TRACK_ERROR", session: x.snapshot(), error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	private async skip(context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		const from = this.session?.track ?? null;
		const oldSession = this.session;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		const next = await this.nextThroughBus(true, context);
		if (oldSession?.isActive()) { oldSession.markEnded(); this.bus.event({ type: "TRACK_END", session: oldSession.snapshot() }); }
		this.o.trackLoader?.cancelPreload();
		if (next) await this.start(next, context, from);
		else this.stopPlayback(context.signal);
	}

	private async start(track: Track, parentContext: PlayerMessageContext, from: Track | null = null) {
		if (parentContext.signal.aborted) return;
		const previous = this.session;
		const transition = from && this.o.transitionController?.plan(from, track);
		if (!transition?.enabled) this.stopPlayback(parentContext.signal);
		previous?.markStopped();
		this.o.trackLoader?.resetRecovery(previous?.track ?? undefined);
		const hasPreload = this.o.trackLoader?.hasPreload(track) ?? false;
		if (!hasPreload) this.o.trackLoader?.cancelPreload();
		previous?.destroy();
		const x = new PlaybackSession();
		this.session = x;
		x.begin(track);
		const context = this.childContext(parentContext, x.sessionId);
		await this.setCurrentThroughBus(track, context);
		if (context.signal.aborted || !this.matchesContext(x, context)) return;
		this.bus.event({ type: "TRACK_LOADING", session: x.snapshot() });
		if (!this.o.trackLoader || !this.o.streamController || !this.o.playbackController) { this.bus.publish("playbackSessionCreated", x.snapshot()); this.bus.publish("trackRequested", track, x.snapshot()); return; }
		try {
			const loaded = await this.o.trackLoader.loadWithRecovery(track, x);
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			this.bus.event({ type: "TRACK_LOADED", session: x.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle) {
				await loaded.stream.handle.play();
				if (context.signal.aborted || !this.matchesContext(x, context)) return;
				x.markPlaying();
				this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: loaded.track });
				await this.prepareAutoplay(x, context);
				return;
			}
			let streamInfo = loaded.stream;
			const filterString = await this.bus.query("filterString");
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			if (filterString) streamInfo = (await this.filterStreamThroughBus(streamInfo, -1, context)) ?? streamInfo;
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			const active = await this.o.streamController.replace(streamInfo, x);
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			const resource = this.o.streamController.createResource(active.stream, loaded.track, active.inputType);
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			x.setResource(resource);
			this.o.playbackController.play(resource, x, from, loaded.track);
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			x.markPlaying();
			this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: loaded.track });
			await this.prepareAutoplay(x, context);
		} catch (error) {
			if (!x.signal.aborted && !context.signal.aborted && this.matchesContext(x, context)) this.bus.event({ type: "TRACK_ERROR", session: x.snapshot(), error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	private async requestPreload(track: Track, context: PlayerMessageContext) {
		if (!this.o.preloadController || context.signal.aborted) return;
		try { await this.bus.request({ type: "[Player]->[Preload]:request", requestId: context.requestId, track }, { signal: context.signal, timeoutMs: 30000 }); } catch {}
	}
	private publishState() { if (this.session) this.bus.publish("playbackStateChanged", this.session.snapshot()); }
}
