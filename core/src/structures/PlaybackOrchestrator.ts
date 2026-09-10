import type { PlayerBus, PlayerAction } from "./PlayerBus";
import type { PlayerBusRpcContext } from "../types";
import { PlaybackSession } from "./PlaybackSession";
import { createPlayerRequestId } from "./PlayerBus";
import type { AudioResource } from "@discordjs/voice";
import { PlayerActionPriority } from "../types";
import type {
	PlayerMessageContext,
	SearchResult,
	StreamInfo,
	Track,
	TrackLoadResult,
	PlaybackOrchestratorOptions,
} from "../types";
import type { PromotedPreload } from "../types";
import { CONTROLLER_RPC } from "../controller/ControllerBusContract";
import { PlaybackStartController } from "../controller/PlaybackStartController";
import { PlaybackPreparationController } from "../controller/PlaybackPreparationController";

export class PlaybackOrchestrator {
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	private session: PlaybackSession | null = null;
	private trackEndTransition = false;
	private waitingForQueue = false;
	private queueStartPromise: Promise<void> | null = null;
	private readonly detachAction: () => void;
	private readonly detachTrackEnd: () => void;
	private readonly detachQueueChanged: () => void;
	private readonly detachQueueEnd: () => void;
	private readonly detachRpcs: Array<() => void> = [];
	private readonly debug: (message?: any, ...optionalParams: any[]) => void;
	private readonly preparationController: PlaybackPreparationController;
	private readonly startController: PlaybackStartController;

