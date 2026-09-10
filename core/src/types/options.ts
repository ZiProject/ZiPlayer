import type { AudioPlayer, AudioResource } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { PlayerBus } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { TrackResolver } from "../structures/TrackResolver";
import type { TrackLoader } from "../structures/TrackLoader";
import type { PreloadManager } from "../structures/PreloadManager";
import type { ConnectionController } from "../controller/ConnectionController";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { PlayerEventDebug } from "../controller/PlayerEventDebug";
import type { PlayerConnectionBridge } from "../controller/PlayerConnectionBridge";
import type { PlayerEventBridge } from "../controller/PlayerEventBridge";
import type { PlaybackController } from "../controller/PlaybackController";
import type { StreamController } from "../controller/StreamController";
import type { FilterController } from "../controller/FilterController";
import type { QueueController } from "../controller/QueueController";
import type { AntiStuckController } from "../controller/AntiStuckController";
import type { TransitionController } from "../controller/TransitionController";
import type { VolumeController } from "../controller/VolumeController";
import type { PreloadController } from "../controller/PreloadController";
import type { ResourceRefreshController } from "../controller/ResourceRefreshController";
import type { PlaybackOrchestrator } from "../structures/PlaybackOrchestrator";
import type { TTSController } from "../controller/TTSController";
import type { SaveController } from "../controller/SaveController";
import type { SearchController } from "../controller/SearchController";
import type { PluginController } from "../controller/PluginController";
import type { ExtensionController } from "../controller/ExtensionController";
import type { LifecycleController } from "../controller/LifecycleController";
import type { ForwardController } from "../controller/ForwardController";
import type { PlayerOptions, Track, TrackMiddleware, StreamInfo, TrackLoadResult } from "./index";
export interface PlaybackStartControllerOptions {
	bus: PlayerBus;
	getSession: () => PlaybackSession | null;
	setSession: (session: PlaybackSession | null) => void;
	transitionEnabled: () => boolean;
	stopPlayback: (signal: AbortSignal, cancelPreload?: boolean) => void;
	prepareTrack: (session: PlaybackSession, context: import("./bus").PlayerMessageContext) => Promise<void>;
}
export interface PlaybackPreparationControllerOptions {
	bus: PlayerBus;
	isCurrentSession: (session: PlaybackSession, context: import("./bus").PlayerMessageContext) => boolean;
	queueSnapshot: () => Track[];
	setQueueRelated: (tracks: Track[]) => void;
}
export interface ResourceRefreshControllerOptions {
	bus: PlayerBus;
	getSession: () => PlaybackSession | null;
}
export interface SaveControllerOptions {
	middleware?: TrackMiddleware[];
	middlewareContext: import("./core").TrackMiddlewareContext;
	resolveStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	resolveVideoStream: (track: Track) => Promise<StreamInfo | null | undefined>;
	ffmpegPath?: string | null;
	debug?: (...args: any[]) => void;
	bus?: PlayerBus;
}
export interface SearchControllerOptions {
	extensionManager: ExtensionManager;
	pluginManager: PluginManager;
	debug: (...args: any[]) => void;
	bus?: PlayerBus;
}
export interface QueueControllerOptions {
	bus?: PlayerBus;
}
export interface PreloadControllerOptions {
	loader: TrackLoader;
	manager: PreloadManager;
	bus?: PlayerBus;
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
	bus?: PlayerBus;
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
	bus?: PlayerBus;
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
	bus: PlayerBus;
}
export interface PluginControllerOptions {
	pluginManager: PluginManager;
	bus: PlayerBus;
}
export interface PlayerConnectionBridgeOptions {
	player: Player;
	bus: PlayerBus;
	debug?: (...args: any[]) => void;
	guildId: string;
}
export interface PlaybackOrchestratorOptions {
	debug?: (...args: any[]) => void;
}
export interface PlayerRuntimeGraph {
	connectionController: ConnectionController;
	lifecycleController: LifecycleController;
	forwardController: ForwardController;
	audioPlayer: AudioPlayer;
	streamManager: StreamManager;
	preloadManager: PreloadManager;
	trackResolver: TrackResolver;
	pluginManager: PluginManager;
	extensionManager: ExtensionManager;
	pluginController: PluginController;
	extensionController: ExtensionController;
	queueController: QueueController;
	trackLoader: TrackLoader;
	playbackController: PlaybackController;
	streamController: StreamController;
	saveController: SaveController;
	filterController: FilterController;
	antiStuckController: AntiStuckController;
	transitionController: TransitionController;
	volumeController: VolumeController;
	preloadController: PreloadController;
	resourceRefreshController: ResourceRefreshController;
	playerConnectionBridge: PlayerConnectionBridge;
	orchestrator: PlaybackOrchestrator;
	ttsController: TTSController;
	debugTracer: PlayerEventDebug;
	searchController: SearchController;
	eventBridge: PlayerEventBridge;
}
export interface PromotedPreload {
	track: Track;
	stream: NodeJS.ReadableStream;
	streamInfo?: StreamInfo;
	streamId: string | null;
}
export type PlayerBusLatencyKind = "action" | "rpc" | "query" | "event";
export interface PlayerBusLatencyRecord {
	kind: PlayerBusLatencyKind;
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
