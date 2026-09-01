import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import { createPlayerRequestId } from "./PlayerBus";
import type { Track } from "../types";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "../Controller/StreamController";
import type { FilterController } from "../Controller/FilterController";
import type { PlaybackController } from "../Controller/PlaybackController";
import type { QueueController } from "../Controller/QueueController";
import type { TransitionController } from "../Controller/TransitionController";
import type { PreloadController } from "../Controller/PreloadController";

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

	constructor(
		private readonly bus: PlayerBus,
		private readonly o: PlaybackOrchestratorOptions = {},
	) {
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c.signal));
		this.detachTrackEnd = bus.subscribe("TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			if (!this.session || this.session.id !== session.id) return;
			void this.advanceAfterTrackEnd(session);
		});
		this.detachQueries.push(
			bus.registerQuery("currentTrack", () => this.session?.track ?? null),
			bus.registerQuery("queueCurrent", () => this.o.queueController?.current ?? null),
			bus.registerQuery("playerState", () => this.session?.status ?? "idle"),
			bus.registerQuery("queue", () => this.o.queueController?.snapshot() ?? []),
			bus.registerQuery("playbackSession", () => this.session?.snapshot() ?? null),
			bus.registerQuery("position", () => this.session?.position ?? null),
			bus.registerQuery("volume", () => this.o.playbackController?.volumeValue ?? 100),
			bus.registerQuery("isPlaying", () => this.session?.status === "playing"),
			bus.registerQuery("isPaused", () => this.session?.status === "paused"),
		);
	}

	get currentSession() {
		return this.session;
	}
	get transitionPolicy() {
		return this.o.transitionController;
	}

	dispose() {
		this.detachAction();
		this.detachTrackEnd();
		for (const d of this.detachQueries) d();
		this.session?.destroy();
		this.session = null;
	}

	private async handleAction(a: PlayerAction, s: AbortSignal) {
		if (s.aborted) return;
		switch (a.type) {
			case "PLAY":
				if (a.track) await this.start(a.track, s);
				break;
			case "SEEK":
				await this.seek(a.position, s);
				break;
			case "SKIP":
				await this.skip(s);
				break;
			case "PAUSE": {
				const session = this.session;
				if (session?.isActive() && this.o.playbackController?.pause()) {
					session.markPaused();
					this.publishState();
				}
				break;
			}
			case "RESUME": {
				const session = this.session;
				if (session?.isActive() && this.o.playbackController?.resume()) {
					session.markPlaying();
					this.publishState();
				}
				break;
			}
			case "STOP": {
				const session = this.session;
				this.stopPlayback(s);
				if (session?.isActive()) session.markStopped();
				this.publishState();
				break;
			}
			case "SET_VOLUME":
				this.o.playbackController?.setVolume(a.volume);
				break;
		}
	}

	private stopPlayback(s: AbortSignal) {
		if (s.aborted) return;
		this.o.playbackController?.stop();
		this.o.trackLoader?.cancelPreload();
	}

	private async nextThroughBus(ignoreLoop: boolean, s: AbortSignal): Promise<Track | null> {
		if (s.aborted) return null;
		await this.bus.action(
			{ type: "QUEUE_NEXT", ignoreLoop, requestId: createPlayerRequestId() },
			{ signal: s, priority: 50, requestId: createPlayerRequestId() },
		);
		return this.bus.query("queueCurrent");
	}

	private async setCurrentThroughBus(track: Track | null, s: AbortSignal) {
		if (s.aborted) return;
		await this.bus.action(
			{ type: "QUEUE_SET_CURRENT", track, requestId: createPlayerRequestId() },
			{ signal: s, priority: 50, requestId: createPlayerRequestId() },
		);
	}

	private async filterStreamThroughBus(
		streamInfo: NonNullable<Parameters<NonNullable<FilterController["applyFiltersAndSeek"]>>[0]>,
		position: number,
		s: AbortSignal,
	) {
		if (s.aborted) return null;
		await this.bus.action(
			{ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: createPlayerRequestId() },
			{ signal: s, priority: 50, requestId: createPlayerRequestId() },
		);
		await this.bus.action(
			{ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: createPlayerRequestId() },
			{ signal: s, priority: 50, requestId: createPlayerRequestId() },
		);
		return this.bus.query("filteredStream");
	}

	private async prepareAutoplay(session: PlaybackSession, s: AbortSignal): Promise<void> {
		const queue = this.o.queueController;
		const source = session.track;
		if (!queue || !source || s.aborted || !this.session?.owns(session.id)) return;
		if (!this.o.relatedTrackResolver) return;
		try {
			let related = await this.o.relatedTrackResolver(source);
			if (s.aborted || !this.session?.owns(session.id)) return;
			if (!related?.length) return;
			const upcoming = new Set(queue.snapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => {
				const key = track.id ?? track.url;
				return track !== source && !upcoming.has(key);
			});
			if (!related.length || !this.session?.owns(session.id)) return;
			queue.setRelated(related);
			const pool = related.slice(0, Math.min(5, related.length));
			const next = queue.nextTrack ?? pool[Math.floor(Math.random() * pool.length)];
			if (!next || !this.session?.owns(session.id)) return;
			queue.setWillNext(next);
			if (!queue.autoPlay) return;
			if (this.o.preloadController) await this.requestPreload(next, s);
		} catch (error) {
			if (!s.aborted && this.session?.owns(session.id)) {
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private async advanceAfterTrackEnd(snapshot: ReturnType<PlaybackSession["snapshot"]>) {
		if (!this.session || this.session.id !== snapshot.id || this.session.status === "ended" || this.session.status === "stopped")
			return;
		const from = this.session.track;
		const endedSession = this.session;
		endedSession.markEnded();
		this.stopPlayback(endedSession.signal);

		let next = await this.nextThroughBus(false, endedSession.signal);
		if (next) {
			await this.start(next, new AbortController().signal, from);
			return;
		}
		if (this.o.queueController?.autoPlay) {
			next = this.o.queueController.willNext;
			if (next) {
				this.o.queueController.clearWillNext();
				this.o.queueController.add(next);
				const queuedNext = await this.nextThroughBus(false, new AbortController().signal);
				if (queuedNext) {
					await this.start(queuedNext, new AbortController().signal, from);
					return;
				}
			}
		}
		this.publishState();
	}

	private async seek(position: number, s: AbortSignal) {
		const x = this.session;
		if (!x || !x.track || s.aborted) return;
		const duration = x.track.duration > 1000 ? x.track.duration : x.track.duration * 1000;
		if (position < 0 || position > duration) return;
		const sessionId = x.id;
		try {
			await this.bus.request(
				{ type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position },
				{ signal: s, timeoutMs: 30000 },
			);
			if (!this.session?.owns(sessionId)) return;
		} catch (error) {
			if (!s.aborted && this.session?.owns(sessionId))
				this.bus.event({
					type: "TRACK_ERROR",
					session: x.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
		}
	}

	private async skip(s: AbortSignal) {
		if (s.aborted) return;
		const from = this.session?.track ?? null;
		const oldSession = this.session;
		this.stopPlayback(s);
		if (oldSession?.isActive()) {
			oldSession.markEnded();
			this.bus.event({ type: "TRACK_END", session: oldSession.snapshot() });
		}
		this.o.trackLoader?.cancelPreload();
		const next = await this.nextThroughBus(true, s);
		if (next) await this.start(next, s, from);
	}

	private async start(track: Track, s: AbortSignal, from: Track | null = null) {
		if (s.aborted) return;
		const previous = this.session;
		this.stopPlayback(s);
		previous?.markStopped();
		this.o.trackLoader?.resetRecovery(previous?.track ?? undefined);
		const hasPreload = this.o.trackLoader?.hasPreload(track) ?? false;
		if (!hasPreload) this.o.trackLoader?.cancelPreload();
		previous?.destroy();
		const x = new PlaybackSession();
		this.session = x;
		x.begin(track);
		await this.setCurrentThroughBus(track, s);
		if (s.aborted || !this.session?.owns(x.id)) return;
		this.bus.event({ type: "TRACK_LOADING", session: x.snapshot() });
		if (!this.o.trackLoader || !this.o.streamController || !this.o.playbackController) {
			this.bus.publish("playbackSessionCreated", x.snapshot());
			this.bus.publish("trackRequested", track, x);
			return;
		}
		try {
			const loaded = await this.o.trackLoader.loadWithRecovery(track, x);
			if (s.aborted || !this.session?.owns(x.id)) return;
			this.bus.event({ type: "TRACK_LOADED", session: x.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle) {
				await loaded.stream.handle.play();
				if (s.aborted || !this.session?.owns(x.id)) return;
				x.markPlaying();
				this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: loaded.track });
				await this.prepareAutoplay(x, s);
				return;
			}
			let streamInfo = loaded.stream;
			const filterString = await this.bus.query("filterString");
			if (s.aborted || !this.session?.owns(x.id)) return;
			if (filterString) streamInfo = (await this.filterStreamThroughBus(streamInfo, -1, s)) ?? streamInfo;
			if (s.aborted || !this.session?.owns(x.id)) return;
			const active = await this.o.streamController.replace(streamInfo, x);
			if (s.aborted || !this.session?.owns(x.id)) return;
			const resource = this.o.streamController.createResource(active.stream, loaded.track);
			if (s.aborted || !this.session?.owns(x.id)) return;
			x.setResource(resource);
			this.o.playbackController.play(resource, x, from, loaded.track);
			if (s.aborted || !this.session?.owns(x.id)) return;
			x.markPlaying();
			this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: loaded.track });
			await this.prepareAutoplay(x, s);
		} catch (error) {
			if (!x.signal.aborted && !s.aborted && this.session?.owns(x.id))
				this.bus.event({
					type: "TRACK_ERROR",
					session: x.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
		}
	}

	private async requestPreload(track: Track, s: AbortSignal) {
		if (!this.o.preloadController || s.aborted) return;
		try {
			await this.bus.request(
				{ type: "[Player]->[Preload]:request", requestId: createPlayerRequestId(), track },
				{ signal: s, timeoutMs: 30000 },
			);
		} catch {}
	}

	private publishState() {
		if (this.session) this.bus.publish("playbackStateChanged", this.session.snapshot());
	}
}