	constructor(
		private readonly bus: PlayerBus,
		options: PlaybackOrchestratorOptions = {},
	) {
		this.debug = options.debug ?? (() => undefined);
		this.preparationController = new PlaybackPreparationController({
			bus,
			isCurrentSession: (session, context) => this.matchesContext(session, context),
			queueSnapshot: () => this.queueSnapshot(),
			setQueueRelated: (tracks) => this.setQueueRelated(tracks),
		});
		this.startController = new PlaybackStartController({
			bus,
			getSession: () => this.session,
			setSession: (session) => {
				this.session = session;
			},
			transitionEnabled: () => this.transitionEnabled(),
			stopPlayback: (signal, cancelPreload) => this.stopPlayback(signal, cancelPreload),
			prepareTrack: (session, context) => this.preparationController.prepareTrack(session, context),
		});
		this.detachAction = bus.onAction((a, c) => this.handleAction(a, c));
		this.detachTrackEnd = bus.subscribe("TRACK_END", (event) => {
			const session = event.session;
			if (!session || session.status === "ended" || session.status === "stopped") return;
			if (!this.session || this.session.id !== session.id) return;
			if (this.trackEndTransition) return;
			this.trackEndTransition = true;
			void this.advanceAfterTrackEnd(session);
		});
		this.detachQueueEnd = bus.subscribe("queueEnd", () => {
			this.waitingForQueue = true;
		});
		this.detachQueueChanged = bus.subscribe("queueChanged", () => {
			if (this.disposed || !this.waitingForQueue || this.trackEndTransition || this.queueStartPromise) return;
			if (!this.queueSnapshot().length) return;
			this.queueStartPromise = this.startQueuedTrackAfterEnd().finally(() => {
				this.queueStartPromise = null;
			});
		});
		this.detachRpcs.push(
			bus.registerRpc<{ query: string | Track | SearchResult | null; requestedBy?: string }, boolean>(
				CONTROLLER_RPC.play,
				(request, context) => this.play(request.query, request.requestedBy, context),
			),
			bus.registerRpc<void, void>(CONTROLLER_RPC.playbackDestroyCurrentStream, () =>
				this.stopPlayback(new AbortController().signal),
			),
			bus.registerRpc<{ track: Track; session: PlaybackSession }, unknown>(
				CONTROLLER_RPC.playbackRecover,
				({ track, session }, context) =>
					this.bus.requestRpc(
						CONTROLLER_RPC.trackLoadWithRecovery,
						{ track, session },
						{ signal: this.combinedSignal(context.signal) },
					),
			),
			bus.registerRpc<{ track: Track; session: PlaybackSession }, unknown>(
				CONTROLLER_RPC.playbackLoadFresh,
				({ track, session }, context) =>
					this.bus.requestRpc(CONTROLLER_RPC.trackLoad, { track, session }, { signal: this.combinedSignal(context.signal) }),
			),
			bus.registerRpc<{ track: Track; stream: { handle?: { play?: () => void | Promise<void> } } }, boolean>(
				CONTROLLER_RPC.playbackRemote,
				async ({ stream }) => {
					if (stream?.handle?.play) await stream.handle.play();
					return true;
				},
			),
			bus.registerRpc<{ track: Track }, TrackLoadResult | null>(CONTROLLER_RPC.playbackLoadFreshCurrent, ({ track }, context) => {
				if (!this.session) return null;
				return this.bus.requestRpc(
					CONTROLLER_RPC.trackLoad,
					{ track, session: this.session },
					{ signal: this.combinedSignal(context.signal) },
				);
			}),
			bus.registerRpc<{ track: Track }, AudioResource | null>(CONTROLLER_RPC.playbackPromotePreload, ({ track }) => {
				const session = this.session;
				if (!session) return null;
				const promoted = this.bus.requestRpcSync<{ track: Track }, PromotedPreload | null>("preload.promote", { track });
				if (!promoted) return null;
				const streamInfo: StreamInfo = promoted.streamInfo ?? { stream: promoted.stream as any, type: "arbitrary" };
				const streamToPlay = (streamInfo.stream ?? promoted.stream) as import("stream").Readable;
				const resource = this.bus.requestRpcSync<
					{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
					AudioResource
				>("resource.create", { stream: streamToPlay, track: promoted.track, inputType: streamInfo.inputType });
				session.setResource(resource);
				this.bus.requestRpcSync(CONTROLLER_RPC.playbackPlay, { resource, session });
				session.markPlaying(0);
				this.waitingForQueue = false;
				this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
				return resource;
			}),
		);
	}

	get currentSession() {
		return this.session;
	}

	get transitionPolicy() {
		return this.bus.querySync("transitionSettings");
	}

	private transitionEnabled(): boolean {
		const settings = this.bus.querySync("transitionSettings");
		return !!settings && settings.enabled !== false;
	}

	private isCurrentSession(sessionId: number): boolean {
		return !!this.session && this.session.owns(sessionId);
	}

	private queueSnapshot(): Track[] {
		return this.bus.querySync("queue") ?? [];
	}

	private queueState(): any {
		return this.bus.querySync("queueSerialized");
	}

	private setQueueRelated(tracks: Track[]): void {
		const state = this.queueState();
		if (!state || typeof state !== "object") return;
		state.relatedTracks = tracks;
		this.bus.requestRpcSync("queue.restore", { state });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.detachAction();
		this.detachTrackEnd();
		this.detachQueueChanged();
		this.detachQueueEnd();
		for (const d of this.detachRpcs.splice(0)) d();
		this.session?.destroy();
		this.session = null;
		this.trackEndTransition = false;
		this.waitingForQueue = false;
		this.queueStartPromise = null;
	}

	private async play(
		query: string | Track | SearchResult | null,
		requestedBy: string | undefined,
		rpcContext: PlayerBusRpcContext,
	): Promise<boolean> {
		if (rpcContext.signal.aborted) return false;
		const context: PlayerMessageContext = {
			requestId: rpcContext.requestId,
			source: "PlaybackOrchestrator:play",
			signal: AbortSignal.any([rpcContext.signal, this.lifecycleAbort.signal]),
			timestamp: rpcContext.timestamp,
			priority: PlayerActionPriority.NORMAL,
		};
		try {
			if (query === null) {
				if (this.session?.status === "playing" || this.session?.status === "paused") return true;
				await this.skip(context);
				return this.session?.track !== null && this.session?.track !== undefined;
			}
			let tracks: Track[];
			if (typeof query === "string") {
				const result = await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(
					"search",
					{
						query,
						requestedBy: requestedBy || "Unknown",
					},
					{ signal: context.signal },
				);
				tracks = result.playlist ? result.tracks : result.tracks.slice(0, 1);
			} else if ("tracks" in query) tracks = query.playlist ? query.tracks : query.tracks.slice(0, 1);
			else tracks = [query];
			if (tracks.length === 0 || rpcContext.signal.aborted) return false;
			if (
				tracks.length === 1 &&
				(this.bus.querySync("ttsInterrupt") ?? true) &&
				this.bus.requestRpcSync<{ track: Track }, boolean>(CONTROLLER_RPC.ttsIsTTS, { track: tracks[0] })
			) {
				await this.bus.requestRpc(CONTROLLER_RPC.ttsPlay, { track: tracks[0] });
				return true;
			}
			await this.bus.requestRpc("queue.addMultiple", { tracks }, { signal: rpcContext.signal });
			if ((this.session?.status === "playing" || this.session?.status === "paused") && !this.waitingForQueue) {
				void this.bus
					.requestRpc("preload.next", {}, { signal: rpcContext.signal })
					.catch((error) => this.debug("[PlaybackOrchestrator] Preload after queue add error:", error));
				return true;
			}
			if (this.waitingForQueue) {
				await Promise.race([this.queueStartPromise, this.waitForLifecycleAbort()]);
				return this.session?.status === "playing" || this.session?.status === "paused";
			}
			await this.skip(context);
			return this.session?.track !== null && this.session?.track !== undefined;
		} catch (error) {
			this.debug("[PlaybackOrchestrator] Play error:", error);
			const session = this.session;
			if (session)
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			return false;
		}
	}

	private async handleAction(a: PlayerAction, context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		switch (a.type) {
			case "PLAY":
				if (a.track) await this.startController.start(a.track, context);
				break;
			case "SEEK":
				await this.seek(a.position, context);
				break;
			case "SKIP":
				await this.skip(context);
				break;
			case "PAUSE": {
				const session = this.session;
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(CONTROLLER_RPC.playbackPause, {})
				) {
					session.markPaused();
					this.publishState();
					this.bus.event({ type: "playerPause", track: session.track });
				}
				break;
			}
			case "RESUME": {
				const session = this.session;
				if (
					session?.isActive() &&
					this.matchesContext(session, context) &&
					this.bus.requestRpcSync(CONTROLLER_RPC.playbackResume, {})
				) {
					session.markPlaying();
					this.publishState();
					this.bus.event({ type: "playerResume", track: session.track });
				}
				break;
			}
			case "STOP": {
				const session = this.session;
				if (session && !this.matchesContext(session, context)) break;
				this.stopPlayback(context.signal);
				if (session?.isActive()) session.markStopped();
				this.publishState();
				this.bus.event({ type: "playerStop" });
				break;
			}
		}
	}

