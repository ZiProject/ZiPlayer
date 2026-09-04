import type { AudioPlayerState, VoiceConnection } from "@discordjs/voice";
import type { Track, StreamInfo, VoiceChannel, PlaybackSessionSnapshot } from ".";

export type { PlayerBus } from "../structures/PlayerBus";

export type PlayerRequestId = string;
export type PlayerSessionId = string;

export enum PlayerActionPriority {
	BACKGROUND = 0,
	NORMAL = 10,
	HIGH = 50,
	CRITICAL = 100,
}

export interface PlayerMessageContext {
	readonly requestId: PlayerRequestId;
	readonly sessionId?: PlayerSessionId;
	readonly source?: string;
	readonly signal: AbortSignal;
	readonly timestamp: number;
	readonly priority: PlayerActionPriority;
}

/** @deprecated Use PlayerMessageContext. */
export type PlayerActionExecutionContext = PlayerMessageContext;

export type PlayerAction =
	| { type: "PLAY"; track?: Track; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "PAUSE"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "RESUME"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SEEK"; position: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "STOP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SKIP"; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "SET_VOLUME"; volume: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "QUEUE_NEXT"; ignoreLoop?: boolean; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "QUEUE_SET_CURRENT"; track: Track | null; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "FILTER_SET_SOURCE_TYPE"; streamType: string; priority?: PlayerActionPriority; requestId?: PlayerRequestId }
	| { type: "FILTER_APPLY_AND_SEEK"; streamInfo: StreamInfo; position?: number; priority?: PlayerActionPriority; requestId?: PlayerRequestId };
export type PlayerActionType = PlayerAction["type"];

export type PlayerConnectionInput =
	| { type: "[Player]->[Connection]:connect"; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: "[Player]->[Connection]:disconnect"; requestId: PlayerRequestId; reason?: string }
	| { type: "[Player]->[Connection]:reconnect"; requestId: PlayerRequestId; channel: VoiceChannel };
export type PlayerPreloadInput = { type: "[Player]->[Preload]:request"; requestId: PlayerRequestId; track: Track };
export type PlayerRecoveryInput = { type: "[Player]->[Recovery]:recover"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; reason: string };
export type PlayerResourceInput = { type: "[Player]->[Resource]:refresh"; requestId: PlayerRequestId; position?: number };
export type PlayerInput = PlayerConnectionInput | PlayerPreloadInput | PlayerRecoveryInput | PlayerResourceInput;

export type PlayerConnectionOutput =
	| { type: "[Connection]->[Player]:connecting"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel }
	| { type: "[Connection]->[Player]:connected"; requestId: PlayerRequestId; sessionId: PlayerSessionId; channel: VoiceChannel; connection: VoiceConnection }
	| { type: "[Connection]->[Player]:disconnected"; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| { type: "[Connection]->[Player]:error"; requestId: PlayerRequestId; sessionId?: PlayerSessionId; operation: "connect" | "disconnect" | "reconnect"; error: Error };
export type PlayerPreloadOutput =
	| { type: "[Preload]->[Player]:loading"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:ready"; requestId: PlayerRequestId; track: Track }
	| { type: "[Preload]->[Player]:failed"; requestId: PlayerRequestId; track: Track; error: Error };
export type PlayerRecoveryOutput =
	| { type: "[Recovery]->[Player]:retrying"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; attempt: number }
	| { type: "[Recovery]->[Player]:recovered"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: "[Recovery]->[Player]:failed"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; error: Error };
export type PlayerResourceOutput =
	| { type: "[Resource]->[Player]:refreshed"; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: "[Resource]->[Player]:error"; requestId: PlayerRequestId; error: Error };
export type PlayerOutput = PlayerConnectionOutput | PlayerPreloadOutput | PlayerRecoveryOutput | PlayerResourceOutput;
export type PlayerBusEvents = PlayerInput | PlayerOutput;

export type PlayerLifecycleEvents = { type: "initialized" } | { type: "ready" } | { type: "destroyed" };
export type PlayerPlaybackEvents =
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot; track: Track }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "STREAM_ABORTED"; session: PlaybackSessionSnapshot }
	| { type: "playbackStateChanged"; session: PlaybackSessionSnapshot }
	| { type: "playbackSessionCreated"; session: PlaybackSessionSnapshot }
	| { type: "trackRequested"; track: Track; session: PlaybackSessionSnapshot }
	| { type: "stateChanged"; oldState: AudioPlayerState; newState: AudioPlayerState };
export type PlayerRecoveryEvents =
	| { type: "STUCK_DETECTED"; session: PlaybackSessionSnapshot; reason: string }
	| { type: "RECOVERY_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "RECOVERY_FAILED"; session: PlaybackSessionSnapshot };
export interface PlayerPreloadState { requestedTrack: Track | null; valid: boolean; }
export type PlayerPreloadEvents =
	| { type: "preloadStateChanged"; state: PlayerPreloadState }
	| { type: "preloadPromoted"; track: Track }
	| { type: "preloadCancelled" };
export type PlayerQueueEvents = { type: "queueChanged"; queue: Track[] };
export type PlayerVolumeEvents = { type: "volumeRequested"; volume: number };
export type PlayerEvent = PlayerLifecycleEvents | PlayerPlaybackEvents | PlayerRecoveryEvents | PlayerPreloadEvents | PlayerQueueEvents | PlayerVolumeEvents;
export type PlayerEventType = PlayerEvent["type"];

export type PlayerEventArgsMap = {
	[K in PlayerEventType]: K extends "initialized" | "ready" | "destroyed" | "preloadCancelled" ? []
	: K extends ("TRACK_LOADING" | "TRACK_LOADED" | "TRACK_STARTED" | "TRACK_END" | "STREAM_ABORTED" | "playbackStateChanged" | "playbackSessionCreated" | "RECOVERY_STARTED" | "RECOVERY_FAILED") ? [PlaybackSessionSnapshot]
	: K extends "TRACK_ERROR" ? [PlaybackSessionSnapshot, Error]
	: K extends "STUCK_DETECTED" ? [PlaybackSessionSnapshot, string]
	: K extends "trackRequested" ? [Track, PlaybackSessionSnapshot]
	: K extends "queueChanged" ? [Track[]]
	: K extends "volumeRequested" ? [number]
	: K extends "stateChanged" ? [AudioPlayerState, AudioPlayerState]
	: K extends "preloadStateChanged" ? [PlayerPreloadState]
	: K extends "preloadPromoted" ? [Track]
	: never;
};

export interface PlayerRequestReplyMap {
	"[Player]->[Connection]:connect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>; progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }> };
	"[Player]->[Connection]:disconnect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:disconnected" }> };
	"[Player]->[Connection]:reconnect": { success: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connected" }>; progress: Extract<PlayerConnectionOutput, { type: "[Connection]->[Player]:connecting" }> };
	"[Player]->[Preload]:request": { success: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:ready" }>; progress: Extract<PlayerPreloadOutput, { type: "[Preload]->[Player]:loading" }> };
	"[Player]->[Recovery]:recover": { success: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:recovered" }>; progress: Extract<PlayerRecoveryOutput, { type: "[Recovery]->[Player]:retrying" }> };
	"[Player]->[Resource]:refresh": { success: Extract<PlayerResourceOutput, { type: "[Resource]->[Player]:refreshed" }> };
}
export type PlayerRequestInputType = keyof PlayerRequestReplyMap;
export type PlayerRequestReply<K extends PlayerRequestInputType> = PlayerRequestReplyMap[K];
export type PlayerRequestProgress<K extends PlayerRequestInputType> = PlayerRequestReply<K> extends { progress: infer P } ? P : never;
export interface PlayerRequestOptions<K extends PlayerRequestInputType = PlayerRequestInputType> { timeoutMs?: number; signal?: AbortSignal; onProgress?: (event: PlayerRequestProgress<K>) => void; }
export type PlayerBusRequestErrorReason = "timeout" | "aborted" | "disposed" | "unhandled";

export type PlayerQuery = keyof PlayerQueryMap;
export interface PlayerQueryMap {
	currentTrack: Track | null;
	queueCurrent: Track | null;
	playerState: PlaybackSessionSnapshot["status"] | "idle";
	queue: Track[];
	relatedTracks: Track[] | null;
	playbackSession: PlaybackSessionSnapshot | null;
	currentResource: unknown | null;
	position: number | null;
	volume: number;
	isPlaying: boolean;
	isPaused: boolean;
	filterString: string;
	filteredStream: StreamInfo | null;
	transitionSettings: Record<string, unknown>;
	retryPolicy: Record<string, unknown>;
}
export type PlayerQueryHandler<K extends PlayerQuery> = () => PlayerQueryMap[K] | Promise<PlayerQueryMap[K]>;
