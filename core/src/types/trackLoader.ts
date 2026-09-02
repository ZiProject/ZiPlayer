import type { StreamInfo, Track, TrackMiddleware, TrackMiddlewareContext } from ".";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PreloadManager } from "../structures/PreloadManager";

export interface TrackLoaderContext extends TrackMiddlewareContext {}
export type TrackStreamResolver = (
	track: Track,
	session: PlaybackSession,
) => Promise<StreamInfo | null | undefined> | StreamInfo | null | undefined;
export interface TrackLoadResult {
	track: Track;
	stream: StreamInfo;
	sessionId: number;
	retry: number;
	usedFallback: boolean;
}
export interface TrackAttemptQualityController {
	get(): "high" | "low" | undefined;
	set(quality: "high" | "low"): void;
}
export interface TrackLoadAttemptContext {
	track: Track;
	session: PlaybackSession;
	retry: number;
	qualityReduced: boolean;
	usedPreload: boolean;
	reason?: unknown;
}
export interface TrackRecoveryPolicy {
	enabled?: boolean;
	maxRetries?: number;
	retryDelayMs?: number;
	reusePreloadFirst?: boolean;
	reduceQualityOnRetry?: boolean;
	controlledSkipThreshold?: number;
}
export interface TrackLoaderOptions {
	middleware?: TrackMiddleware[];
	context: TrackLoaderContext;
	resolvers?: TrackStreamResolver[];
	preloadManager?: PreloadManager;
	recovery?: TrackRecoveryPolicy;
	qualityController?: TrackAttemptQualityController;
	debug?: (message?: any, ...optionalParams: any[]) => void;
}
