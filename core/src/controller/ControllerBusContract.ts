/**
 * PlayerBus is the communication boundary between the Player facade
 * and shared controllers.
 *
 * Player does not own controller instances or controller lifecycle.
 * Shared controllers are owned by PlayerManager and keep per-player
 * state internally, keyed by playerId.
 */
import type { PlaybackSession } from "../structures/PlaybackSession";
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

export const CONTROLLER_RPC = {
	play: "play",
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
	ttsIsTTS: "controller.tts.isTTS",
	ttsPlay: "controller.tts.play",
} as const;
