/**
 * BusContract is the single source of truth for every string literal that
 * travels across the global `Bus`: request/response messages, RPC names,
 * broadcast events and action types.
 *
 * It replaces the old `controller/ControllerBusContract.ts`, which only
 * covered the internal controller<->controller RPC namespace. Every kind of
 * message the bus carries now lives here, grouped by the same four
 * primitives `Bus` exposes:
 *
 *   - {@link BUS_REQUEST}      `emitInput` / `request()`     e.g. "[Player]->[Connection]:connect"
 *   - {@link CONTROLLER_RPC}   `registerRpc` / `requestRpc()` (internal, controller-to-controller)
 *   - {@link PLAYER_RPC}       `registerRpc` / `requestRpc()` (public surface, keys of `PlayerRpcMap`)
 *   - {@link BUS_EVENT}        `publish` / `subscribe()`      e.g. "TRACK_LOADING", "willPlay"
 *   - {@link PLAYER_ACTION}    `action()`                     e.g. "PLAY", "SEEK"
 *   - {@link PLAYER_QUERY}     `registerQuery` / `query()`    e.g. "currentTrack", "volume"
 *
 * `Player` does not own controller instances or controller lifecycle.
 * Shared controllers are owned by `PlayerManager` and keep per-player state
 * internally, keyed by playerId. This contract is what keeps every one of
 * those controllers, plus `Player` itself, referring to the exact same
 * strings instead of re-typing literals that can silently drift apart.
 *
 * Each constant group below is derived `as const` from its corresponding
 * type in `types/bus.ts`, so adding/renaming a message there and forgetting
 * to update the matching constant here is a compile error, not a silent
 * runtime mismatch.
 */
import type {
	Track,
	AntiStuckRetryHandlers,
	TrackLoadResult,
	ControllerCommandContext,
	ControllerCommandHandler,
	TransitionPlanRequest,
	TransitionPlanResponse,
	TransitionBeatWaitRequest,
	VolumeTargetRequest,
	VolumeSetRequest,
	AntiStuckReportRequest,
	TrackLoadRequest,
	TrackResetRecoveryRequest,
	TrackGetRecoveryCountRequest,
	TtsIsTTSRequest,
	TtsPlayRequest,
	PlayerRequestInputType,
	PlayerEventType,
	PlayerActionType,
	PlayerQuery,
	PlayerRpcMap,
} from "../types";

export type {
	ControllerCommandContext,
	ControllerCommandHandler,
	TransitionPlanRequest,
	TransitionPlanResponse,
	TransitionBeatWaitRequest,
	VolumeTargetRequest,
	VolumeSetRequest,
	AntiStuckReportRequest,
	TrackLoadRequest,
	TrackResetRecoveryRequest,
	TrackGetRecoveryCountRequest,
	TtsIsTTSRequest,
	TtsPlayRequest,
} from "../types";

// ---------------------------------------------------------------------
// [Player]->[Connection]:connect / [Resource]->[Player]:refreshed / ...
// The `request()` message pairs: every `PlayerInput["type"]` the bus
// accepts. Response/progress types live in `PlayerRequestReplyMap`.
// ---------------------------------------------------------------------
const BUS_REQUEST_VALUES = {
	connectionConnect: "[Player]->[Connection]:connect",
	connectionDisconnect: "[Player]->[Connection]:disconnect",
	connectionReconnect: "[Player]->[Connection]:reconnect",
	preloadRequest: "[Player]->[Preload]:request",
	recoveryRecover: "[Player]->[Recovery]:recover",
	resourceRefresh: "[Player]->[Resource]:refresh",
} as const;
export const BUS_REQUEST = BUS_REQUEST_VALUES;
export type BusRequestKey = keyof typeof BUS_REQUEST_VALUES;

