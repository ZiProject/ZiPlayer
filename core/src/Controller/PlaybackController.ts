import {
	AudioPlayer,
	AudioPlayerState,
	AudioPlayerStatus,
	AudioResource,
	createAudioResource,
} from "@discordjs/voice";
import { Readable } from "stream";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";

export interface PlaybackControllerOptions {
	audioPlayer: AudioPlayer;
	bus?: PlayerBus;
}

export class PlaybackController {
	public readonly audioPlayer: AudioPlayer;
	private readonly bus?: PlayerBus;
	private readonly onStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void;

	public constructor(options: PlaybackControllerOptions) {
		this.audioPlayer = options.audioPlayer;
		this.bus = options.bus;
		this.onStateChange = (oldState, newState) => {
			this.bus?.publish("stateChanged", oldState, newState);
		};
		this.audioPlayer.on("stateChange", this.onStateChange);
	}

	public createResource(stream: Readable): AudioResource { return createAudioResource(stream); }
	public play(resource: AudioResource, session?: PlaybackSession): void {
		if (session && !session.isActive()) return;
		if (session) session.setResource(resource);
		this.audioPlayer.play(resource);
	}
	public pause(): boolean { return this.audioPlayer.pause(true); }
	public resume(): boolean { return this.audioPlayer.unpause(); }
	public stop(): boolean { return this.audioPlayer.stop(true); }
	public get state(): AudioPlayerState { return this.audioPlayer.state; }
	public get status(): AudioPlayerStatus { return this.audioPlayer.state.status; }
	public dispose(): void {
		this.audioPlayer.removeListener("stateChange", this.onStateChange);
		this.audioPlayer.stop(true);
	}
}
