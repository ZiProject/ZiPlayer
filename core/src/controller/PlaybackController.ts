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
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";
import type { AntiStuckController } from "./AntiStuckController";
import type { AntiStuckRetryHandlers } from "../types";

export class PlaybackController {
	public readonly audioPlayer: AudioPlayer;
	public activeResource: AudioResource | null = null;
	private activeSession: PlaybackSession | null = null;
	private readonly bus?: PlayerBus;
	private readonly volume?: VolumeController;
	private readonly transitions?: TransitionController;
	private readonly antiStuck?: AntiStuckController;
	private readonly stuckTimeoutMs: number;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private fadeTimer: ReturnType<typeof setInterval> | null = null;
	private stuckTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly recoveryHandlers: AntiStuckRetryHandlers;
	private fadeGain: number | null = null;
	private readonly detachQueries: Array<() => void> = [];
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	private readonly onError: (error: Error) => void;

	constructor(o: PlaybackControllerOptions) {
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.volume = o.volumeController;
		this.transitions = o.transitionController;
		this.antiStuck = o.antiStuckController;
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
		this.volume?.bindActiveResourceResolver(() => ({
			resource: this.activeResource,
			track: this.activeSession?.track ?? (this.activeResource?.metadata as Track | undefined),
			gain: this.fadeGain ?? 1,
		}));
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
				this.bus.registerRpc<{ from: Track | null; to: Track | null }, number>(
					"transition.duration",
					({ from, to }) => this.transitions?.plan(from, to).durationMs ?? 0,
				),
				this.bus.registerRpc<{ track: Track | null; positionMs: number }, number>(
					"transition.beatWait",
					({ track, positionMs }) => this.transitions?.beatWaitMs(track, positionMs) ?? 0,
				),
				this.bus.registerRpc<{ track: Track | null }, number>("transition.targetVolume", ({ track }) =>
					this.getTrackTargetVolume(track),
				),
			);
			this.detachQueries.push(
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
				this.bus.registerQuery("isLive", () => Boolean((this.activeSession?.track as Track | undefined)?.isLive)),
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
				void this.antiStuck?.reportStuck(session, `audio player error: ${normalized.message}`, this.recoveryHandlers);
			} else {
				this.bus?.event({ type: "streamError", error: normalized, track: null });
			}
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
		this.audioPlayer.on("error", this.onError);
	}
	private armStuckWatchdog(): void {
		this.clearStuckWatchdog();
		if (!this.antiStuck || this.stuckTimeoutMs <= 0 || !this.activeSession?.isActive()) return;
		const resource = this.activeResource;
		const session = this.activeSession;
		const initialDuration = Number(resource?.playbackDuration ?? session.position);
		this.stuckTimer = setTimeout(() => {
			this.stuckTimer = null;
			if (this.status !== AudioPlayerStatus.Buffering || this.activeResource !== resource || this.activeSession !== session)
				return;
			const currentDuration = Number(resource?.playbackDuration ?? session.position);
			if (currentDuration === initialDuration)
				void this.antiStuck?.reportStuck(session, `buffering stalled for ${this.stuckTimeoutMs}ms`, this.recoveryHandlers);
			else this.armStuckWatchdog();
		}, this.stuckTimeoutMs);
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
		const plan = from && to ? this.transitions?.plan(from, to) : undefined;
		if (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
			this.fadeTransition(this.activeResource, resource, plan, session, track);
			return;
		}
		this.fadeGain = null;
		this.volume?.applyLoudness(resource, track, 1);
		if (session) session.setResource(resource);
		this.activeSession = session ?? null;
		this.activeResource = resource;
		this.audioPlayer.play(resource);
	}
	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		if (!resource?.volume) return;
		const duration = Math.max(0, durationMs);
		if (duration === 0) {
			resource.volume.setVolume(to);
			return;
		}
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
		this.volume?.applyLoudness(resource, track, 1);
		const target = resource.volume.volume;
		resource.volume.setVolume(0);
		await this.fadeResourceVolume(
			resource,
			0,
			target,
			this.transitions?.plan(this.activeSession?.track ?? null, track).durationMs ?? 0,
		);
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		const resource = this.activeResource;
		if (!resource?.volume) return;
		const track = this.activeSession?.track ?? (resource.metadata as Track | undefined);
		const current = Number(resource.volume.volume ?? 0);
		await this.fadeResourceVolume(resource, current, 0, this.transitions?.plan(track ?? null, track ?? null).durationMs ?? 0);
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		await this.applyCrossfadeOutCurrent();
		this.stop();
	}
	public getTrackTargetVolume(track?: Track | null): number {
		return this.volume?.getTargetVolume(track) ?? 1;
	}
	/**
	 * Fades the replacement resource in. AudioPlayer owns one active resource,
	 * so this is a fade transition rather than a true two-source crossfade.
	 */
	private fadeTransition(
		_oldResource: AudioResource,
		newResource: AudioResource,
		plan: { enabled: boolean; durationMs: number },
		session?: PlaybackSession,
		track?: Track,
	): void {
		this.fadeGain = 0;
		this.volume?.applyLoudness(newResource, track, 0);
		const wait = this.transitions?.beatWaitMs(session?.track ?? null, session?.position ?? 0) ?? 0;
		const begin = () => {
			this.transitionTimer = null;
			if (session && !session.isActive()) {
				this.fadeGain = null;
				return;
			}
			this.fadeGain = 0;
			this.volume?.applyLoudness(newResource, track, 0);
			this.audioPlayer.play(newResource);
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
				this.volume?.applyLoudness(newResource, track, p);
				if (p >= 1) this.cancelFade();
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait);
		else begin();
	}
	private cancelFade() {
		if (this.fadeTimer) {
			clearInterval(this.fadeTimer);
			this.fadeTimer = null;
		}
		this.fadeGain = null;
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
		const v = this.volume?.setVolume(value) ?? value;
		if (this.activeResource) {
			const track = this.activeSession?.track ?? (this.activeResource.metadata as Track | undefined);
			this.volume?.applyLoudness(this.activeResource, track, this.fadeGain ?? 1);
		}
		return v;
	}
	public get volumeValue(): number {
		return this.volume?.value ?? 100;
	}
	public get position(): number | null {
		const session = this.activeSession;
		if (!session) return null;
		const duration = Number(session.resource?.playbackDuration);
		if (Number.isFinite(duration) && (duration > 0 || session.position === 0)) session.updatePosition(duration);
		return session.position;
	}
	public get state(): AudioPlayerState {
		return this.audioPlayer.state;
	}
	public get status(): AudioPlayerStatus {
		return this.audioPlayer.state.status;
	}
	public dispose(): void {
		this.cancelTransition();
		this.clearStuckWatchdog();
		this.volume?.bindActiveResourceResolver(null);
		this.activeSession?.destroy();
		this.activeSession = null;
		for (const detach of this.detachQueries.splice(0)) detach();
		this.audioPlayer.removeListener("stateChange", this.onStateChange);
		this.audioPlayer.removeListener("error", this.onError);
		this.audioPlayer.stop(true);
		this.activeResource = null;
	}
}
