import type { PlayerBus, PlayerAction } from "./PlayerBus";
import { createPlayerRequestId } from "./PlayerBus";
import { PlaybackSession } from "./PlaybackSession";
import type { Track } from "../types";
import type { TrackLoader } from "./TrackLoader";
import type { StreamController } from "../Controller/StreamController";
import type { PlaybackController } from "../Controller/PlaybackController";
import type { QueueController } from "../Controller/QueueController";
import type { AntiStuckController } from "../Controller/AntiStuckController";
import type { TransitionController } from "../Controller/TransitionController";
import type { PreloadController } from "../Controller/PreloadController";

export interface PlaybackOrchestratorOptions {
 trackLoader?: TrackLoader; streamController?: StreamController; playbackController?: PlaybackController;
 queueController?: QueueController; antiStuckController?: AntiStuckController; transitionController?: TransitionController; preloadController?: PreloadController;
}

/** Coordinates Player playback actions. Public Player methods enqueue actions through PlayerAction. */
export class PlaybackOrchestrator {
 private session: PlaybackSession | null = null;
 private readonly detachAction: () => void;
 private readonly detachQueries: Array<() => void> = [];
 private readonly trackLoader?: TrackLoader; private readonly streamController?: StreamController; private readonly playbackController?: PlaybackController;
 private readonly queueController?: QueueController; private readonly antiStuckController?: AntiStuckController; private readonly transitionController?: TransitionController; private readonly preloadController?: PreloadController;
 constructor(private readonly bus: PlayerBus, o: PlaybackOrchestratorOptions = {}) {
  this.trackLoader=o.trackLoader; this.streamController=o.streamController; this.playbackController=o.playbackController; this.queueController=o.queueController; this.antiStuckController=o.antiStuckController; this.transitionController=o.transitionController; this.preloadController=o.preloadController;
  this.detachAction=bus.onAction((action, context)=>this.handleAction(action, context.signal));
  this.detachQueries.push(bus.registerQuery("currentTrack",()=>this.session?.track??this.queueController?.queue.currentTrack??null),bus.registerQuery("playerState",()=>this.session?.status??"idle"),bus.registerQuery("queue",()=>this.queueController?.snapshot()??[]),bus.registerQuery("playbackSession",()=>this.session?.snapshot()??null),bus.registerQuery("position",()=>this.session?.position??null),bus.registerQuery("volume",()=>100),bus.registerQuery("isPlaying",()=>this.session?.status==="playing"),bus.registerQuery("isPaused",()=>this.session?.status==="paused"));
 }
 get currentSession(): PlaybackSession|null{return this.session;}
 get transitionPolicy(): TransitionController|undefined{return this.transitionController;}
 dispose():void{this.detachAction();for(const d of this.detachQueries)d();this.session?.destroy();this.session=null;}
 private async handleAction(a:PlayerAction,signal:AbortSignal):Promise<void>{if(signal.aborted)return;switch(a.type){case"PLAY":if(a.track)await this.start(a.track,signal);return;case"PAUSE":this.playbackController?.pause();this.session?.markPaused();this.publishState();return;case"RESUME":this.playbackController?.resume();this.session?.markPlaying();this.publishState();return;case"SEEK":await this.seek(a.position,signal);return;case"STOP":await this.stop(signal);return;case"SKIP":await this.skip(signal);return;case"SET_VOLUME":this.bus.publish("volumeRequested",a.volume);return;}}
 private async stop(signal:AbortSignal):Promise<void>{if(signal.aborted)return;this.playbackController?.stop();this.antiStuckController?.clear(this.session??undefined);this.session?.markStopped();this.streamController?.abortCurrent();this.trackLoader?.cancelPreload();this.publishState();}
 private async skip(signal:AbortSignal):Promise<void>{if(signal.aborted)return;this.playbackController?.stop();if(this.session){this.antiStuckController?.clear(this.session);this.session.markEnded();this.bus.event({type:"TRACK_END",session:this.session.snapshot()});}this.streamController?.abortCurrent();this.trackLoader?.cancelPreload();const next=this.queueController?.next(true);if(next)await this.start(next,signal);}
 private async seek(position:number,signal:AbortSignal):Promise<void>{const s=this.session,t=s?.track;if(!s||!t||signal.aborted)return;const duration=t.duration>1000?t.duration:t.duration*1000;if(position<0||position>duration)return;s.updatePosition(position);this.publishState();}
 private async start(track:Track,signal:AbortSignal):Promise<void>{if(signal.aborted)return;this.playbackController?.stop();this.streamController?.abortCurrent();this.antiStuckController?.clear(this.session??undefined);this.trackLoader?.resetRecovery(this.session?.track??undefined);this.trackLoader?.cancelPreload();this.session?.destroy();const s=new PlaybackSession();this.session=s;s.begin(track);this.queueController?.queue.setCurrentTrack(track);this.bus.event({type:"TRACK_LOADING",session:s.snapshot()});if(!this.trackLoader||!this.streamController||!this.playbackController){this.bus.publish("playbackSessionCreated",s.snapshot());this.bus.publish("trackRequested",track,s);return;}try{const loaded=await this.trackLoader.loadWithRecovery(track,s);if(signal.aborted||!this.session?.owns(s.id))return;this.bus.event({type:"TRACK_LOADED",session:s.snapshot()});if(loaded.stream.remote&&loaded.stream.handle){this.bus.publish("trackRequested",loaded.track,s);return;}const active=await this.streamController.replace(loaded.stream,s);if(signal.aborted||!this.session?.owns(s.id))return;const resource=this.streamController.createResource(active.stream,loaded.track);s.setResource(resource);this.playbackController.play(resource,s);s.markPlaying();this.bus.event({type:"TRACK_STARTED",session:s.snapshot()});await this.requestPreload(loaded.track,signal);}catch(error){if(!s.signal.aborted&&!signal.aborted)this.bus.event({type:"TRACK_ERROR",session:s.snapshot(),error:error instanceof Error?error:new Error(String(error))});}}
 private async requestPreload(track:Track,signal:AbortSignal):Promise<void>{if(!this.preloadController||signal.aborted)return;try{await this.bus.request({type:"[Player]->[Preload]:request",requestId:createPlayerRequestId(),track},{signal,timeoutMs:30000});}catch{}}
 private publishState():void{if(this.session)this.bus.publish("playbackStateChanged",this.session.snapshot());}
}
