import type { AudioPlayerState, VoiceConnection } from "@discordjs/voice";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { BUS_OUTPUT, BUS_REQUEST } from "../structures/BusContract";
import type {
	Track,
	StreamInfo,
	VoiceChannel,
	PlaybackSessionSnapshot,
	SearchResult,
	SearchDebugResult,
	ForwardHealthStatus,
	LoopMode,
	PlaybackMode,
	TrackLoadResult,
	SaveOptions,
	SaveVideoOptions,
} from ".";

export type { Bus } from "../structures/Bus";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { AudioResource } from "@discordjs/voice";
import type { Readable } from "stream";
import type { Player } from "../structures/Player";
import type { PlayerQueue } from "../controller/QueueController";

export type PlayerRequestId = string;
export type PlayerSessionId = string;

export enum PlayerActionPriority {
	BACKGROUND = 0,
	NORMAL = 10,
	HIGH = 50,
	CRITICAL = 100,
}

export interface PlayerMessageContext {
	readonly playerId: string;
	readonly requestId: PlayerRequestId;
	readonly sessionId?: PlayerSessionId;
	readonly source?: string;
	readonly timestamp?: number;
	readonly signal: AbortSignal;
	readonly priority: PlayerActionPriority;
}

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
	| {
			type: "FILTER_APPLY_AND_SEEK";
			streamInfo: StreamInfo;
			position?: number;
			priority?: PlayerActionPriority;
			requestId?: PlayerRequestId;
	  };
export type PlayerActionType = PlayerAction["type"];

export type PlayerConnectionInput =
	| { type: typeof BUS_REQUEST.connectionConnect; requestId: PlayerRequestId; channel: VoiceChannel }
	| { type: typeof BUS_REQUEST.connectionDisconnect; requestId: PlayerRequestId; reason?: string }
	| { type: typeof BUS_REQUEST.connectionReconnect; requestId: PlayerRequestId; channel: VoiceChannel };
export type PlayerPreloadInput = { type: typeof BUS_REQUEST.preloadRequest; requestId: PlayerRequestId; track: Track };
export type PlayerRecoveryInput = {
	type: typeof BUS_REQUEST.recoveryRecover;
	requestId: PlayerRequestId;
	session: PlaybackSessionSnapshot;
	reason: string;
};
export type PlayerResourceInput = { type: typeof BUS_REQUEST.resourceRefresh; requestId: PlayerRequestId; position?: number };
export type PlayerInput = (PlayerConnectionInput | PlayerPreloadInput | PlayerRecoveryInput | PlayerResourceInput) & {
	readonly playerId: string;
};

export type PlayerConnectionOutput =
	| {
			type: typeof BUS_OUTPUT.connectionConnecting;
			requestId: PlayerRequestId;
			sessionId: PlayerSessionId;
			channel: VoiceChannel;
	  }
	| {
			type: typeof BUS_OUTPUT.connectionConnected;
			requestId: PlayerRequestId;
			sessionId: PlayerSessionId;
			channel: VoiceChannel;
			connection: VoiceConnection;
	  }
	| { type: typeof BUS_OUTPUT.connectionDisconnected; requestId?: PlayerRequestId; sessionId: PlayerSessionId; reason?: string }
	| {
			type: typeof BUS_OUTPUT.connectionError;
			requestId: PlayerRequestId;
			sessionId?: PlayerSessionId;
			operation: "connect" | "disconnect" | "reconnect";
			error: Error;
	  };
export type PlayerPreloadOutput =
	| { type: typeof BUS_OUTPUT.preloadLoading; requestId: PlayerRequestId; track: Track }
	| { type: typeof BUS_OUTPUT.preloadReady; requestId: PlayerRequestId; track: Track }
	| { type: typeof BUS_OUTPUT.preloadFailed; requestId: PlayerRequestId; track: Track; error: Error };
export type PlayerRecoveryOutput =
	| { type: typeof BUS_OUTPUT.recoveryRetrying; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; attempt: number }
	| { type: typeof BUS_OUTPUT.recoveryRecovered; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: typeof BUS_OUTPUT.recoveryFailed; requestId: PlayerRequestId; session: PlaybackSessionSnapshot; error: Error };
