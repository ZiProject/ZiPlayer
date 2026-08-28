import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track } from "../types";
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";

export interface PlaybackControllerOptions {
\taudioPlayer: AudioPlayer;
\tbus?: PlayerBus;
\tvolumeController?: VolumeController;
\ttransitionController?: TransitionController;
}
export class PlaybackController {
\tpublic readonly audioPlayer: AudioPlayer;
\tpublic activeResource: AudioResource | null = null;

\tprivate readonly bus?: PlayerBus;
\tprivate readonly volume?: VolumeController;
\tprivate readonly transitions?: TransitionController;
\tprivate activeSession: PlaybackSession | null = null;
\tprivate suppressTrackEnd = false;
\tprivate transitionTimer: ReturnType<typeof setTimeout> | null = null;
\tprivate fadeTimer: ReturnType<typeof setInterval> | null = null;
\tprivate readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;
\tconstructor(o: PlaybackControllerOptions) {
\t\tthis.audioPlayer = o.audioPlayer;
\t\tthis.bus = o.bus;
\t\tthis.volume = o.volumeController;
\t\tthis.transitions = o.transitionController;
\t\tthis.onStateChange = (a, b) => {
\t\t\tthis.bus?.publish("stateChanged", a, b);
\t\t\tif (b.status === AudioPlayerStatus.Idle && a.status !== AudioPlayerStatus.Idle && !this.suppressTrackEnd) {
\t\t\t\tconst session = this.activeSession;
\t\t\t\tif (session) this.bus?.event({ type: "TRACK_END", session: session.snapshot() });
\t\t\t\tthis.activeSession = null;
\t\t\t\tthis.activeResource = null;
\t\t\t}
\t\t};
\t\tthis.audioPlayer.on("stateChange", this.onStateChange);
\t}
\tpublic createResource(stream: Readable, track: Track): AudioResource {
\t\tconst resource = createAudioResource(stream, { metadata: track, inlineVolume: true });
\t\tthis.volume?.apply(resource);
\t\treturn resource;
\t}
\tpublic play(resource: AudioResource, session?: PlaybackSession, from?: Track | null, to?: Track): void {
\t\tif (session && !session.isActive()) return;
\t\tthis.cancelTransition();
\t\tthis.volume?.apply(resource);
\t\tconst plan = from && to ? this.transitions?.plan(from, to) : undefined;
\t\tif (plan?.enabled && this.activeResource && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
\t\t\tthis.crossfade(this.activeResource, resource, plan, session);
\t\t\treturn;
\t\t}
\t\tif (session) this.activeSession = session;
\t\tif (session) session.setResource(resource);
\t\tthis.activeResource = resource;
\t\tthis.audioPlayer.play(resource);
\t}
\tprivate crossfade(oldResource: AudioResource, newResource: AudioResource, plan: { enabled: boolean; durationMs: number }, session?: PlaybackSession): void {
\t\tvoid oldResource;
\t\tthis.volume?.apply(newResource, 0);
\t\tconst wait = this.transitions?.beatWaitMs(session?.track ?? null, session?.position ?? 0) ?? 0;
\t\tconst begin = () => {
\t\t\tif (session && !session.isActive()) return;
\t\t\tthis.audioPlayer.play(newResource);
\t\t\tif (session) this.activeSession = session;
\t\t\tif (session) session.setResource(newResource);
\t\t\tthis.activeResource = newResource;
\t\t\tconst start = Date.now();
\t\t\tthis.fadeTimer = setInterval(() => {
\t\t\t\tconst p = Math.min(1, (Date.now() - start) / Math.max(1, plan.durationMs));
\t\t\t\tthis.volume?.apply(newResource, p);
\t\t\t\tif (p >= 1) this.cancelFade();
\t\t\t}, 25);
\t\t};
\t\tif (wait > 0) this.transitionTimer = setTimeout(begin, wait);
\t\telse begin();
\t}
\tprivate cancelFade() { if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; } }
\tprivate cancelTransition() { if (this.transitionTimer) { clearTimeout(this.transitionTimer); this.transitionTimer = null; } this.cancelFade(); }
\tpublic pause(): boolean { return this.audioPlayer.pause(true); }
\tpublic resume(): boolean { return this.audioPlayer.unpause(); }
\tpublic stop(): boolean {
\t\tthis.cancelTransition();
\t\tthis.suppressTrackEnd = true;
\t\ttry { return this.audioPlayer.stop(true); }
\t\tfinally {
\t\t\tthis.suppressTrackEnd = false;
\t\t\tthis.activeSession = null;
\t\t\tthis.activeResource = null;
\t\t}
\t}
\tpublic seek(position: number, session?: PlaybackSession): boolean {
\t\tif (!session?.isActive()) return false;
\t\tconst resource = this.audioPlayer.state.status === AudioPlayerStatus.Playing || this.audioPlayer.state.status === AudioPlayerStatus.Paused ? this.audioPlayer.state.resource : null;
\t\tif (!resource) return false;
\t\tconst target = Math.max(0, position);
\t\tconst stream: any = (resource as any).playStream;
\t\tif (stream && typeof stream.seek === "function") { try { stream.seek(target); session.updatePosition(target); return true; } catch {} }
\t\treturn false;
\t}
\tpublic setVolume(value: number): number { const v = this.volume?.setVolume(value) ?? value; if (this.activeResource) this.volume?.apply(this.activeResource); return v; }
\tpublic get volumeValue(): number { return this.volume?.value ?? 100; }
\tpublic get state(): AudioPlayerState { return this.audioPlayer.state; }
\tpublic get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
\tpublic dispose(): void { this.cancelTransition(); this.suppressTrackEnd = true; this.audioPlayer.removeListener("stateChange", this.onStateChange); this.audioPlayer.stop(true); this.activeSession = null; this.activeResource = null; this.suppressTrackEnd = false; }
}
