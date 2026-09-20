import type { AudioPlayer, AudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Bus } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { TrackResolver } from "../structures/TrackResolver";
import type { PreloadManager } from "../structures/PreloadManager";
import type { PlaybackSessionController } from "../controller/PlaybackSessionController";
import type { TrackLoader } from "../structures/TrackLoader";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { PlayerOptions, Track, TrackMiddleware, StreamInfo, TrackLoadResult } from "./index";
export interface PlaybackStartControllerOptions {
	bus: Bus;
	sessionController: PlaybackSessionController;
	transitionEnabled: () => boolean;
	stopPlayback: (signal: AbortSignal, cancelPreload?: boolean) => void;
	prepareTrack: (session: PlaybackSession, context: import("./bus").PlayerMessageContext) => Promise<void>;
	adapters?: PlaybackOrchestratorAdapters;
}
export interface PlaybackPreparationControllerOptions {
	bus: Bus;
	isCurrentSession: (session: PlaybackSession, context: import("./bus").PlayerMessageContext) => boolean;
	queueSnapshot: () => Track[];
	setQueueRelated: (tracks: Track[]) => void;
}
export interface PlaybackSkipControllerOptions {
	bus: Bus;
	nextThroughBus: (ignoreLoop: boolean, context: import("./bus").PlayerMessageContext) => Promise<Track | null>;
	stopPlayback: (signal: AbortSignal) => void;
	publishState: () => void;
	setWaitingForQueue: (waiting: boolean) => void;
}
export interface PlaybackTrackEndControllerOptions {
	bus: Bus;
	nextThroughBus: (ignoreLoop: boolean, context: import("./bus").PlayerMessageContext) => Promise<Track | null>;
	stopPlayback: (signal: AbortSignal) => void;
	publishState: () => void;
	queueSnapshot: () => Track[];
	lifecycleSignal: AbortSignal;
}
export interface PlaybackPlayControllerOptions {
	bus: Bus;
	isWaitingForQueue: () => boolean;
	debug: (message?: any, ...optionalParams: any[]) => void;
	lifecycleSignal: AbortSignal;
	adapters?: PlaybackOrchestratorAdapters;
}
export interface ResourceRefreshControllerOptions {
	bus: Bus;
}
export interface SaveControllerOptions {
	middleware?: TrackMiddleware[];
	middlewareContext: import("./core").TrackMiddlewareContext;
	resolveStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	resolveVideoStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	ffmpegPath?: string | null;
	debug?: (...args: any[]) => void;
	bus?: Bus;
}
export interface SearchControllerOptions {
	extensionManager: ExtensionManager;
	pluginManager: PluginManager;
	debug: (...args: any[]) => void;
	bus?: Bus;
}
export interface QueueControllerOptions {
	bus?: Bus;
}
/** Collaborators of the shared `PreloadController` (both are process-wide singletons too). */
export interface PreloadControllerOptions {
	loader: TrackLoader;
	manager: PreloadManager;
}
export interface TransitionControllerOptions {
	enabled?: boolean;
	durationMs?: number;
	smartEnabled?: boolean;
	genreAware?: boolean;
	beatAlign?: boolean;
	baseDurationMs?: number;
	minDurationMs?: number;
	maxDurationMs?: number;
	beatAlignMaxWaitMs?: number;
	genreDurations?: Record<string, number>;
	bus?: Bus;
}
export interface TransitionPlan {
	enabled: boolean;
	durationMs: number;
	waitForBeat: boolean;
	beatAlignMaxWaitMs: number;
}
export interface TTSControllerOptions {
	pluginManager: PluginManager;
	extensionManager?: ExtensionManager;
	connection?: VoiceConnection | null;
	audioPlayer?: AudioPlayer;
	debug?: (...args: any[]) => void;
	maxTimeTts?: number;
	volume?: number;
	interrupt?: boolean;
	bus?: Bus;
}
export interface VolumeControllerOptions {
	initialVolume?: number;
	loudness?: PlayerOptions["loudnessNormalization"];
}
export interface FilterControllerOptions {
	ffmpegPath?: string | null;
	seekStartupTimeoutMs?: number;
	initialFilters?: (string | import("./filter").AudioFilter)[];
	onFilterApplied?: (filter: import("./filter").AudioFilter) => void;
	onFilterRemoved?: (filter: import("./filter").AudioFilter) => void;
	onFiltersCleared?: () => void;
	onProcessingError?: (error: Error) => void;
}
export interface ExtensionControllerOptions {
	extensionManager: ExtensionManager;
	bus: Bus;
}
export interface PluginControllerOptions {
	pluginManager: PluginManager;
	bus: Bus;
}
/**
 * Optional fallback adapters used when the corresponding controller RPC is not
 * registered on the bus (e.g. PreloadController / TTSController not wired up,
 * such as in standalone unit tests that construct a PlaybackOrchestrator
 * against a minimal bus). When the RPC exists on the bus it always takes
 * priority; adapters are only consulted via `bus.hasRpc(...)` graceful checks.
 */
export interface PlaybackOrchestratorAdapters {
	hasPreload?: (track: Track) => boolean;
	cancelPreload?: () => void;
	isTTS?: (track: Track) => boolean;
	playTTS?: (track: Track) => void | Promise<void>;
}
/** Collaborators of the shared `PlaybackOrchestrator` singleton. */
export interface PlaybackOrchestratorOptions {
	sessionController: PlaybackSessionController;
}
/** Per-player configuration handed to the shared `PlaybackOrchestrator` via `attach(playerId, options)`. */
export interface PlaybackOrchestratorAttachOptions {
	debug?: (...args: any[]) => void;
	adapters?: PlaybackOrchestratorAdapters;
}
export type { SharedControllerSet } from "./controllerSet";
export interface PromotedPreload {
	track: Track;
	stream: NodeJS.ReadableStream;
	streamInfo?: StreamInfo;
	streamId: string | null;
}
export type BusLatencyKind = "action" | "rpc" | "query" | "event";
export interface BusLatencyRecord {
	kind: BusLatencyKind;
	type: string;
	durationUs: number;
	requestId?: string;
	sessionId?: string;
	handler?: string;
	source?: string;
	timestamp: number;
}
export interface PlayerEventTraceInfo {
	sequence: number;
	fingerprint: string;
}
