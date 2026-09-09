/**
 * Internal controller-to-controller RPC boundary.
 *
 * Controllers must not import or retain another controller. They communicate
 * through PlayerBus using stable capability names. Player remains the public
 * facade and PlayerRuntimeController remains the composition/lifecycle root.
 */
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { Track, AntiStuckRetryHandlers, TrackLoadResult } from "../types";

export interface ControllerCommandContext {
	requestId: string;
	sessionId?: string;
	signal?: AbortSignal;
	timestamp?: number;
}

export type ControllerCommandHandler<TRequest = unknown, TResponse = unknown> = (
	request: TRequest,
	context: ControllerCommandContext,
) => TResponse | Promise<TResponse>;

export const CONTROLLER_RPC = {
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
} as const;

export interface TransitionPlanRequest {
	from: Track | null;
	to: Track | null;
}

export interface TransitionPlanResponse {
	enabled: boolean;
	durationMs: number;
	waitForBeat: boolean;
	beatAlignMaxWaitMs: number;
}

export interface TransitionBeatWaitRequest {
	track: Track | null;
	positionMs: number;
}

export interface VolumeTargetRequest {
	track?: Track | null;
}

export interface VolumeSetRequest {
	value: number;
}

export interface AntiStuckReportRequest {
	session: PlaybackSession;
	reason: string;
	handlers: AntiStuckRetryHandlers;
}

export interface TrackLoadRequest {
	track: Track;
	session: PlaybackSession;
}

export interface TrackResetRecoveryRequest {
	track?: Track;
}

export interface TrackGetRecoveryCountRequest {
	track: Track;
}

export function requestTransitionPlan(
	bus: PlayerBus,
	request: TransitionPlanRequest,
): Promise<TransitionPlanResponse> {
	return bus.requestRpc<TransitionPlanRequest, TransitionPlanResponse>(CONTROLLER_RPC.transitionPlan, request);
}

export function requestTransitionBeatWait(
	bus: PlayerBus,
	request: TransitionBeatWaitRequest,
): Promise<number> {
	return bus.requestRpc<TransitionBeatWaitRequest, number>(CONTROLLER_RPC.transitionBeatWait, request);
}

export function requestVolumeTarget(bus: PlayerBus, request: VolumeTargetRequest): Promise<number> {
	return bus.requestRpc<VolumeTargetRequest, number>(CONTROLLER_RPC.volumeTarget, request);
}

export function requestVolumeSet(bus: PlayerBus, request: VolumeSetRequest): Promise<number> {
	return bus.requestRpc<VolumeSetRequest, number>(CONTROLLER_RPC.volumeSet, request);
}

export function requestAntiStuckReport(
	bus: PlayerBus,
	request: AntiStuckReportRequest,
): Promise<boolean> {
	return bus.requestRpc<AntiStuckReportRequest, boolean>(CONTROLLER_RPC.antiStuckReport, request);
}