const BUS_OUTPUT_VALUES = {
	connectionConnecting: "[Connection]->[Player]:connecting",
	connectionConnected: "[Connection]->[Player]:connected",
	connectionDisconnected: "[Connection]->[Player]:disconnected",
	connectionError: "[Connection]->[Player]:error",
	preloadLoading: "[Preload]->[Player]:loading",
	preloadReady: "[Preload]->[Player]:ready",
	preloadFailed: "[Preload]->[Player]:failed",
	recoveryRetrying: "[Recovery]->[Player]:retrying",
	recoveryRecovered: "[Recovery]->[Player]:recovered",
	recoveryFailed: "[Recovery]->[Player]:failed",
	resourceRefreshed: "[Resource]->[Player]:refreshed",
	resourceError: "[Resource]->[Player]:error",
} as const;
export const BUS_OUTPUT = BUS_OUTPUT_VALUES;
export type BusOutputKey = keyof typeof BUS_OUTPUT_VALUES;

// ---------------------------------------------------------------------
// Internal controller<->controller RPC namespace. Registered/consumed only
// by shared controllers (never by `Player` directly).
// ---------------------------------------------------------------------
export const CONTROLLER_RPC = {
	play: "play",
	runtimePing: "runtime.ping",
	playbackDestroyCurrentStream: "playback.destroyCurrentStream",
	playbackRecover: "playback.recover",
	playbackLoadFresh: "playback.loadFresh",
	playbackRemote: "playback.remote",
	playbackLoadFreshCurrent: "playback.loadFreshCurrent",
	playbackPromotePreload: "playback.promotePreload",
	playbackTransitionLock: "playback.transitionLock",
	playbackPrepareAutoplay: "playback.prepareAutoplay",
	playbackCreateRelatedTracks: "playback.createRelatedTracks",
	playbackStart: "playback.start",
	playbackReportFilterError: "playback.reportFilterError",
	playbackSessionRetirePending: "playback.session.retirePending",
	preloadHas: "preload.has",
	streamReplace: "controller.stream.replace",
	resourceCreate: "resource.create",
	transitionPlan: "controller.transition.plan",
	transitionBeatWait: "controller.transition.beatWait",
	volumeTarget: "controller.volume.target",
	volumeSet: "controller.volume.set",
	antiStuckReport: "controller.antistuck.report",
	playbackPlay: "controller.playback.play",
	playbackPause: "controller.playback.pause",
	playbackResume: "controller.playback.resume",
	playbackStop: "controller.playback.stop",
	playbackBeginResourceRefresh: "controller.playback.beginResourceRefresh",
	playbackEndResourceRefresh: "controller.playback.endResourceRefresh",
	trackLoad: "controller.track.load",
	trackLoadWithRecovery: "controller.track.loadWithRecovery",
	trackResetRecovery: "controller.track.resetRecovery",
	trackGetRecoveryCount: "controller.track.getRecoveryCount",
	playerEmitTtsStart: "player.emitTtsStart",
	playerEmitTtsEnd: "player.emitTtsEnd",
	ttsIsTTS: "controller.tts.isTTS",
	ttsPlay: "controller.tts.play",
} as const;
export type ControllerRpcKey = keyof typeof CONTROLLER_RPC;

