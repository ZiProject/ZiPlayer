import { AudioPlayer, AudioPlayerState, AudioPlayerStatus, AudioResource, createAudioResource } from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { VolumeController } from "./VolumeController";
import type { TransitionController } from "./TransitionController";

export interface PlaybackControllerOptions { audioPlayer: AudioPlayer; bus?: PlayerBus; volumeController?: VolumeController; transitionController?: TransitionController; }
export class PlaybackController {
 public readonly audioPlayer: AudioPlayer; private readonly bus?: PlayerBus; private readonly volume?: VolumeController; private readonly transitions?: TransitionController;
 private readonly onStateChange:(oldState:AudioPlayerState,newState:AudioPlayerState)=>void;
 constructor(options:PlaybackControllerOptions){this.audioPlayer=options.audioPlayer;this.bus=options.bus;this.volume=options.volumeController;this.transitions=options.transitionController;this.onStateChange=(oldState,newState)=>this.bus?.publish("stateChanged",oldState,newState);this.audioPlayer.on("stateChange",this.onStateChange);}
 public createResource(stream:Readable,track?:{duration?:number}):AudioResource{const resource=createAudioResource(stream);this.volume?.apply(resource);return resource;}
 public play(resource:AudioResource,session?:PlaybackSession,from?:any,to?:any):void{if(session&&!session.isActive())return;if(session)session.setResource(resource);this.volume?.apply(resource);this.audioPlayer.play(resource);if(from&&to)this.bus?.publish("transitionPlanned",this.transitions?.plan(from,to));}
 public pause():boolean{return this.audioPlayer.pause(true);} public resume():boolean{return this.audioPlayer.unpause();} public stop():boolean{return this.audioPlayer.stop(true);} public seek(position:number):boolean{const resource=this.audioPlayer.state.status===AudioPlayerStatus.Playing||this.audioPlayer.state.status===AudioPlayerStatus.Paused?this.audioPlayer.state.resource:null;if(!resource?.playStream)return false;return false;}
 public setVolume(value:number):number{return this.volume?.setVolume(value)??value;} public get volumeValue():number{return this.volume?.value??100;}
 public get state():AudioPlayerState{return this.audioPlayer.state;} public get status():AudioPlayerStatus{return this.audioPlayer.state.status;}
 public dispose():void{this.audioPlayer.removeListener("stateChange",this.onStateChange);this.audioPlayer.stop(true);}
}