export type PlayerResourceOutput =
	| { type: typeof BUS_OUTPUT.resourceRefreshed; requestId: PlayerRequestId; session: PlaybackSessionSnapshot }
	| { type: typeof BUS_OUTPUT.resourceError; requestId: PlayerRequestId; error: Error };
export type PlayerOutput = (PlayerConnectionOutput | PlayerPreloadOutput | PlayerRecoveryOutput | PlayerResourceOutput) & {
	readonly playerId: string;
};
export type BusEvents = PlayerInput | PlayerOutput;

export type PlayerLifecycleEvents = { type: "initialized" } | { type: "ready" } | { type: "destroyed" };
export type PlayerPlaybackEvents =
	| { type: "TRACK_LOADING"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_LOADED"; session: PlaybackSessionSnapshot }
	| { type: "TRACK_STARTED"; session: PlaybackSessionSnapshot; track: Track }
	| { type: "TRACK_ERROR"; session: PlaybackSessionSnapshot; error: Error }
	| { type: "TRACK_END"; session: PlaybackSessionSnapshot }
	| { type: "STREAM_ABORTED"; session: PlaybackSessionSnapshot }
	| { type: "playbackStateChanged"; session: PlaybackSessionSnapshot | null }
	| { type: "playbackSessionCreated"; session: PlaybackSessionSnapshot }
	| { type: "trackRequested"; track: Track; session: PlaybackSessionSnapshot }
	| { type: "stateChanged"; oldState: AudioPlayerState; newState: AudioPlayerState };
export type PlayerPublicEvents =
	| { type: "willPlay"; track: Track; upcomingTracks: Track[] }
	| { type: "queueEnd" }
	| { type: "playerPause"; track: Track | null }
	| { type: "playerResume"; track: Track | null }
	| { type: "playerStop" }
	| { type: "seek"; track: Track; position: number }
	| { type: "filterApplied"; filter: import("./filter").AudioFilter }
	| { type: "filterRemoved"; filter: import("./filter").AudioFilter }
	| { type: "filtersCleared" }
	| { type: "streamError"; error: Error; track: Track | null }
	| { type: "forwardModeStart"; leader: Player }
	| { type: "forwardModeEnd"; leader: Player; reason?: string };
export type PlayerRecoveryEvents =
	| { type: "STUCK_DETECTED"; session: PlaybackSessionSnapshot; reason: string }
	| { type: "RECOVERY_STARTED"; session: PlaybackSessionSnapshot }
	| { type: "RECOVERY_FAILED"; session: PlaybackSessionSnapshot };
export interface PlayerPreloadState {
	requestedTrack: Track | null;
	valid: boolean;
}
export type PlayerPreloadEvents =
	| { type: "preloadStateChanged"; state: PlayerPreloadState }
	| { type: "preloadPromoted"; track: Track }
	| { type: "preloadCancelled" };
export type PlayerQueueEvents = { type: "queueChanged"; queue: Track[] };
export type PlayerVolumeEvents = { type: "volumeRequested"; volume: number; oldVolume: number; newVolume: number };
export type PlayerEvent =
	| PlayerLifecycleEvents
	| PlayerPlaybackEvents
	| PlayerPublicEvents
	| PlayerRecoveryEvents
	| PlayerPreloadEvents
	| PlayerQueueEvents
	| PlayerVolumeEvents;
export type PlayerEventType = PlayerEvent["type"];

export type PlayerEventArgsMap = {
	[K in PlayerEventType]: K extends (
		"initialized" | "ready" | "destroyed" | "preloadCancelled" | "queueEnd" | "playerStop" | "filtersCleared"
	) ?
		[]
	: K extends (
		| "TRACK_LOADING"
		| "TRACK_LOADED"
		| "TRACK_STARTED"
		| "TRACK_END"
		| "STREAM_ABORTED"
		| "playbackStateChanged"
		| "playbackSessionCreated"
		| "RECOVERY_STARTED"
		| "RECOVERY_FAILED"
	) ?
		[PlaybackSessionSnapshot]
	: K extends "TRACK_ERROR" ? [PlaybackSessionSnapshot, Error]
	: K extends "STUCK_DETECTED" ? [PlaybackSessionSnapshot, string]
	: K extends "trackRequested" ? [Track, PlaybackSessionSnapshot]
	: K extends "queueChanged" ? [Track[]]
	: K extends "volumeRequested" ? [number, number, number]
	: K extends "stateChanged" ? [AudioPlayerState, AudioPlayerState]
	: K extends "preloadStateChanged" ? [PlayerPreloadState]
	: K extends "preloadPromoted" ? [Track]
	: K extends "willPlay" ? [Track, Track[]]
	: K extends "playerPause" | "playerResume" ? [Track | null]
	: K extends "seek" ? [Track, number]
	: K extends "filterApplied" | "filterRemoved" ? [import("./filter").AudioFilter]
	: K extends "streamError" ? [Error, Track | null]
	: K extends "forwardModeStart" ? [Player]
	: K extends "forwardModeEnd" ? [Player, string | undefined]
	: never;
};

export type PlayerRequestReplyMap = {
	[Key in (typeof BUS_REQUEST)[keyof typeof BUS_REQUEST]]: Key extends typeof BUS_REQUEST.connectionConnect ?
		{
			success: Extract<PlayerConnectionOutput, { type: typeof BUS_OUTPUT.connectionConnected }>;
			progress: Extract<PlayerConnectionOutput, { type: typeof BUS_OUTPUT.connectionConnecting }>;
		}
	: Key extends typeof BUS_REQUEST.connectionDisconnect ?
		{
			success: Extract<PlayerConnectionOutput, { type: typeof BUS_OUTPUT.connectionDisconnected }>;
		}
	: Key extends typeof BUS_REQUEST.connectionReconnect ?
		{
			success: Extract<PlayerConnectionOutput, { type: typeof BUS_OUTPUT.connectionConnected }>;
			progress: Extract<PlayerConnectionOutput, { type: typeof BUS_OUTPUT.connectionConnecting }>;
		}
	: Key extends typeof BUS_REQUEST.preloadRequest ?
		{
			success: Extract<PlayerPreloadOutput, { type: typeof BUS_OUTPUT.preloadReady }>;
			progress: Extract<PlayerPreloadOutput, { type: typeof BUS_OUTPUT.preloadLoading }>;
		}
	: Key extends typeof BUS_REQUEST.recoveryRecover ?
		{
			success: Extract<PlayerRecoveryOutput, { type: typeof BUS_OUTPUT.recoveryRecovered }>;
			progress: Extract<PlayerRecoveryOutput, { type: typeof BUS_OUTPUT.recoveryRetrying }>;
		}
	: Key extends typeof BUS_REQUEST.resourceRefresh ?
		{
			success: Extract<PlayerResourceOutput, { type: typeof BUS_OUTPUT.resourceRefreshed }>;
		}
	:	never;
};
export type PlayerRequestInputType = (typeof BUS_REQUEST)[keyof typeof BUS_REQUEST];
export type PlayerRequestReply<K extends PlayerRequestInputType> = PlayerRequestReplyMap[K];
export type PlayerRequestProgress<K extends PlayerRequestInputType> =
	PlayerRequestReply<K> extends { progress: infer P } ? P : never;
export interface PlayerRequestOptions<K extends PlayerRequestInputType = PlayerRequestInputType> {
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (event: PlayerRequestProgress<K>) => void;
}
export type BusRequestErrorReason = "timeout" | "aborted" | "disposed" | "unhandled";

export interface PlayerRpcOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	source?: string;
	priority?: PlayerActionPriority;
}
export interface BusRpcContext {
	readonly playerId: string;
	readonly requestId: PlayerRequestId;
	readonly signal: AbortSignal;
	readonly timestamp: number;
}
export interface BusRpcOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}
export interface PlayerRpcMap {
	play: { request: { query: string | Track | SearchResult | null; requestedBy?: string }; response: boolean };
	"volume.set": { request: { value: number }; response: number };
	search: { request: { query: string; requestedBy: string }; response: SearchResult };
	"search.cache.get": { request: { query: string }; response: SearchResult | null };
	"search.cache.set": { request: { query: string; result: SearchResult }; response: void };
	"search.cache.clear": { request: Record<string, never>; response: void };
	"search.cache.purge": { request: Record<string, never>; response: void };
	"search.debug": { request: { query: string }; response: SearchDebugResult };
	"queue.add": { request: { track: Track }; response: number };
	"queue.previous": { request: undefined; response: Track | null };
	"queue.shuffle": { request: undefined; response: void };
	"queue.clear": { request: undefined; response: void };
	"queue.addMultiple": { request: { tracks: Track[] }; response: number };
	"queue.insert": { request: { query: string | Track | Track[]; index?: number; requestedBy?: string }; response: boolean };
	"queue.remove": { request: { index: number }; response: Track | null };
	"queue.loop": { request: { mode: LoopMode }; response: LoopMode };
	"queue.autoPlay": { request: { enabled: boolean }; response: boolean };
	"queue.willNext": { request: { track: Track | null }; response: Track | null };
	"queue.setCurrent": { request: { track: Track | null }; response: void };
	"queue.serialize": { request: undefined; response: object };
	"queue.restore": { request: { state: object }; response: void };
	"queue.restoreNext": { request: { previousCurrent: Track | null; nextTrack: Track | null }; response: void };
	"playback.destroyCurrentStream": { request: undefined; response: void };
	"playback.recover": { request: { track: Track; session: unknown }; response: TrackLoadResult };
	"playback.loadFresh": { request: { track: Track; session: unknown }; response: TrackLoadResult };
	"playback.remote": { request: { track: Track; stream: unknown }; response: boolean };
	"playback.refreshResource": { request: { position: number }; response: PlaybackSessionSnapshot };
	"playback.loadFreshCurrent": { request: { track: Track }; response: TrackLoadResult | null };
	"playback.promotePreload": { request: { track: Track }; response: AudioResource | null };
	"playback.transitionLock": { request: { active: boolean }; response: void };
	"playback.prepareAutoplay": { request: { session: PlaybackSession; context: PlayerMessageContext }; response: Track | null };
	"playback.start": { request: { track: Track; context: PlayerMessageContext; from: Track | null }; response: void };
	"forward.health": { request: undefined; response: ForwardHealthStatus };
	"forward.subscribe": { request: { leader: unknown; options?: { forwardMode?: boolean } }; response: boolean };
	"forward.unsubscribe": { request: { reason?: string }; response: boolean };
	"forward.addFollower": { request: { playerId: string; leaderId: string }; response: boolean };
	"forward.removeFollower": { request: { playerId: string; leaderId: string }; response: boolean };
	"connection.setAudioPlayer": { request: { audioPlayer: import("@discordjs/voice").AudioPlayer | null }; response: void };
	"transition.fade": { request: { resource: AudioResource; from: number; to: number; durationMs: number }; response: void };
	"transition.fadeIn": { request: { resource: AudioResource; track: Track }; response: void };
	"transition.fadeOutCurrent": { request: undefined; response: void };
	"transition.skipAndStop": { request: undefined; response: void };
	"transition.duration": { request: { from: Track | null; to: Track | null }; response: number };
	"transition.beatWait": { request: { track: Track | null; positionMs: number }; response: number };
	"transition.targetVolume": { request: { track: Track | null }; response: number };
	"resource.create": { request: { stream: Readable; track: Track; inputType?: string }; response: AudioResource };
	"track.middleware": { request: { track: Track }; response: Track };
	"stream.resolve": { request: { track: Track; fresh?: boolean }; response: StreamInfo | null };
	"stream.state": { request: Record<string, never> | undefined; response: any };
	"stream.current": { request: Record<string, never> | undefined; response: any };
	"preload.has": { request: { track: Track }; response: boolean };
	"preload.state": { request: Record<string, never> | undefined; response: any };
	"preload.next": { request: undefined; response: void };
	"preload.cancel": { request: undefined; response: void };
	"preload.cancelSafe": { request: undefined; response: void };
	"preload.clear": { request: undefined; response: void };
	"preload.promote": {
		request: { track: Track };
		response: { track: Track; stream: Readable; streamInfo?: StreamInfo; streamId: string | null } | null;
	};
	"plugin.add": { request: { plugin: BasePlugin }; response: void };
	"plugin.remove": { request: { name: string }; response: boolean };
	"plugin.get": { request: { name: string }; response: BasePlugin | undefined };
	"plugin.list": { request: Record<string, never> | undefined; response: BasePlugin[] };
	"plugin.clear": { request: undefined; response: void };
	"plugin.stats": { request: undefined; response: object };
	"plugin.relatedTracks": { request: { track: Track; history?: Track[] }; response: Track[] };
	"extension.add": { request: { extension: BaseExtension }; response: void };
	"extension.remove": { request: { extension: BaseExtension }; response: boolean };
	"extension.get": { request: { name: string }; response: BaseExtension | undefined };
	"extension.list": { request: Record<string, never> | undefined; response: BaseExtension[] };
	"extension.enable": { request: { name: string }; response: boolean };
	"extension.disable": { request: { name: string }; response: boolean };
	"filter.list": { request: Record<string, never> | undefined; response: any };
	"filter.set": { request: { filter: string; value: unknown }; response: any };
	save: { request: { track: Track; options?: SaveOptions | string }; response: Readable };
	"save.video": { request: { track: Track; options?: SaveVideoOptions | string }; response: Readable };
	"lifecycle.scheduleLeave": { request: { reason?: "track-end" | "queue-empty" | "manual" }; response: void };
	"lifecycle.clearLeaveTimeout": { request: undefined; response: void };
}
export type PlayerRpcHandler<TRequest, TResponse> = (
	request: TRequest,
	context: PlayerMessageContext,
) => TResponse | Promise<TResponse>;