// ---------------------------------------------------------------------
// Public RPC namespace: every key of `PlayerRpcMap`, i.e. what `Player`
// itself (and plugins/extensions) may call through `bus.requestRpc`.
// ---------------------------------------------------------------------
export const PLAYER_RPC = {
	play: "play",
	volumeSet: "volume.set",
	search: "search",
	searchCacheGet: "search.cache.get",
	searchCacheSet: "search.cache.set",
	searchCacheClear: "search.cache.clear",
	searchCachePurge: "search.cache.purge",
	searchDebug: "search.debug",
	queueAdd: "queue.add",
	queuePrevious: "queue.previous",
	queueShuffle: "queue.shuffle",
	queueClear: "queue.clear",
	queueAddMultiple: "queue.addMultiple",
	queueInsert: "queue.insert",
	queueRemove: "queue.remove",
	queueLoop: "queue.loop",
	queueAutoPlay: "queue.autoPlay",
	queueWillNext: "queue.willNext",
	queueSetCurrent: "queue.setCurrent",
	queueSerialize: "queue.serialize",
	queueRestore: "queue.restore",
	queueRestoreNext: "queue.restoreNext",
	playbackDestroyCurrentStream: "playback.destroyCurrentStream",
	playbackRecover: "playback.recover",
	playbackLoadFresh: "playback.loadFresh",
	playbackRemote: "playback.remote",
	playbackRefreshResource: "playback.refreshResource",
	playbackLoadFreshCurrent: "playback.loadFreshCurrent",
	playbackPromotePreload: "playback.promotePreload",
	playbackTransitionLock: "playback.transitionLock",
	playbackPrepareAutoplay: "playback.prepareAutoplay",
	playbackStart: "playback.start",
	forwardHealth: "forward.health",
	forwardSubscribe: "forward.subscribe",
	forwardUnsubscribe: "forward.unsubscribe",
	forwardAddFollower: "forward.addFollower",
	forwardRemoveFollower: "forward.removeFollower",
	connectionSetAudioPlayer: "connection.setAudioPlayer",
	transitionFade: "transition.fade",
	transitionFadeIn: "transition.fadeIn",
	transitionFadeOutCurrent: "transition.fadeOutCurrent",
	transitionSkipAndStop: "transition.skipAndStop",
	transitionDuration: "transition.duration",
	transitionBeatWait: "transition.beatWait",
	transitionTargetVolume: "transition.targetVolume",
	resourceCreate: "resource.create",
	trackMiddleware: "track.middleware",
	streamResolve: "stream.resolve",
	streamState: "stream.state",
	streamCurrent: "stream.current",
	preloadHas: "preload.has",
	preloadState: "preload.state",
	preloadNext: "preload.next",
	preloadCancel: "preload.cancel",
	preloadCancelSafe: "preload.cancelSafe",
	preloadClear: "preload.clear",
	preloadPromote: "preload.promote",
	pluginAdd: "plugin.add",
	pluginRemove: "plugin.remove",
	pluginGet: "plugin.get",
	pluginList: "plugin.list",
	pluginClear: "plugin.clear",
	pluginStats: "plugin.stats",
	pluginRelatedTracks: "plugin.relatedTracks",
	extensionAdd: "extension.add",
	extensionRemove: "extension.remove",
	extensionGet: "extension.get",
	extensionList: "extension.list",
	extensionEnable: "extension.enable",
	extensionDisable: "extension.disable",
	filterList: "filter.list",
	filterSet: "filter.set",
	save: "save",
	saveVideo: "save.video",
	lifecycleScheduleLeave: "lifecycle.scheduleLeave",
	lifecycleClearLeaveTimeout: "lifecycle.clearLeaveTimeout",
} as const satisfies Record<string, keyof PlayerRpcMap>;
export type PlayerRpcKey = keyof typeof PLAYER_RPC;

// ---------------------------------------------------------------------
// Broadcast events: `TRACK_LOADING`, `STUCK_DETECTED`, `willPlay`,
// `preloadStateChanged`, ... every `PlayerEventType` the bus can `publish`.
// ---------------------------------------------------------------------
export const BUS_EVENT = {
	initialized: "initialized",
	ready: "ready",
	destroyed: "destroyed",
	trackLoading: "TRACK_LOADING",
	trackLoaded: "TRACK_LOADED",
	trackStarted: "TRACK_STARTED",
	trackError: "TRACK_ERROR",
	trackEnd: "TRACK_END",
	streamAborted: "STREAM_ABORTED",
	playbackStateChanged: "playbackStateChanged",
	playbackSessionCreated: "playbackSessionCreated",
	trackRequested: "trackRequested",
	stateChanged: "stateChanged",
	stuckDetected: "STUCK_DETECTED",
	recoveryStarted: "RECOVERY_STARTED",
	recoveryFailed: "RECOVERY_FAILED",
	preloadStateChanged: "preloadStateChanged",
	preloadPromoted: "preloadPromoted",
	preloadCancelled: "preloadCancelled",
	queueChanged: "queueChanged",
	volumeRequested: "volumeRequested",
	willPlay: "willPlay",
	queueEnd: "queueEnd",
	playerPause: "playerPause",
	playerResume: "playerResume",
	playerStop: "playerStop",
	seek: "seek",
	filterApplied: "filterApplied",
	filterRemoved: "filterRemoved",
	filtersCleared: "filtersCleared",
	streamError: "streamError",
	forwardModeStart: "forwardModeStart",
	forwardModeEnd: "forwardModeEnd",
} as const satisfies Record<string, PlayerEventType>;
export type BusEventKey = keyof typeof BUS_EVENT;

