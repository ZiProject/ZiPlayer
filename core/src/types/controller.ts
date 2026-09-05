import type { Track, PlayerOptions } from ".";
import type { AudioResource, AudioPlayer, StreamType, AudioPlayerStatus } from "@discordjs/voice";
import type { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { PlayerBus } from "../structures/PlayerBus";
import type { VolumeController } from "../controller/VolumeController";
import type { TransitionController } from "../controller/TransitionController";
import type { AntiStuckController } from "../controller/AntiStuckController";

export interface ConnectionControllerOptions {
	guildId: string;
	bus: PlayerBus;
	options?: Pick<PlayerOptions, "selfDeaf" | "selfMute">;
	debug?: (message: string) => void;
	readyTimeoutMs?: number;
}
export interface LifecycleControllerOptions {
	bus: PlayerBus;
	options: Pick<PlayerOptions, "leaveOnEnd" | "leaveOnEmpty" | "leaveTimeout">;
	debug?: (...args: any[]) => void;
}
export interface ForwardControllerOptions {
	bus?: PlayerBus;
	debug?: (...args: any[]) => void;
}
export interface PlaybackControllerOptions {
	audioPlayer: AudioPlayer;
	bus?: PlayerBus;
	volumeController?: VolumeController;
	transitionController?: TransitionController;
	antiStuckController?: AntiStuckController;
	stuckTimeoutMs?: number;
}

export interface ActiveStream {
	sessionId: number;
	session: PlaybackSession;
	track: Track;
	stream: Readable;
	streamId: string | null;
	inputType?: StreamType;
}
export interface StreamControllerOptions {
	streamManager?: StreamManager;
	bus?: PlayerBus;
}
export type FilterControllerStreamType = "webm/opus" | "ogg/opus" | "arbitrary" | "mp3";
export interface FilterControllerResourcePort {
	refreshPlayerResource(position?: number): Promise<boolean>;
}
export interface StreamManagerOptions {
	maxConcurrentStreams?: number;
	streamTimeout?: number;
	maxListenersPerStream?: number;
	cleanupInterval?: number;
	enableMetrics?: boolean;
	autoDestroy?: boolean;
}
export interface ManagedStream {
	id: string;
	stream: Readable;
	track: Track;
	createdAt: number;
	lastAccessed: number;
	playStream?: Readable;
	metadata: { source: string; isPreload: boolean; isRemote: boolean; priority: number };
	listeners: {
		error: (err: Error) => void;
		close: () => void;
		end: () => void;
		drain?: () => void;
		pause?: () => void;
		resume?: () => void;
	};
	status: "active" | "paused" | "ended" | "error" | "destroyed";
	byteCount: number;
}
export interface PlaybackSessionSnapshot {
	id: number;
	track: Track | null;
	resource: AudioResource | null;
	status: PlaybackSessionStatus;
	position: number | null;
	startedAt: number | null;
}

export type PlaybackSessionStatus =
	| AudioPlayerStatus
	| "idle"
	| "loading"
	| "playing"
	| "paused"
	| "stopped"
	| "ended"
	| "destroyed"
	| "buffering";
export interface AntiStuckControllerOptions {
	enabled?: boolean;
	maxRetries?: number;
	retryDelayMs?: number;
	reusePreloadFirst?: boolean;
	reduceQualityOnRetry?: boolean;
	controlledSkipThreshold?: number;
	bus?: PlayerBus;
}
export interface AntiStuckRetryContext {
	session: PlaybackSession;
	track: Track;
	retry: number;
	reason?: string;
}
export interface AntiStuckRetryHandlers {
	retry: (context: AntiStuckRetryContext) => Promise<boolean>;
	skip: (context: AntiStuckRetryContext) => Promise<void> | void;
}
export interface LegacyAntiStuckRetryContext {
	track: Track;
	retry: number;
	reason?: unknown;
	signal: AbortSignal;
}
export interface LegacyAntiStuckRetryHandlers {
	retry: (context: LegacyAntiStuckRetryContext) => Promise<boolean>;
}
export interface SearchRequest {
	query: string;
	requestedBy: string;
}

export interface SearchDebugResult {
	isCached: boolean;
	cacheAge?: number;
	pluginCount: number;
	ttsFiltered: boolean;
}
