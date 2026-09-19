import {
	AudioPlayer,
	AudioPlayerState,
	AudioPlayerStatus,
	AudioResource,
	createAudioResource,
	type StreamType,
} from "@discordjs/voice";
import { Readable } from "stream";
import type { GlobalPlayerBus, PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, PlaybackControllerOptions } from "../types";
import type { AntiStuckRetryHandlers } from "../types";
import { CONTROLLER_RPC, type TransitionPlanResponse } from "./ControllerBusContract";

// Every RPC/query below must be registered exactly once on the shared GlobalPlayerBus;
// each per-player PlaybackController (it owns that player's discord.js AudioPlayer)
// registers itself here so the shared handlers can route by playerId.
const playbackControllers = new Map<string, PlaybackController>();
const playbackRpcRegistered = new WeakSet<GlobalPlayerBus>();
function ensurePlaybackRpcBridge(bus: GlobalPlayerBus): void {
	if (playbackRpcRegistered.has(bus)) return;
	playbackRpcRegistered.add(bus);
	const at = (playerId: string) => playbackControllers.get(playerId);
	bus.registerRpc<{ resource: AudioResource; from: number; to: number; durationMs: number }, void>(
		"transition.fade",
		({ resource, from, to, durationMs }, ctx) => at(ctx.playerId)?.fadeResourceVolume(resource, from, to, durationMs),
	);
	bus.registerRpc<{ resource: AudioResource; track: Track }, void>("transition.fadeIn", ({ resource, track }, ctx) =>
		at(ctx.playerId)?.applyCrossfadeIn(resource, track),
	);
	bus.registerRpc<void, void>("transition.fadeOutCurrent", (_req, ctx) => at(ctx.playerId)?.applyCrossfadeOutCurrent());
	bus.registerRpc<void, void>("transition.skipAndStop", (_req, ctx) => at(ctx.playerId)?.crossfadeSkipAndStop());
	bus.registerRpc<{ resource: AudioResource; session?: PlaybackSession; from?: Track | null; to?: Track }, void>(
		CONTROLLER_RPC.playbackPlay,
		({ resource, session, from, to }, ctx) => at(ctx.playerId)?.play(resource, session, from, to),
	);
	bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackPause, (_req, ctx) => at(ctx.playerId)?.pause() ?? false);
	bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackResume, (_req, ctx) => at(ctx.playerId)?.resume() ?? false);
	bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackStop, (_req, ctx) => at(ctx.playerId)?.stop() ?? false);
	bus.registerRpc<void, void>(CONTROLLER_RPC.playbackBeginResourceRefresh, (_req, ctx) => at(ctx.playerId)?.beginResourceRefresh());
	bus.registerRpc<void, void>(CONTROLLER_RPC.playbackEndResourceRefresh, (_req, ctx) => at(ctx.playerId)?.endResourceRefresh());
	bus.registerRpc<{ error: Error }, void>("playback.reportFilterError", ({ error }, ctx) => at(ctx.playerId)?.reportFilterError(error));
	bus.registerRpc<{ stream: Readable; track: Track; inputType?: StreamType }, AudioResource>(
		"resource.create",
		({ stream, track, inputType }, ctx) => {
			const controller = at(ctx.playerId);
			if (!controller) throw new Error("No PlaybackController registered for this player");
			return controller.createResource(stream, track, inputType);
		},
	);
	bus.registerQuery("audioPlayer", (playerId) => at(playerId)?.audioPlayer as any);
	bus.registerQuery("currentResource", (playerId) => at(playerId)?.currentResource ?? null);
	bus.registerQuery("playbackSession", (playerId) => at(playerId)?.currentSessionSnapshot ?? null);
	bus.registerQuery("playerState", (playerId) => at(playerId)?.status ?? AudioPlayerStatus.Idle);
	bus.registerQuery("isPlaying", (playerId) => at(playerId)?.status === AudioPlayerStatus.Playing);
	bus.registerQuery("isPaused", (playerId) => at(playerId)?.status === AudioPlayerStatus.Paused);
	bus.registerQuery("isIdle", (playerId) => at(playerId)?.status === AudioPlayerStatus.Idle);
	bus.registerQuery("isBuffering", (playerId) => at(playerId)?.status === AudioPlayerStatus.Buffering);
	bus.registerQuery("isLive", (playerId) => Boolean((at(playerId)?.currentSessionTrack as Track | undefined)?.isLive));
	bus.registerQuery("position", (playerId) => at(playerId)?.position ?? null);
}

