/**
 * Internal controller-to-controller RPC boundary.
 *
 * Controllers must not import or retain another controller. They communicate
 * through PlayerBus using stable capability names. Player remains the public
 * facade and PlayerRuntimeController remains the composition/lifecycle root.
 */
import type { PlayerBus } from "../structures/PlayerBus";
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
	playbackStart: "playback.start",
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

export function requestTransitionPlan(bus: PlayerBus, request: TransitionPlanRequest): Promise<TransitionPlanResponse> {
	return bus.requestRpc<TransitionPlanRequest, TransitionPlanResponse>(CONTROLLER_RPC.transitionPlan, request);
}

export function requestTransitionBeatWait(bus: PlayerBus, request: TransitionBeatWaitRequest): Promise<number> {
	return bus.requestRpc<TransitionBeatWaitRequest, number>(CONTROLLER_RPC.transitionBeatWait, request);
}

export function requestVolumeTarget(bus: PlayerBus, request: VolumeTargetRequest): Promise<number> {
	return bus.requestRpc<VolumeTargetRequest, number>(CONTROLLER_RPC.volumeTarget, request);
}

export function requestVolumeSet(bus: PlayerBus, request: VolumeSetRequest): Promise<number> {
	return bus.requestRpc<VolumeSetRequest, number>(CONTROLLER_RPC.volumeSet, request);
}

export function requestAntiStuckReport(bus: PlayerBus, request: AntiStuckReportRequest): Promise<boolean> {
	return bus.requestRpc<AntiStuckReportRequest, boolean>(CONTROLLER_RPC.antiStuckReport, request);
}
