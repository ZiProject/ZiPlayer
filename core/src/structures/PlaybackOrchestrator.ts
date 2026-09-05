import type { PlayerBus, PlayerAction, PlayerBusRpcContext } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import { createPlayerRequestId } from "./PlayerBus";
import { PlayerActionPriority } from "../types";
import type { AudioResource } from "@discordjs/voice";
import type { PlayerMessageContext, PlaybackSessionSnapshot, SearchResult, StreamInfo, Track, TrackLoadResult } from "../types";
import type { Player } from "./Player";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "../controller/StreamController";
import type { FilterController } from "../controller/FilterController";
import type { PlaybackController } from "../controller/PlaybackController";
import type { QueueController } from "../controller/QueueController";
import type { TransitionController } from "../controller/TransitionController";
import type { PreloadController } from "../controller/PreloadController";
import type { TTSController } from "../controller/TTSController";
import type { PromotedPreload } from "./PreloadManager";

export interface PlaybackOrchestratorOptions {
	player?: Player;
	trackLoader?: TrackLoader;
	streamController?: StreamController;
	filterController?: FilterController;
	playbackController?: PlaybackController;
	queueController?: QueueController;
	transitionController?: TransitionController;
	preloadController?: PreloadController;
	ttsController?: TTSController;
	relatedTrackResolver?: (track: Track) => Promise<Track[] | null | undefined>;
}

export class PlaybackOrchestrator {
	private session: PlaybackSession | null = null;
	private autoplayPreparation: Promise<void> | null = null;
	private readonly detachAction: () => void;
	private readonly detachTrackEnd: () => void;
	private readonly detachQueries: Array<() => void> = [];
	private readonly detachRpcs: Array<() => void> = [];