// ---------------------------------------------------------------------
// Actions: `bus.action()` commands, e.g. PLAY / PAUSE / SEEK / SKIP.
// ---------------------------------------------------------------------
export const PLAYER_ACTION = {
	play: "PLAY",
	pause: "PAUSE",
	resume: "RESUME",
	seek: "SEEK",
	stop: "STOP",
	skip: "SKIP",
	setVolume: "SET_VOLUME",
	queueNext: "QUEUE_NEXT",
	queueSetCurrent: "QUEUE_SET_CURRENT",
	filterSetSourceType: "FILTER_SET_SOURCE_TYPE",
	filterApplyAndSeek: "FILTER_APPLY_AND_SEEK",
} as const satisfies Record<string, PlayerActionType>;
export type PlayerActionKey = keyof typeof PLAYER_ACTION;

// ---------------------------------------------------------------------
// Queries: `bus.query()` / `bus.querySync()` read-only lookups, e.g.
// `currentTrack`, `volume`, `isPlaying`. Query names already match their
// `PlayerQueryMap` key one-to-one, so the contract is the identity map —
// kept here purely so callers can reference `PLAYER_QUERY.currentTrack`
// instead of the bare string literal, same as every other group above.
// ---------------------------------------------------------------------
export const PLAYER_QUERY = {
	audioPlayer: "audioPlayer",
	connection: "connection",
	connectionState: "connection.state",
	ttsHasPlayer: "tts.hasPlayer",
	streamStats: "stream.stats",
	streamState: "stream.state",
	streamCurrent: "stream.current",
	ttsInterrupt: "ttsInterrupt",
	currentTrack: "currentTrack",
	queueCurrent: "queueCurrent",
	playerState: "playerState",
	queue: "queue",
	queueState: "queueState",
	previousTracks: "previousTracks",
	previousTrack: "previousTrack",
	willNext: "willNext",
	queueLoop: "queueLoop",
	queueAutoPlay: "queueAutoPlay",
	relatedTracks: "relatedTracks",
	queueSerialized: "queueSerialized",
	playbackSession: "playbackSession",
	playbackSessionInternal: "playbackSessionInternal",
	currentResource: "currentResource",
	position: "position",
	queueNextTrack: "queueNextTrack",
	volume: "volume",
	isPlaying: "isPlaying",
	isPaused: "isPaused",
	isLive: "isLive",
	isIdle: "isIdle",
	isBuffering: "isBuffering",
	filterString: "filterString",
	filteredStream: "filteredStream",
	filterList: "filter.list",
	filters: "filters",
	transitionSettings: "transitionSettings",
	retryPolicy: "retryPolicy",
	availablePlugins: "availablePlugins",
	pluginList: "plugin.list",
	extensions: "extensions",
	extensionList: "extension.list",
	preloadState: "preload.state",
	playbackMode: "playbackMode",
	forwardLeader: "forwardLeader",
	forwardLeaderId: "forwardLeaderId",
	forwardFollowers: "forwardFollowers",
} as const satisfies Record<string, PlayerQuery>;
export type PlayerQueryKey = keyof typeof PLAYER_QUERY;

/**
 * @deprecated Use `BUS_EVENT`, `BUS_REQUEST`, `PLAYER_RPC`, `PLAYER_ACTION`
 * and `PLAYER_QUERY` above. `CONTROLLER_RPC` itself is not deprecated (it
 * has no public-facing equivalent) — only importing this whole contract
 * under its old, controller-only name is. Kept as a type-level alias so a
 * stray old import still resolves during the migration window.
 */
export type BusContract = {
	request: typeof BUS_REQUEST;
	controllerRpc: typeof CONTROLLER_RPC;
	rpc: typeof PLAYER_RPC;
	event: typeof BUS_EVENT;
	action: typeof PLAYER_ACTION;
	query: typeof PLAYER_QUERY;
};
