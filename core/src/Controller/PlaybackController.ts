import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";

export interface PlaybackControllerOptions {
	audioPlayer: AudioPlayer;
	bus?: PlayerBus;
	volumeController?: VolumeController;
	transitionController?: TransitionController;
}
export class PlaybackController {
	public readonly audioPlayer: AudioPlayer;
	private readonly bus?: PlayerBus;
	private readonly volume?: VolumeController;
	private readonly transitions?: TransitionController;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private fadeTimer: ReturnType<typeof setInterval> | null = null;
	private activeResource: AudioResource | null = null;
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
	constructor(o: PlaybackControllerOptions) {
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.volume = o.volumeController;
		this.transitions = o.transitionController;
		this.onStateChange = (a, b) => {
			this.bus?.publish("stateChanged", a, b);
			if (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle) {
				this.bus?.event({ type: "TRACK_END", session: this.activeSessionSnapshot() });
				this.activeResource = null;
			}
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
	}
	private activeSessionSnapshot() {
		return this.activeResource?.metadata as any;
	}
	public createResource(stream: Readable, track: Track): AudioResource {
		const resource = createAudioResource(stream, { metadata: track, inlineVolume: true });
		this.volume?.apply(resource);
		return resource;
	}
	public play(resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
		if (session && !session.isActive()) return;
		this.cancelTransition();
		this.volume?.apply(resource);
		const plan = from && to ? this.transitions?.plan(from, to) : undefined;
		if (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
			this.crossfade(this.activeResource, resource, plan, session);
			return;
		}
		if (session) session.setResource(resource);
		this.activeResource = resource;
		this.audioPlayer.play(resource);
	}
	private crossfade(oldResource: AudioResource, newResource: AudioResource, plan: { enabled: boolean; durationMs: number }, session?: PlaybackSession): void {
		void oldResource;
		this.volume?.apply(newResource, 0);
		const wait = this.transitions?.beatWaitMs(session?.track ?? null, session?.position ?? 0) ?? 0;
		const begin = () => {
			if (session && !session.isActive()) return;
			this.audioPlayer.play(newResource);
			if (session) session.setResource(newResource);
			this.activeResource = newResource;
			const start = Date.now();
			this.fadeTimer = setInterval(() => {
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				this.volume?.apply(newResource, p);
				if (p >= 1) this.cancelFade();
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait);
		else begin();
	}
	private cancelFade() { if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; } }
	private cancelTransition() { if (this.transitionTimer) { clearTimeout(this.transitionTimer); this.transitionTimer = null; } this.cancelFade(); }
	public pause(): boolean { return this.audioPlayer.pause(true); }
	public resume(): boolean { return this.audioPlayer.unpause(); }
	public stop(): boolean { this.cancelTransition(); this.activeResource = null; return this.audioPlayer.stop(true); }
	public seek(position: number, session?: PlaybackSession): boolean {
		if (!session?.isActive()) return false;
		const resource = this.audioPlayer.state.status === AudioPlayerStatus.Playing || this.audioPlayer.state.status === AudioPlayerStatus.Paused ? this.audioPlayer.state.resource : null;
		if (!resource) return false;
		const target = Math.max(0, position);
		const stream: any = (resource as any).playStream;
		if (stream && typeof stream.seek === "function") { try { stream.seek(target); session.updatePosition(target); return true; } catch {} }
		return false;
	}
	public setVolume(value: number): number { const v = this.volume?.setVolume(value) ?? value; if (this.activeResource) this.volume?.apply(this.activeResource); return v; }
	public get volumeValue(): number { return this.volume?.value ?? 100; }
	public get state(): AudioPlayerState { return this.audioPlayer.state; }
	public get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
	public dispose(): void { this.cancelTransition(); this.audioPlayer.removeListener("stateChange", this.onStateChange); this.audioPlayer.stop(true); this.activeResource = null; }
}
