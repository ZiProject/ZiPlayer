import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";

export interface PlaybackControllerOptions { audioPlayer: AudioPlayer; bus?: PlayerBus; volumeController?: VolumeController; transitionController?: TransitionController; }

export class PlaybackController {
	public readonly audioPlayer: AudioPlayer;
	public activeResource: AudioResource | null = null;
	private activeSession: PlaybackSession | null = null;
	private readonly bus?: PlayerBus;
	private readonly volume?: VolumeController;
	private readonly transitions?: TransitionController;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private fadeTimer: ReturnType<typeof setInterval> | null = null;
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;

	constructor(o: PlaybackControllerOptions) {
		this.audioPlayer = o.audioPlayer;
		this.bus = o.bus;
		this.volume = o.volumeController;
		this.transitions = o.transitionController;
		this.onStateChange = (a, b) => {
			this.bus?.publish("stateChanged", a, b);
			if (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle) {
				// A replaced resource can emit a late Idle transition. Only the
				// resource owned by the active session may end that session.
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

	public createResource(stream: Readable, track: Track): AudioResource {
		const resource = createAudioResource(stream, { metadata: track, inlineVolume: true });
		this.volume?.applyLoudness(resource, track);
		return resource;
	}

	public play(resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
		if (session && !session.isActive()) return;
		this.cancelTransition();
		const track = session?.track ?? to ?? (resource.metadata as Track | undefined);
		this.volume?.applyLoudness(resource, track);
		const plan = from && to ? this.transitions?.plan(from, to) : undefined;
		if (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) { this.crossfade(this.activeResource, resource, plan, session, track); return; }
		if (session) session.setResource(resource);
		this.activeSession = session ?? null;
		this.activeResource = resource;
		this.audioPlayer.play(resource);
	}

	private crossfade(oldResource: AudioResource, newResource: AudioResource, plan: { enabled: boolean; durationMs: number }, session?: PlaybackSession, track?: Track): void {
		void oldResource;
		this.volume?.applyLoudness(newResource, track, 0);
		const wait = this.transitions?.beatWaitMs(session?.track ?? null, session?.position ?? 0) ?? 0;
		const begin = () => {
			if (session && !session.isActive()) return;
			this.audioPlayer.play(newResource);
			if (session) session.setResource(newResource);
			this.activeSession = session ?? null;
			this.activeResource = newResource;
			const start = Date.now();
			this.fadeTimer = setInterval(() => {
				if (session && !session.isActive()) { this.cancelFade(); return; }
				const p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
				this.volume?.applyLoudness(newResource, track, p);
				if (p >= 1) this.cancelFade();
			}, 25);
		};
		if (wait > 0) this.transitionTimer = setTimeout(begin, wait); else begin();
	}

	private cancelFade() { if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; } }
	private cancelTransition() { if (this.transitionTimer) { clearTimeout(this.transitionTimer); this.transitionTimer = null; } this.cancelFade(); }
	public pause(): boolean { return this.audioPlayer.pause(true); }
	public resume(): boolean { return this.audioPlayer.unpause(); }
	public stop(): boolean { this.cancelTransition(); this.activeSession = null; this.activeResource = null; return this.audioPlayer.stop(true); }
	public seek(position: number, session?: PlaybackSession): boolean {
		if (!session?.isActive()) return false;
		const resource = this.audioPlayer.state.status === AudioPlayerStatus.Playing || this.audioPlayer.state.status === AudioPlayerStatus.Paused ? this.audioPlayer.state.resource : null;
		if (!resource) return false;
		const target = Math.max(0, position);
		const stream: any = (resource as any).playStream;
		if (stream && typeof stream.seek === "function") {
			try { stream.seek(target); session.updatePosition(target); return true; } catch {}
		}
		return false;
	}
	public setVolume(value: number): number {
		const v = this.volume?.setVolume(value) ?? value;
		if (this.activeResource) {
			const track = this.activeSession?.track ?? (this.activeResource.metadata as Track | undefined);
			this.volume?.applyLoudness(this.activeResource, track);
		}
		return v;
	}
	public get volumeValue(): number { return this.volume?.value ?? 100; }
	public get state(): AudioPlayerState { return this.audioPlayer.state; }
	public get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
	public dispose(): void {
		this.cancelTransition();
		this.activeSession?.destroy();
		this.activeSession = null;
		this.audioPlayer.removeListener("stateChange", this.onStateChange);
		this.audioPlayer.stop(true);
		this.activeResource = null;
	}
}