export interface PlayerQueryMap {
	audioPlayer: import("@discordjs/voice").AudioPlayer | null;
	connection: import("@discordjs/voice").VoiceConnection | null;
	"connection.state": import("@discordjs/voice").VoiceConnectionStatus | undefined;
	"tts.hasPlayer": boolean;
	"stream.stats": {
		active: number;
		paused: number;
		ended: number;
		error: number;
		destroyed: number;
		total: number;
		bySource: Record<string, number>;
	} | null;
	"stream.state": any;
	"stream.current": any;
	ttsInterrupt: boolean;
	currentTrack: Track | null;
	queueCurrent: Track | null;
	playerState: PlaybackSessionSnapshot["status"];
	queue: Track[];
	/** Live per-player queue state (backs `Player.queue`); `null` when the player has no queue attached. */
	queueState: PlayerQueue | null;
	previousTracks: Track[];
	previousTrack: Track | null;
	willNext: Track | null;
	queueLoop: LoopMode;
	queueAutoPlay: boolean;
	relatedTracks: Track[];
	queueSerialized: object;
	playbackSession: PlaybackSessionSnapshot | null;
	playbackSessionInternal: PlaybackSession | null;
	currentResource: unknown | null;
	position: number | null;
	queueNextTrack: Track | null;
	volume: number;
	isPlaying: boolean;
	isPaused: boolean;
	isLive: boolean;
	isIdle: boolean;
	isBuffering: boolean;
	filterString: string;
	filteredStream: StreamInfo | null;
	"filter.list": any;
	filters: any[];
	transitionSettings: Record<string, unknown>;
	retryPolicy: Record<string, unknown>;
	availablePlugins: BasePlugin[];
	"plugin.list": BasePlugin[];
	extensions: BaseExtension[];
	"extension.list": BaseExtension[];
	"preload.state": any;
	playbackMode: PlaybackMode;
	forwardLeader: Player | null;
	forwardLeaderId: string | null;
	forwardFollowers: ReadonlySet<Player> | ReadonlySet<string>;
}
export type PlayerQuery = keyof PlayerQueryMap;
export type PlayerQueryHandler<K extends PlayerQuery> = (playerId: string) => PlayerQueryMap[K] | Promise<PlayerQueryMap[K]>;

export const SEARCH_RPC_TYPES = {
	search: "search",
	cacheGet: "search.cache.get",
	cacheSet: "search.cache.set",
	cacheClear: "search.cache.clear",
	cachePurge: "search.cache.purge",
	debug: "search.debug",
} as const;
