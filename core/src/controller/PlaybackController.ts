import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource, type StreamType } from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, PlaybackControllerOptions } from "../types";
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";

export class PlaybackController {
	public readonly audioPlayer: AudioPlayer;
	public activeResource: AudioResource | null = null;
	private activeSession: PlaybackSession | null = null;
	private readonly bus?: PlayerBus;
	private readonly volume?: VolumeController;
	private readonly transitions?: TransitionController;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private fadeTimer: ReturnType<typeof setInterval> | null = null;
	private fadeGain: number | null = null;
	private readonly detachQueries: Array<() => void> = [];
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;

	constructor(o: PlaybackControllerOptions) {
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.volume = o.volumeController;
		this.transitions = o.transitionController;
		this.volume?.bindActiveResourceResolver(() => ({ resource: this.activeResource, track: this.activeSession?.track ?? (this.activeResource?.metadata as Track | undefined), gain: this.fadeGain ?? 1 }));
		if (this.bus) {
			this.detachQueries.push(
				this.bus.registerQuery("currentResource", () => this.activeResource),
				this.bus.registerQuery("playbackSession", () => this.activeSession?.snapshot() ?? null),
				this.bus.registerQuery("playerState", () => this.status),
				this.bus.registerQuery("isPlaying", () => this.status === AudioPlayerStatus.Playing),
				this.bus.registerQuery("isPaused", () => this.status === AudioPlayerStatus.Paused),
				this.bus.registerQuery("isIdle", () => this.status === AudioPlayerStatus.Idle),
				this.bus.registerQuery("isBuffering", () => this.status === AudioPlayerStatus.Buffering),
				this.bus.registerQuery("isLive", () => Boolean((this.activeSession?.track as Track | undefined)?.isLive)),
				this.bus.registerQuery("position", () => this.activeSession?.position ?? null),
			);
		}
		this.onStateChange = (a, b) => {
			this.bus?.publish("stateChanged", a, b);
			if (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle) {
				const previousResource = "resource" in a ? a.resource : undefined;
				if (previousResource && this.activeResource && previousResource !== this.activeResource) return;
				const session = this.activeSession;
				if (session?.isActive()) this.bus?.event({ type: "TRACK_END", session: session.snapshot() });
				this.activeSession = null;
				this.activeResource = null;
			}
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
	}

	public createResource(stream: Readable, track: Track, inputType?: StreamType): AudioResource {
		const resolvedInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		return createAudioResource(stream, { metadata: track, inlineVolume: true, ...(resolvedInputType ? { inputType: resolvedInputType } : {}) });
	}
	public play(resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
		if (session && !session.isActive()) return;
		this.cancelTransition();
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		const plan = from && to ? this.transitions?.plan(from, to) : undefined;
		if (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) { this.crossfade(this.activeResource, resource, plan, session, track); return; }
		this.fadeGain = null; this.volume?.applyLoudness(resource, track, 1); if (session) session.setResource(resource);
		this.activeSession = session ?? null; this.activeResource = resource; this.audioPlayer.play(resource);
	}
	private crossfade(oldResource: AudioResource, newResource: AudioResource, plan: { enabled: boolean; durationMs: number }, session?: PlaybackSession, track?: Track): void {
		void oldResource; this.fadeGain = 0; this.volume?.applyLoudness(newResource, track, 0);
		const wait = this.transitions?.beatWaitMs(session?.track ?? null, session?.position ?? 0) ?? 0;
		const begin = () => {
			this.transitionTimer = null;
			if (session && !session.isActive()) { this.fadeGain = null; return; }
			this.fadeGain = 0; this.volume?.applyLoudness(newResource, track, 0); this.audioPlayer.play(newResource);
			if (session) session.setResource(newResource); this.activeSession = session ?? null; this.activeResource = newResource;
			const start = Date.now();
			this.fadeTimer = setInterval(() => {
				if (session && !session.isActive()) { this.cancelFade(); return; }
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs)); this.fadeGain = p; this.volume?.applyLoudness(newResource, track, p); if (p >= 1) this.cancelFade();
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait); else begin();
	}
	private cancelFade() { if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; } this.fadeGain = null; }
	private cancelTransition() { if (this.transitionTimer) { clearTimeout(this.transitionTimer); this.transitionTimer = null; } this.cancelFade(); }
	public pause(): boolean { return this.audioPlayer.pause(true); }
	public resume(): boolean { return this.audioPlayer.unpause(); }
	public stop(): boolean { this.cancelTransition(); this.activeSession = null; this.activeResource = null; return this.audioPlayer.stop(true); }
	public seek(_position: number, _session?: PlaybackSession): boolean { return false; }
	public setVolume(value: number): number { const v = this.volume?.setVolume(value) ?? value; if (this.activeResource) { const track = this.activeSession?.track ?? (this.activeResource.metadata as Track | undefined); this.volume?.applyLoudness(this.activeResource, track, this.fadeGain ?? 1); } return v; }
	public get volumeValue(): number { return this.volume?.value ?? 100; }
	public get state(): AudioPlayerState { return this.audioPlayer.state; }
	public get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
	public dispose(): void { this.cancelTransition(); this.volume?.bindActiveResourceResolver(null); this.activeSession?.destroy(); this.activeSession = null; for (const detach of this.detachQueries.splice(0)) detach(); this.audioPlayer.removeListener("stateChange", this.onStateChange); this.audioPlayer.stop(true); this.activeResource = null; }
}