	private matchesContext(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return session.ownsContext(context.sessionId);
	}

	private stopPlayback(_s: AbortSignal, cancelPreload = true): void {
		this.bus.requestRpcSync(CONTROLLER_RPC.playbackStop, {});
		if (cancelPreload) this.bus.requestRpcSync("preload.cancel", {});
	}

	private async nextThroughBus(ignoreLoop: boolean, context: PlayerMessageContext): Promise<Track | null> {
		if (context.signal.aborted) return null;
		const previousCurrent = this.bus.querySync("queueCurrent") ?? null;
		await this.bus.action({ type: "QUEUE_NEXT", ignoreLoop, requestId: context.requestId }, context);
		const next = await this.bus.query("queueCurrent");
		if (context.signal.aborted) {
			await this.bus.requestRpc("queue.restoreNext", { previousCurrent, nextTrack: next });
			return null;
		}
		return next;
	}

	private async startQueuedTrackAfterEnd(): Promise<void> {
		if (!this.waitingForQueue || this.trackEndTransition || !this.queueSnapshot().length) return;
		this.trackEndTransition = true;
		try {
			const from = this.session?.track ?? null;
			const context: PlayerMessageContext = {
				requestId: createPlayerRequestId(),
				source: "PlaybackOrchestrator:queue-refill",
				signal: this.lifecycleSignal(),
				timestamp: Date.now(),
				priority: PlayerActionPriority.NORMAL,
			};
			const next = await this.nextThroughBus(false, context);
			if (!next || context.signal.aborted) return;
			this.waitingForQueue = false;
			await this.startController.start(next, context, from);
		} finally {
			this.trackEndTransition = false;
		}
	}