	constructor(
		private readonly bus: PlayerBus,
		private readonly o: PlaybackOrchestratorOptions = {},
	) {
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c));
		this.detachTrackEnd = bus.subscribe("TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			if (!this.session || this.session.id !== session.id) return;
			void this.advanceAfterTrackEnd(session);
		});
		this.detachRpcs.push(
			bus.registerRpc<{ query: string | Track | SearchResult | null; requestedBy?: string }, boolean>(
				"play",
				(request, context) => this.play(request.query, request.requestedBy, context),
			),
			bus.registerRpc<void, void>("playback.destroyCurrentStream", () => this.stopPlayback(new AbortController().signal)),
			bus.registerRpc<{ track: Track; session: PlaybackSession }, unknown>("playback.recover", ({ track, session }) =>
				this.o.trackLoader?.loadWithRecovery(track, session),
			),
			bus.registerRpc<{ track: Track; session: PlaybackSession }, unknown>("playback.loadFresh", ({ track, session }) =>
				this.o.trackLoader?.load(track, session),
			),
			bus.registerRpc<{ track: Track; stream: { handle?: { play?: () => void | Promise<void> } } }, boolean>(
				"playback.remote",
				async ({ stream }) => {
					if (stream?.handle?.play) await stream.handle.play();
					return true;
				},
			),
			bus.registerRpc<{ position: number }, PlaybackSessionSnapshot>("playback.refreshResource", ({ position }, context) =>
				this.refreshResource(position, context),
			),
			bus.registerRpc<{ track: Track }, TrackLoadResult | null>("playback.loadFreshCurrent", ({ track }) => {
				if (!this.session) return null;
				return this.o.trackLoader?.load(track, this.session) ?? null;
			}),
			bus.registerRpc<{ track: Track }, AudioResource | null>("playback.promotePreload", ({ track }) => {
				const session = this.session;
				if (!session) return null;
				const promoted = this.bus.requestRpcSync<{ track: Track }, PromotedPreload | null>("preload.promote", { track });
				if (!promoted) return null;
				const resource = this.bus.requestRpcSync("resource.create", {
					stream: promoted.stream as import("stream").Readable,
					track: promoted.track,
				});
				session.setResource(resource);
				this.o.playbackController?.play(resource, session);
				session.markPlaying(0);
				this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
				return resource;
			}),
		);
		this.detachQueries.push(
			bus.registerQuery("playerState", () => this.session?.status ?? "idle"),
			bus.registerQuery("playbackSession", () => this.session?.snapshot() ?? null),
			bus.registerQuery("position", () => this.session?.position ?? null),
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
	private isCurrentSession(sessionId: number): boolean {
		return !!this.session && this.session.owns(sessionId);
	}
	private async refreshResource(position: number, rpcContext: PlayerBusRpcContext): Promise<PlaybackSessionSnapshot> {
		const session = this.session;
		if (!session?.track || !session.isActive()) throw new Error("No active playback session");
		const sessionId = session.id;
		const info = await this.bus.requestRpc<{ track: Track }, StreamInfo | null>(
			"stream.resolve",
			{ track: session.track },
			{
				signal: rpcContext.signal,
			},
		);
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed during resource refresh");
		if (!info?.stream && !info?.url) throw new Error("No stream available for resource refresh");
		if (info.remote) throw new Error("Cannot refresh a remote playback resource");
		await this.bus.action(
			{ type: "FILTER_SET_SOURCE_TYPE", streamType: info.type ?? "arbitrary" },
			{
				signal: rpcContext.signal,
			},
		);
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter source update");
		await this.bus.action(
			{
				type: "FILTER_APPLY_AND_SEEK",
				streamInfo: info,
				position: Math.max(0, position),
			},
			{ signal: rpcContext.signal },
		);
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after filter seek");
		const processed = await this.bus.query("filteredStream");
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed while reading filtered stream");
		if (!processed || !this.o.streamController || !this.o.playbackController)
			throw new Error("Playback resource controllers are unavailable");
		const active = await this.o.streamController.replace(processed, session);
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed after stream replacement");
		const resource = this.bus.requestRpcSync<
			{ stream: import("stream").Readable; track: Track },
			import("@discordjs/voice").AudioResource
		>("resource.create", { stream: active.stream, track: session.track });
		if (!this.isCurrentSession(sessionId)) throw new Error("Playback session changed before resource activation");
		session.setResource(resource);
		this.o.playbackController.play(resource, session);
		session.markPlaying(Math.max(0, position));
		this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
		return session.snapshot();
	}
	dispose() {
		this.detachAction();
		this.detachTrackEnd();
		for (const d of this.detachQueries) d();
		for (const d of this.detachRpcs) d();
		this.session?.destroy();
		this.session = null;
		this.autoplayPreparation = null;
	}

	private async play(
		query: string | Track | SearchResult | null,
		requestedBy: string | undefined,
		rpcContext: PlayerBusRpcContext,
	): Promise<boolean> {
		const player = this.o.player;
		if (!player || player.destroyed || rpcContext.signal.aborted) return false;
		const context: PlayerMessageContext = {
			requestId: rpcContext.requestId,
			source: "PlaybackOrchestrator:play",
			signal: rpcContext.signal,
			timestamp: rpcContext.timestamp,
			priority: PlayerActionPriority.NORMAL,
		};
		if (query === null) {
			if (this.session?.status === "playing" || this.session?.status === "paused") return true;
			await this.skip(context);
			return this.session?.track !== null && this.session?.track !== undefined;
		}
		let tracks: Track[];
		try {
			tracks =
				typeof query === "string" ?
					(
						await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>("search", {
							query,
							requestedBy: requestedBy || "Unknown",
						})
					).tracks
				: "tracks" in query ? query.tracks
				: [query];
		} catch (error) {
			player.debug("[Player] Play search error:", error);
			player.emit("playerError", error as Error);
			return false;
		}
		if (tracks.length === 0 || rpcContext.signal.aborted) return false;
		if (tracks.length === 1 && player.options.tts?.interrupt !== false && this.o.ttsController?.isTTS(tracks[0])) {
			await this.o.ttsController.play(tracks[0]);
			return true;
		}
		await this.bus.requestRpc("queue.addMultiple", { tracks }, { signal: rpcContext.signal });
		if (this.session?.status === "playing" || this.session?.status === "paused") {
			void this.o.preloadController?.preload().catch((error) => player.debug("[Player] Preload after queue add error:", error));
			return true;
		}
		await this.skip(context);
		return this.session?.track !== null && this.session?.track !== undefined;
	}

	private async handleAction(a: PlayerAction, context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		switch (a.type) {
			case "PLAY":
				if (a.track) await this.start(a.track, context);
				break;
			case "SEEK":
				await this.seek(a.position, context);
				break;
			case "SKIP":
				await this.skip(context);
				break;
			case "PAUSE": {
				const session = this.session;
				if (session?.isActive() && this.matchesContext(session, context) && this.o.playbackController?.pause()) {
					session.markPaused();
					this.publishState();
				}
				break;
			}
			case "RESUME": {
				const session = this.session;
				if (session?.isActive() && this.matchesContext(session, context) && this.o.playbackController?.resume()) {
					session.markPlaying();
					this.publishState();
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

	private childContext(context: PlayerMessageContext, sessionId?: string, sessionSignal?: AbortSignal): PlayerMessageContext {
		return {
			requestId: context.requestId,
			sessionId,
			source: context.source,
			signal: sessionSignal ? AbortSignal.any([context.signal, sessionSignal]) : context.signal,
			timestamp: context.timestamp,
			priority: context.priority,
		};
	}

	private stopPlayback(s: AbortSignal, cancelPreload = true) {
		if (s.aborted) return;
		this.o.playbackController?.stop();
		if (cancelPreload) this.o.trackLoader?.cancelPreload();
	}

	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		await this.bus.action({ type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		return this.bus.query("queueCurrent");
	}

	private async setCurrentThroughBus(track: Track | null, context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		await this.bus.action({ type: "QUEUE_SET_CURRENT", track, requestId: context.requestId }, context);
	}

	private async filterStreamThroughBus(
		streamInfo: NonNullable<Parameters<NonNullable<FilterController["applyFiltersAndSeek"]>>[0]>,
		position: number,
		context: PlayerMessageContext,
	) {
		if (context.signal.aborted) return null;
		await this.bus.action(
			{ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId },
			context,
		);
		await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: context.requestId }, context);
		return this.bus.query("filteredStream");
	}

	private async prepareRelated(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const queue = this.o.queueController;
		const source = session.track;
		if (!queue || !source || context.signal.aborted || !this.matchesContext(session, context) || !this.o.relatedTrackResolver)
			return;
		try {
			let related = (await this.o.relatedTrackResolver(source)) ?? [];
			if (context.signal.aborted || !this.matchesContext(session, context)) return;
			const upcoming = new Set(queue.snapshot().map((track) => track.id ?? track.url));
			related = related.filter((track) => track !== source && !upcoming.has(track.id ?? track.url));
			queue.setRelated(related);
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(session, context))
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
		}
	}

	private async prepareAutoplay(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		const queue = this.o.queueController;
		if (!queue?.autoPlay || context.signal.aborted || !this.matchesContext(session, context)) return;
		if (queue.loop === "track") {
			queue.clearWillNext();
			return;
		}
		const related = queue.relatedTracks;
		if (!related.length) return;
		const pool = related.slice(0, Math.min(5, related.length));
		const next = queue.nextTrack ?? pool[Math.floor(Math.random() * pool.length)];
		if (!next || !this.matchesContext(session, context)) return;
		queue.setWillNext(next);
		if (this.o.preloadController) await this.requestPreload(next, context);
	}

	private async prepareTrack(session: PlaybackSession, context: PlayerMessageContext): Promise<void> {
		await this.prepareRelated(session, context);
		if (this.o.queueController?.autoPlay) await this.prepareAutoplay(session, context);
	}

	private async advanceAfterTrackEnd(snapshot: ReturnType<PlaybackSession["snapshot"]>) {
		if (!this.session || this.session.id !== snapshot.id || this.session.status === "ended" || this.session.status === "stopped")
			return;
		await this.autoplayPreparation;
		if (!this.session || this.session.id !== snapshot.id || !this.session.isActive()) return;
		const from = this.session.track;
		const endedSession = this.session;
		const context: PlayerMessageContext = {
			requestId: createPlayerRequestId(),
			source: "PlaybackOrchestrator:track-end",
			signal: new AbortController().signal,
			timestamp: Date.now(),
			priority: 50,
		};
		if (this.o.queueController?.autoPlay && !this.o.queueController.willNext) {
			const autoplayPreparation = this.prepareAutoplay(endedSession, context);
			this.autoplayPreparation = autoplayPreparation;
			await autoplayPreparation;
			if (this.autoplayPreparation === autoplayPreparation) this.autoplayPreparation = null;
		}
		endedSession.markEnded();
		let next = await this.nextThroughBus(false, context);
		if (next) {
			await this.start(next, context, from);
			return;
		}
		if (this.o.queueController?.autoPlay) {
			next = this.o.queueController.willNext;
			if (next) {
				this.o.queueController.clearWillNext();
				this.o.queueController.add(next);
				const queuedNext = await this.nextThroughBus(false, context);
				if (queuedNext) {
					await this.start(queuedNext, context, from);
					return;
				}
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
			await this.bus.request(
				{ type: "[Player]->[Resource]:refresh", requestId: context.requestId, position },
				{ signal: context.signal, timeoutMs: 30000 },
			);
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(x, context))
				this.bus.event({
					type: "TRACK_ERROR",
					session: x.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
		}
	}

	private async skip(context: PlayerMessageContext) {
		if (context.signal.aborted) return;
		const from = this.session?.track ?? null;
		const oldSession = this.session;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		const next = await this.nextThroughBus(true, context);
		if (!next) {
			this.stopPlayback(context.signal);
			this.publishState();
			return;
		}
		await this.start(next, context, from);
	}

	private async start(track: Track, parentContext: PlayerMessageContext, from: Track | null = null) {
		if (parentContext.signal.aborted) return;
		const hasPreload = this.o.preloadController?.has(track) ?? false;
		if (!this.o.transitionController?.enabled) this.stopPlayback(parentContext.signal, !hasPreload);
		if (this.session) {
			this.session.markStopped();
			this.session.destroy();
		}
		this.o.trackLoader?.resetRecovery();
		const preload = this.o.preloadController?.peek(track);
		this.session = new PlaybackSession();
		const x = this.session;
		x.begin(track);
		const context = this.childContext(parentContext, x.sessionId, x.signal);
		await this.setCurrentThroughBus(track, context);
		this.bus.event({ type: "TRACK_LOADING", session: x.snapshot() });
		try {
			const loaded = preload ?? (await this.o.trackLoader?.loadWithRecovery(track, x));
			if (!loaded) throw new Error("Track loader is unavailable");
			if (context.signal.aborted || !this.matchesContext(x, context)) return;
			this.bus.event({ type: "TRACK_LOADED", session: x.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle?.play) {
				x.setResource(null);
				await loaded.stream.handle.play();
				x.markPlaying(0);
				const autoplayPreparation = this.prepareTrack(x, context);
				this.autoplayPreparation = autoplayPreparation;
				this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: track ?? x.snapshot().track });
				await autoplayPreparation;
				if (this.autoplayPreparation === autoplayPreparation) this.autoplayPreparation = null;
				return;
			}
			const filterString = await this.bus.query("filterString");
			let activeStream = loaded.stream;
			if (filterString && this.o.filterController) {
				const filtered = await this.filterStreamThroughBus(loaded.stream, 0, context);
				if (!filtered?.stream) throw new Error("Filter controller produced no stream");
				activeStream = filtered;
			}
			const resource = this.bus.requestRpcSync<
				{ stream: import("stream").Readable; track: Track },
				import("@discordjs/voice").AudioResource
			>("resource.create", { stream: activeStream.stream as import("stream").Readable, track });
			x.setResource(resource);
			this.o.playbackController?.play(resource, x);
			x.markPlaying(0);
			const autoplayPreparation = this.prepareTrack(x, context);
			this.autoplayPreparation = autoplayPreparation;
			this.bus.event({ type: "TRACK_STARTED", session: x.snapshot(), track: track ?? x.snapshot().track });
			await autoplayPreparation;
			if (this.autoplayPreparation === autoplayPreparation) this.autoplayPreparation = null;
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(x, context)) {
				this.bus.event({
					type: "TRACK_ERROR",
					session: x.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private async requestPreload(track: Track, context: PlayerMessageContext) {
		if (!this.o.preloadController || context.signal.aborted) return;
		try {
			await this.bus.request(
				{ type: "[Player]->[Preload]:request", requestId: context.requestId, track },
				{ signal: context.signal, timeoutMs: 30000 },
			);
		} catch {}
	}

	private publishState() {
		this.bus.event({ type: "playbackStateChanged", session: this.session?.snapshot() ?? null });
	}
}
