import { Readable } from "stream";
import { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { AudioFilter } from "./filter";
import type { SourcePluginLike } from "./plugin";
import type { AudioResource, StreamType } from "@discordjs/voice";

export enum PlaybackMode {
	NATIVE = "native",
	REMOTE = "remote",
	FORWARD = "forward",
}
/**
 * Represents a music track with metadata and streaming information.
 */
export interface Track {
	id: string;
	title: string;
	url: string;
	duration: number;
	thumbnail?: string;
	requestedBy: string;
	source: string;
	metadata?: Record<string, any>;
	isLive?: boolean;
	author?: string;
}

export interface SearchResult {
	tracks: Track[];
	playlist?: {
		name: string;
		url?: string;
		thumbnail?: string;
	} | null;
	query?: string;
	score?: SearchScore;
	source?: string;
}

export interface SearchScore {
	score: number;
	reason: string;
	matchedBy: "url" | "title" | "partial" | "none" | "playlist";
	exactMatch: boolean;
}

/**
 * Contains streaming information for audio playback.
 * `inputType` describes the actual bytes exposed by `stream`, which is
 * especially important for raw PCM produced by filter/seek operations.
 */
export interface StreamInfo {
	stream?: Readable;
	url?: string;
	type: "webm/opus" | "ogg/opus" | "arbitrary" | "url" | string;
	/** Actual @discordjs/voice input type for the returned stream. */
	inputType?: StreamType;
	metadata?: Record<string, any>;
	position?: number;
	recreate?: (position: number) => Promise<Readable>;
	remote?: boolean;
	handle?: {
		play(): Promise<void>;
		stop(): Promise<void>;
		pause(): Promise<void>;
		resume(): Promise<void>;
		seek(position: number): Promise<void>;
		setVolume(volume: number): Promise<void>;
		destroy(): Promise<void>;
	};
}

export interface TrackMiddlewareContext {
	player: Player;
	manager: PlayerManager;
}

export type TrackMiddleware = (track: Track, context: TrackMiddlewareContext) => void | Track | Promise<void | Track>;

export interface PlaybackMirrorOptions {
	leaderGuildId: string;
	followerGuildIds: string[];
	forwardMode?: boolean;
}

export function normalizeTrackMiddleware(input?: TrackMiddleware | TrackMiddleware[]): TrackMiddleware[] {
	if (!input) return [];
	return Array.isArray(input) ? input : [input];
}

export interface PlayerOptions {
	leaveOnEnd?: boolean;
	leaveOnEmpty?: boolean;
	leaveTimeout?: number;
	volume?: number;
	quality?: "high" | "low";
	selfDeaf?: boolean;
	selfMute?: boolean;
	group?: string;
	exttractorTimeout?: number;
	userdata?: Record<string, any>;
	/** Explicit FFmpeg executable path used by seek/filter processing. */
	ffmpegPath?: string | null;
	tts?: {
		createPlayer?: boolean;
		interrupt?: boolean;
		volume?: number;
		maxTimeTts?: number;
	};
	extensions?: any[] | string[];
	filters?: (string | AudioFilter)[];
	lowPerformance?: boolean;
	preload?: { enabled?: boolean; autoDisableInLowPerformance?: boolean };
	crossfade?: { enabled?: boolean; autoEnable?: boolean; autoDisableInLowPerformance?: boolean; durationMs?: number };
	smartTransition?: {
		enabled?: boolean;
		genreAware?: boolean;
		beatAlign?: boolean;
		baseDurationMs?: number;
		minDurationMs?: number;
		maxDurationMs?: number;
		genreDurations?: Record<string, number>;
		beatAlignMaxWaitMs?: number;
	};
	antiStuck?: {
		enabled?: boolean;
		maxRetries?: number;
		retryDelayMs?: number;
		reusePreloadFirst?: boolean;
		reduceQualityOnRetry?: boolean;
		controlledSkipThreshold?: number;
	};
	loudnessNormalization?: {
		enabled?: boolean;
		targetLUFS?: number;
		maxBoostDb?: number;
		maxCutDb?: number;
		limiterCeiling?: number;
	};
	trackMiddleware?: TrackMiddleware | TrackMiddleware[];
	maxStreamStore?: number;
}

export type PlayerDebugLevel = "off" | "error" | "warn" | "info" | "debug" | "verbose";
export type PlayerEventDebugLogger = (message: string, value?: unknown) => void;

export interface PlayerManagerOptions {
	plugins?: SourcePluginLike[];
	extensions?: any[];
	extractorTimeout?: number;
	autoCleanup?: boolean;
	cleanupInterval?: number;
	enableSearchCache?: boolean;
	enableStatsCollection?: boolean;
	trackMiddleware?: TrackMiddleware | TrackMiddleware[];
	debugLevel?: PlayerDebugLevel | "info";
}

export interface ProgressBarOptions {
	size?: number;
	barChar?: string;
	progressChar?: string;
	timeFormat?: "compact" | "full";
	showPercentage?: boolean;
	showTime?: boolean;
	hideProgressChar?: boolean;
}

export interface SaveOptions {
	filename?: string;
	quality?: "high" | "low";
	timeout?: number;
	metadata?: Record<string, any>;
	filter?: AudioFilter[];
	seek?: number;
}

export interface PlayerSession {
	guildId: string;
	queue: Track[];
	currentTrack: Track | null;
	volume: number;
	loopMode: LoopMode;
	autoPlay: boolean;
	position: number | null;
	extensions: string[];
	plugins: string[];
	userdata?: Record<string, any>;
}

export interface PreloadState {
	resource: AudioResource | null;
	track: Track | null;
	abortController: AbortController | null;
	timeoutId: NodeJS.Timeout | null;
	isValid: boolean;
	streamId?: string;
	isBeingUsed: boolean;
}

export interface ForwardHealthStatus {
	guildId: string;
	healthy: boolean;
	role: "leader" | "follower" | "none";
	issues: string[];
	details: {
		leaderId?: string;
		followerCount?: number;
		connectionState?: string;
		audioPlayerState?: string;
	};
}

export interface PlayerStats {
	totalPlayers: number;
	leader: number;
	follower: number;
	activePlayers: number;
	pausedPlayers: number;
	connectedPlayers: number;
	totalTracksInQueue: number;
	forwardHealthStatus: ForwardHealthStatus[];
}

export interface StreamSlot {
	resource: AudioResource | null;
	track: Track | null;
	streamId: string | null;
	processedStreamId: string | null;
	abortController: AbortController | null;
	isValid: boolean;
	isLoading: boolean;
	loadPromise: Promise<void> | null;
}

export type LoopMode = "off" | "track" | "queue";

export interface VoiceChannel {
	id: string;
	guildId: string;
	type: any;
	guild: any;
}

export interface ManagerEvents {
	debug: [message: string, ...args: any[]];
	willPlay: [player: Player, track: Track, upcomingTracks: Track[]];
	trackStart: [player: Player, track: Track];
	trackEnd: [player: Player, track: Track];
	queueEnd: [player: Player];
	playerError: [player: Player, error: Error, track?: Track];
	connectionError: [player: Player, error: Error];
	volumeChange: [player: Player, oldVolume: number, newVolume: number];
	queueAdd: [player: Player, track: Track];
	queueAddList: [player: Player, tracks: Track[]];
	queueRemove: [player: Player, track: Track, index: number];
	playerPause: [player: Player, track: Track];
	playerResume: [player: Player, track: Track];
	playerStop: [player: Player];
	playerDestroy: [player: Player];
	ttsStart: [player: Player, payload: { text?: string; track?: Track }];
	ttsEnd: [player: Player];
	filterApplied: [player: Player, filter: AudioFilter];
	filterRemoved: [player: Player, filter: AudioFilter];
	filtersCleared: [player: Player];
	lyricsCreate: [player: Player, track: Track, lyrics: any];
	lyricsChange: [player: Player, track: Track, lyrics: any];
	voiceCreate: [player: Player, evt: any];
	stats: [stats: PlayerStats];
	streamError: [player: Player, error: Error, track: Track | null];
	forwardModeStart: [player: Player, leader: Player];
	forwardModeEnd: [player: Player, leader: Player, reason: string | undefined];
}

export interface PlayerEvents {
	debug: [message: string, ...args: any[]];
	willPlay: [track: Track, upcomingTracks: Track[]];
	trackStart: [track: Track];
	trackEnd: [track: Track];
	queueEnd: [];
	playerError: [error: Error, track?: Track];
	connectionError: [error: Error];
	volumeChange: [oldVolume: number, newVolume: number];
	queueAdd: [track: Track];
	queueAddList: [tracks: Track[]];
	queueRemove: [track: Track, index: number];
	playerPause: [track: Track];
	playerResume: [track: Track];
	playerStop: [];
	playerDestroy: [];
	seek: [payload: { track: Track; position: number }];
	ttsStart: [payload: { text?: string; track?: Track }];
	ttsEnd: [];
	filterApplied: [filter: AudioFilter];
	filterRemoved: [filter: AudioFilter];
	filtersCleared: [];
	trackStuck: [track: Track | null];
	streamError: [error: Error, track: Track | null];
	stats: [stats: PlayerStats];
	forwardModeStart: [leader: Player];
	forwardModeEnd: [leader: Player, reason: string | undefined];
}