	private async advanceAfterTrackEnd(snapshot: ReturnType<PlaybackSession["snapshot"]>): Promise<void> {
		if (
			!this.session ||
			this.session.id !== snapshot.id ||
			this.session.status === "ended" ||
			this.session.status === "stopped"
		) {
			this.trackEndTransition = false;
			return;
		}
		try {
			if (!this.session || this.session.id !== snapshot.id || !this.session.isActive()) return;
			const from = this.session.track;
			const endedSession = this.session;
			const context: PlayerMessageContext = {
				requestId: createPlayerRequestId(),
				source: "PlaybackOrchestrator:track-end",
				signal: this.lifecycleSignal(),
				timestamp: Date.now(),
				priority: PlayerActionPriority.NORMAL,
			};
			let next = await this.nextThroughBus(false, context);
			if (next) {
				endedSession.markEnded();
				this.waitingForQueue = false;
				await this.startController.start(next, context, from);
				return;
			}
			if (this.bus.querySync("queueAutoPlay")) {
				const candidate = await this.preparationController.prepareAutoplay(endedSession, context);
				if (candidate && this.session?.id === snapshot.id && this.session.isActive()) {
					endedSession.markEnded();
					this.bus.requestRpcSync("queue.willNext", { track: null });
					if (!this.bus.querySync("queueNextTrack")) this.bus.requestRpcSync("queue.addMultiple", { tracks: [candidate] });
					next = await this.nextThroughBus(false, context);
					if (next) {
						this.waitingForQueue = false;
						await this.startController.start(next, context, from);
						return;
					}
				}
			}
			if (!this.session || this.session.id !== snapshot.id || !this.session.isActive()) return;
			endedSession.markEnded();
			this.stopPlayback(context.signal);
			this.publishState();
			this.waitingForQueue = true;
			this.bus.event({ type: "queueEnd" });
		} finally {
			this.trackEndTransition = false;
		}
	}

	private async seek(position: number, context: PlayerMessageContext): Promise<void> {
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
			this.bus.event({ type: "seek", track: x.track, position });
		} catch (error) {
			if (!context.signal.aborted && this.matchesContext(x, context))
				this.bus.event({
					type: "TRACK_ERROR",
					session: x.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
		}
	}

	private lifecycleSignal(): AbortSignal {
		return this.lifecycleAbort.signal;
	}

	private combinedSignal(signal: AbortSignal): AbortSignal {
		return AbortSignal.any([signal, this.lifecycleAbort.signal]);
	}

	private waitForLifecycleAbort(): Promise<void> {
		if (this.lifecycleAbort.signal.aborted) return Promise.resolve();
		return new Promise((resolve) => this.lifecycleAbort.signal.addEventListener("abort", () => resolve(), { once: true }));
	}

	private async skip(context: PlayerMessageContext): Promise<void> {
		if (context.signal.aborted) return;
		const from = this.session?.track ?? null;
		const oldSession = this.session;
		if (oldSession && context.sessionId && oldSession.sessionId !== context.sessionId) return;
		this.trackEndTransition = true;
		try {
			let next = await this.nextThroughBus(true, context);
			if (!next && this.bus.querySync("queueAutoPlay") && oldSession) {
				const candidate = await this.preparationController.prepareAutoplay(oldSession, context);
				if (candidate) {
					this.bus.requestRpcSync("queue.willNext", { track: null });
					if (!this.bus.querySync("queueNextTrack")) this.bus.requestRpcSync("queue.addMultiple", { tracks: [candidate] });
					next = await this.nextThroughBus(true, context);
				}
			}
			if (oldSession?.isActive()) {
				const endedSnapshot = oldSession.snapshot();
				this.bus.event({ type: "TRACK_END", session: endedSnapshot });
				oldSession.markEnded();
			}
			if (!next) {
				this.stopPlayback(context.signal);
				this.publishState();
				this.waitingForQueue = true;
				this.bus.event({ type: "queueEnd" });
				return;
			}
			this.waitingForQueue = false;
			await this.startController.start(next, context, from);
		} finally {
			this.trackEndTransition = false;
		}
	}

	private publishState(): void {
		this.bus.event({ type: "playbackStateChanged", session: this.session?.snapshot() ?? null });
	}
}
