import {
	AudioPlayer,
	AudioPlayerState,
	AudioPlayerStatus,
	AudioResource,
	createAudioResource,
	type StreamType,
} from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, PlaybackControllerOptions } from "../types";
import type { AntiStuckRetryHandlers } from "../types";

/** Owns audio-player state. Cross-controller capabilities are requested through PlayerBus. */
export class PlaybackController {
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
	private fadeGain: number | null = null;
	private readonly detachQueries: Array<() => void> = [];
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	private readonly onError: (error: Error) => void;

	constructor(o: PlaybackControllerOptions) {
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.stuckTimeoutMs = Math.max(0, o.stuckTimeoutMs ?? 10000);
		this.recoveryHandlers = {
			retry: async ({ session }) => {
				if (!this.bus || !session.isActive()) return false;
				try {
					await this.bus.requestRpc("playback.refreshResource", { position: session.position }, { signal: session.signal, timeoutMs: 30000 });
					return session.isActive();
				} catch {
					return false;
				}
			},
			skip: ({ session }) => this.bus?.action({ type: "SKIP" }, { signal: session.signal, sessionId: session.sessionId }),
		};
		if (this.bus) {
			this.detachQueries.push(
				this.bus.registerRpc<{ resource: AudioResource; from: number; to: number; durationMs: number }, void>(
					"transition.fade",
					({ resource, from, to, durationMs }) => this.fadeResourceVolume(resource, from, to, durationMs),
				),
				this.bus.registerRpc<{ resource: AudioResource; track: Track }, void>("transition.fadeIn", ({ resource, track }) =>
					this.applyCrossfadeIn(resource, track),
				),
				this.bus.registerRpc<void, void>("transition.fadeOutCurrent", () => this.applyCrossfadeOutCurrent()),
				this.bus.registerRpc<void, void>("transition.skipAndStop", () => this.crossfadeSkipAndStop()),
				this.bus.registerRpc<{ stream: Readable; track: Track; inputType?: StreamType }, AudioResource>(
					"resource.create",
					({ stream, track, inputType }) => this.createResource(stream, track, inputType),
				),
			);
			this.detachQueries.push(
				this.bus.registerQuery("currentResource", () => this.activeSession?.resource ?? this.activeResource),
				this.bus.registerQuery("playbackSession", () => this.activeSession?.snapshot() ?? null),
				this.bus.registerQuery("playerState", () => this.status),
				this.bus.registerQuery("isPlaying", () => this.status === AudioPlayerStatus.Playing),
				this.bus.registerQuery("isPaused", () => this.status === AudioPlayerStatus.Paused),
				this.bus.registerQuery("isIdle", () => this.status === AudioPlayerStatus.Idle),
				this.bus.registerQuery("isBuffering", () => this.status === AudioPlayerStatus.Buffering),
				this.bus.registerQuery("isLive", () => Boolean(this.activeSession?.track?.isLive)),
				this.bus.registerQuery("position", () => this.position),
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
			} else this.bus?.event({ type: "streamError", error: normalized, track: null });
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
		this.audioPlayer.on("error", this.onError);
	}

	private requestSync<T>(type: string, request: unknown, fallback: T): T {
		if (!this.bus) return fallback;
		try { return this.bus.requestRpcSync<T>(type, request); } catch { return fallback; }
	}

	private requestTransitionPlan(from: Track | null, to: Track | null): { enabled: boolean; durationMs: number } {
		const durationMs = this.requestSync("controller.transition.plan", { from, to }, 0);
		return { enabled: durationMs > 0, durationMs };
	}

	private requestBeatWait(track: Track | null, positionMs: number): number {
		return this.requestSync("controller.transition.beatWait", { track, positionMs }, 0);
	}

	private requestTargetVolume(track: Track | null): number {
		return this.requestSync("controller.volume.target", { track }, 1);
	}

	private applyTargetVolume(resource: AudioResource, track: Track | null, gain: number): void {
		if (!resource?.volume) return;
		resource.volume.setVolume(this.requestTargetVolume(track) * Math.max(0, Number.isFinite(gain) ? gain : 1));
	}

	private async reportStuck(session: PlaybackSession, reason: string): Promise<void> {
		if (!this.bus || !session.isActive()) return;
		try {
			await this.bus.requestRpc("controller.antistuck.report", { session, track: session.track, reason, handlers: this.recoveryHandlers }, { signal: session.signal });
		} catch {}
	}

	private armStuckWatchdog(): void {
		this.clearStuckWatchdog();
		if (this.resourceRefreshInProgress || this.stuckTimeoutMs <= 0 || !this.activeSession?.isActive()) return;
		const resource = this.activeResource;
		const session = this.activeSession;
		const initialDuration = Number(resource?.playbackDuration ?? session.position);
		this.stuckTimer = setTimeout(() => {
			this.stuckTimer = null;
			if (this.resourceRefreshInProgress || this.status !== AudioPlayerStatus.Buffering || this.activeResource !== resource || this.activeSession !== session) return;
			const currentDuration = Number(resource?.playbackDuration ?? session.position);
			if (currentDuration === initialDuration) void this.reportStuck(session, `buffering stalled for ${this.stuckTimeoutMs}ms`);
			else this.armStuckWatchdog();
		}, this.stuckTimeoutMs);
	}

	public beginResourceRefresh(): void { this.resourceRefreshInProgress = true; this.clearStuckWatchdog(); }
	public endResourceRefresh(): void { this.resourceRefreshInProgress = false; if (this.status === AudioPlayerStatus.Buffering) this.armStuckWatchdog(); }
	public reportFilterError(error: Error): void {
		const session = this.activeSession;
		if (!session?.isActive() || this.resourceRefreshInProgress) return;
		void this.reportStuck(session, `filter processing failed: ${error.message}`);
	}
	private clearStuckWatchdog(): void { if (this.stuckTimer) clearTimeout(this.stuckTimer); this.stuckTimer = null; }

	public createResource(stream: Readable, track: Track, inputType?: StreamType): AudioResource {
		const resolvedInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		return createAudioResource(stream, { metadata: track, inlineVolume: true, ...(resolvedInputType ? { inputType: resolvedInputType } : {}) });
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
		this.applyTargetVolume(resource, track ?? null, 1);
		if (session) session.setResource(resource);
		this.activeSession = session ?? null;
		this.activeResource = resource;
		this.audioPlayer.play(resource);
	}

	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		if (!resource?.volume) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) { resource.volume.setVolume(to); return; }
		const start = Date.now();
		while (true) {
			const progress = Math.min(1, (Date.now() - start) / duration);
			resource.volume.setVolume(from + (to - from) * progress);
			if (progress >= 1) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}

	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		if (!resource?.volume) return;
		const target = this.requestTargetVolume(track);
		resource.volume.setVolume(0);
		await this.fadeResourceVolume(resource, 0, target, this.requestTransitionPlan(this.activeSession?.track ?? null, track).durationMs);
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		const resource = this.activeResource;
		if (!resource?.volume) return;
		const track = this.activeSession?.track ?? (resource.metadata as Track | undefined) ?? null;
		await this.fadeResourceVolume(resource, Number(resource.volume.volume ?? 0), 0, this.requestTransitionPlan(track, track).durationMs);
	}
	public async crossfadeSkipAndStop(): Promise<void> { await this.applyCrossfadeOutCurrent(); this.stop(); }
	public getTrackTargetVolume(track?: Track | null): number { return this.requestTargetVolume(track ?? null); }

	private fadeTransition(oldResource: AudioResource, newResource: AudioResource, plan: { enabled: boolean; durationMs: number }, session?: PlaybackSession, track?: Track): void {
		this.fadeGain = 0;
		this.applyTargetVolume(newResource, track ?? null, 0);
		const outgoingTrack = this.activeSession?.track ?? (oldResource.metadata as Track | undefined) ?? null;
		const outgoingPosition = this.activeSession?.position ?? 0;
		const wait = this.requestBeatWait(outgoingTrack, outgoingPosition);
		const begin = () => {
			this.transitionTimer = null;
			if (session && !session.isActive()) { this.cancelFade(); return; }
			this.audioPlayer.play(newResource);
			if (session) session.setResource(newResource);
			this.activeSession = session ?? null;
			this.activeResource = newResource;
			const start = Date.now();
			this.fadeTimer = setInterval(() => {
				const progress = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				this.fadeGain = progress;
				this.applyTargetVolume(newResource, track ?? null, progress);
				if (progress >= 1) this.cancelFade();
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait); else begin();
	}

	private cancelTransition(): void { if (this.transitionTimer) clearTimeout(this.transitionTimer); this.transitionTimer = null; this.cancelFade(); }
	private cancelFade(): void { if (this.fadeTimer) clearInterval(this.fadeTimer); this.fadeTimer = null; this.fadeGain = null; }

	public get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
	public get position(): number { return this.activeSession?.position ?? 0; }
	public get currentResource(): AudioResource | null { return this.activeSession?.resource ?? this.activeResource; }
	public get currentSession(): PlaybackSession | null { return this.activeSession; }
	public setSession(session: PlaybackSession | null): void { this.activeSession = session; this.activeResource = session?.resource ?? null; }
	public setPosition(position: number): void { this.activeSession?.updatePosition(position); }
	public pause(): boolean { if (this.status !== AudioPlayerStatus.Playing) return false; this.audioPlayer.pause(); return true; }
	public resume(): boolean { if (this.status !== AudioPlayerStatus.Paused) return false; this.audioPlayer.unpause(); return true; }
	public stop(): boolean { this.cancelTransition(); if (this.status === AudioPlayerStatus.Idle) return false; this.audioPlayer.stop(true); this.activeSession?.markStopped(); return true; }
	public setVolume(value: number): number {
		this.bus?.action({ type: "SET_VOLUME", volume: value });
		return this.requestSync("volume", undefined, value);
	}
	public isPlaying(): boolean { return this.status === AudioPlayerStatus.Playing; }
	public isPaused(): boolean { return this.status === AudioPlayerStatus.Paused; }
	public isIdle(): boolean { return this.status === AudioPlayerStatus.Idle; }
	public isBuffering(): boolean { return this.status === AudioPlayerStatus.Buffering; }
	public isLive(): boolean { return Boolean(this.activeSession?.track?.isLive); }

	dispose(): void {
		this.cancelTransition();
		this.clearStuckWatchdog();
		this.audioPlayer.off("stateChange", this.onStateChange);
		this.audioPlayer.off("error", this.onError);
		for (const detach of this.detachQueries.splice(0)) detach();
		this.activeSession?.destroy();
		this.activeSession = null;
		this.activeResource = null;
	}
}