export class PlaybackController {
	private readonly playerId: string;
	public readonly audioPlayer: AudioPlayer;
	public activeResource: AudioResource | null = null;
	private activeSession: PlaybackSession | null = null;
	private readonly bus?: PlayerBus;
	private readonly stuckTimeoutMs: number;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private fadeTimer: ReturnType<typeof setInterval> | null = null;
	private stuckTimer: ReturnType<typeof setTimeout> | null = null;
	private resourceRefreshInProgress = false;
	private readonly recoveryHandlers: AntiStuckRetryHandlers;
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	private fadeGain: number | null = null;
	private readonly detachBusHandlers: Array<() => void> = [];
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	private readonly onError: (error: Error) => void;

	constructor(playerId: string, o: PlaybackControllerOptions) {
		this.playerId = playerId;
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.stuckTimeoutMs = Math.max(0, o.stuckTimeoutMs ?? 10000);
		this.recoveryHandlers = {
			retry: async ({ session }) => {
				if (!this.bus || !session.isActive()) return false;
				try {
					await this.bus.requestRpc(
						"playback.refreshResource",
						{ position: session.position },
						{ signal: session.signal, timeoutMs: 30000 },
					);
					return session.isActive();
				} catch {
					return false;
				}
			},
			skip: ({ session }) => this.bus?.action({ type: "SKIP" }, { signal: session.signal, sessionId: session.sessionId }),
		};
		if (this.bus) {
			ensurePlaybackRpcBridge(this.bus.globalBus);
			playbackControllers.set(this.playerId, this);
			this.detachBusHandlers.push(
				this.bus.subscribe("volumeRequested", () => {
					if (!this.activeResource) return;
					const track = this.activeSession?.track ?? (this.activeResource.metadata as Track | undefined);
					this.applyTargetVolume(this.activeResource, track, this.fadeGain ?? 1);
				}),
			);
		}
		this.onStateChange = (a, b) => {
			this.bus?.publish("stateChanged", a, b);
			if (b.status === AudioPlayerStatus.Buffering) this.armStuckWatchdog();
			else this.clearStuckWatchdog();
			if (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle) {
				const previousResource = "resource" in a ? a.resource : undefined;
				if (previousResource && this.activeResource && previousResource !== this.activeResource) return;
				const session = this.activeSession;
				if (session?.isActive()) this.bus?.event({ type: "TRACK_END", session: session.snapshot() });
				this.activeSession = null;
				this.activeResource = null;
			}
		};
		this.onError = (error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			const session = this.activeSession;
			if (session?.isActive()) {
				this.bus?.event({ type: "TRACK_ERROR", session: session.snapshot(), error: normalized });
				void this.reportStuck(session, `audio player error: ${normalized.message}`);
			} else {
				this.bus?.event({ type: "streamError", error: normalized, track: null });
			}
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
		this.audioPlayer.on("error", this.onError);
	}

	private requestTransitionPlan(from: Track | null, to: Track | null): TransitionPlanResponse {
		if (!this.bus) return { enabled: false, durationMs: 0, waitForBeat: false, beatAlignMaxWaitMs: 0 };
		try {
			return this.bus.requestRpcSync(CONTROLLER_RPC.transitionPlan, { from, to });
		} catch {
			return { enabled: false, durationMs: 0, waitForBeat: false, beatAlignMaxWaitMs: 0 };
		}
	}

	private requestBeatWait(track: Track | null, positionMs: number): number {
		if (!this.bus) return 0;
		try {
			return this.bus.requestRpcSync(CONTROLLER_RPC.transitionBeatWait, { track, positionMs });
		} catch {
			return 0;
		}
	}

	private requestVolumeTarget(track?: Track | null): number {
		if (!this.bus) return 1;
		try {
			return this.bus.requestRpcSync(CONTROLLER_RPC.volumeTarget, { track });
		} catch {
			return 1;
		}
	}

	private applyTargetVolume(resource: AudioResource | null, track?: Track | null, gain = 1): void {
		if (!resource?.volume) return;
		const target = this.requestVolumeTarget(track);
		resource.volume.setVolume(target * Math.max(0, Number.isFinite(gain) ? gain : 1));
	}

	private reportStuck(session: PlaybackSession, reason: string): Promise<boolean> {
		if (!this.bus || !session.isActive()) return Promise.resolve(false);
		return this.bus.requestRpc(
			CONTROLLER_RPC.antiStuckReport,
			{ session, reason, handlers: this.recoveryHandlers },
			{ signal: session.signal },
		);
	}

	private armStuckWatchdog(): void {
		this.clearStuckWatchdog();
		if (this.resourceRefreshInProgress || this.stuckTimeoutMs <= 0 || !this.activeSession?.isActive()) return;
		const resource = this.activeResource;
		const session = this.activeSession;
		const initialDuration = Number(resource?.playbackDuration ?? session.position);
		this.stuckTimer = setTimeout(() => {
			this.stuckTimer = null;
			if (
				this.resourceRefreshInProgress ||
				this.status !== AudioPlayerStatus.Buffering ||
				this.activeResource !== resource ||
				this.activeSession !== session
			)
				return;
			const currentDuration = Number(resource?.playbackDuration ?? session.position);
			if (currentDuration === initialDuration) void this.reportStuck(session, `buffering stalled for ${this.stuckTimeoutMs}ms`);
			else this.armStuckWatchdog();
		}, this.stuckTimeoutMs);
	}
	public beginResourceRefresh(): void {
		this.resourceRefreshInProgress = true;
		this.clearStuckWatchdog();
	}
	public endResourceRefresh(): void {
		this.resourceRefreshInProgress = false;
		if (this.status === AudioPlayerStatus.Buffering) this.armStuckWatchdog();
	}
	public reportFilterError(error: Error): void {
		const session = this.activeSession;
		if (!session?.isActive() || this.resourceRefreshInProgress) {
			if (session?.isActive()) void this.reportStuck(session, `filter processing failed: ${error.message}`);
			return;
		}
		void this.reportStuck(session, `filter processing failed: ${error.message}`);
	}
	private clearStuckWatchdog(): void {
		if (this.stuckTimer) clearTimeout(this.stuckTimer);
		this.stuckTimer = null;
	}

	public createResource(stream: Readable, track: Track, inputType?: StreamType): AudioResource {
		const resolvedInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		return createAudioResource(stream, {
			metadata: track,
			inlineVolume: true,
			...(resolvedInputType ? { inputType: resolvedInputType } : {}),
		});
	}
	public play(resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
		if (session && !session.isActive()) return;
		this.cancelTransition();
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		const plan = from && to ? this.requestTransitionPlan(from, to) : undefined;
		if (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
			this.fadeTransition(this.activeResource, resource, plan, session, track);
			return;
		}
		this.fadeGain = null;
		this.applyTargetVolume(resource, track, 1);
		if (session) session.setResource(resource);
		this.activeSession = session ?? null;
		this.activeResource = resource;
		this.audioPlayer.play(resource);
		this.retirePendingSession();
	}

	private retirePendingSession(): void {
		if (!this.bus) return;
		try {
			this.bus.requestRpcSync(CONTROLLER_RPC.playbackSessionRetirePending, {});
		} catch {}
	}

	public async fadeResourceVolume(
		resource: AudioResource,
		from: number,
		to: number,
		durationMs: number,
		signal: AbortSignal = this.lifecycleAbort.signal,
	): Promise<void> {
		if (!resource?.volume) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) {
			if (!signal.aborted && !this.disposed) resource.volume.setVolume(to);
			return;
		}
		const start = Date.now();
		while (!signal.aborted && !this.disposed) {
			const progress = Math.min(1, (Date.now() - start) / duration);
			resource.volume.setVolume(from + (to - from) * progress);
			if (progress >= 1) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		if (!resource?.volume || this.disposed) return;
		this.applyTargetVolume(resource, track, 1);
		const target = resource.volume.volume;
		resource.volume.setVolume(0);
		await this.fadeResourceVolume(
			resource,
			0,
			target,
			this.requestTransitionPlan(this.activeSession?.track ?? null, track).durationMs,
			this.lifecycleAbort.signal,
		);
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		if (this.disposed) return;
		const resource = this.activeResource;
		if (!resource?.volume) return;
		const track = this.activeSession?.track ?? (resource.metadata as Track | undefined);
		const current = Number(resource.volume.volume ?? 0);
		await this.fadeResourceVolume(
			resource,
			current,
			0,
			this.requestTransitionPlan(track ?? null, track ?? null).durationMs,
			this.lifecycleAbort.signal,
		);
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		await this.applyCrossfadeOutCurrent();
		if (!this.disposed) this.stop();
	}
	public getTrackTargetVolume(track?: Track | null): number {
		return this.requestVolumeTarget(track);
	}
	private fadeTransition(
		oldResource: AudioResource,
		newResource: AudioResource,
		plan: TransitionPlanResponse,
		session?: PlaybackSession,
		track?: Track,
	): void {
		this.fadeGain = 0;
		this.applyTargetVolume(newResource, track, 0);
		const outgoingTrack = this.activeSession?.track ?? (oldResource.metadata as Track | undefined) ?? null;
		const outgoingPosition = this.activeSession?.position ?? 0;
		const wait = plan.waitForBeat ? this.requestBeatWait(outgoingTrack, outgoingPosition) : 0;
		const begin = () => {
			this.transitionTimer = null;
			if (this.disposed || (session && !session.isActive())) {
				this.cancelFade();
				return;
			}
			this.fadeGain = 0;
			this.applyTargetVolume(newResource, track, 0);
			this.audioPlayer.play(newResource);
			this.retirePendingSession();
			if (session) session.setResource(newResource);
			this.activeSession = session ?? null;
			this.activeResource = newResource;
			const start = Date.now();
			this.fadeTimer = setInterval(() => {
				if (session && !session.isActive()) {
					this.cancelFade();
					return;
				}
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				this.fadeGain = p;
				this.applyTargetVolume(newResource, track, p);
				if (p >= 1) {
					this.cancelFade();
					this.applyTargetVolume(newResource, track, 1);
				}
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait);
		else begin();
	}
	private cancelFade(): void {
		if (this.fadeTimer) {
			clearInterval(this.fadeTimer);
			this.fadeTimer = null;
		}
		if (this.fadeGain !== null) {
			this.fadeGain = null;
			if (this.activeResource) {
				const track = this.activeSession?.track ?? (this.activeResource.metadata as Track | undefined);
				this.applyTargetVolume(this.activeResource, track, 1);
			}
		}
	}
	private cancelTransition() {
		if (this.transitionTimer) {
			clearTimeout(this.transitionTimer);
			this.transitionTimer = null;
		}
		this.cancelFade();
	}
	public pause(): boolean {
		return this.audioPlayer.pause(true);
	}
	public resume(): boolean {
		return this.audioPlayer.unpause();
	}
	public stop(): boolean {
		this.cancelTransition();
		this.activeSession = null;
		this.activeResource = null;
		return this.audioPlayer.stop(true);
	}
	public async seek(position: number, session?: PlaybackSession): Promise<boolean> {
		if (!Number.isFinite(position) || position < 0) return false;
		if (session && !session.isActive()) return false;
		if (!this.bus) {
			if (!session) return false;
			session.updatePosition(position);
			return true;
		}
		try {
			await this.bus.requestRpc("playback.refreshResource", { position });
			return !session || session.isActive();
		} catch {
			return false;
		}
	}
	public setVolume(value: number): number {
		if (!this.bus) return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
		try {
			return this.bus.requestRpcSync(CONTROLLER_RPC.volumeSet, { value });
		} catch {
			return this.volumeValue;
		}
	}
	public get volumeValue(): number {
		return this.bus?.querySync("volume") ?? 100;
	}
	public get position(): number | null {
		const session = this.activeSession;
		if (!session) return null;
		const duration = Number(session.resource?.playbackDuration);
		if (Number.isFinite(duration) && (duration > 0 || session.position === 0))
			session.updatePosition(session.getPlaybackOffset() + duration);
		return session.position;
	}
	public get state(): AudioPlayerState {
		return this.audioPlayer.state;
	}
	public get status(): AudioPlayerStatus {
		return this.audioPlayer.state.status;
	}
	public get currentResource(): AudioResource | null {
		return this.activeSession?.resource ?? this.activeResource;
	}
	public get currentSessionSnapshot() {
		return this.activeSession?.snapshot() ?? null;
	}
	public get currentSessionTrack(): Track | null | undefined {
		return this.activeSession?.track;
	}
	public dispose(): void {
		if (playbackControllers.get(this.playerId) === this) playbackControllers.delete(this.playerId);
		this.resourceRefreshInProgress = false;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.cancelTransition();
		this.clearStuckWatchdog();
		this.activeSession?.destroy();
		this.activeSession = null;
		for (const detach of this.detachBusHandlers.splice(0)) detach();
		this.audioPlayer.removeListener("stateChange", this.onStateChange);
		this.audioPlayer.removeListener("error", this.onError);
		this.audioPlayer.stop(true);
		this.activeResource = null;
	}
}
