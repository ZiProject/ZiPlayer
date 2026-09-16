import type { AudioPlayer } from "@discordjs/voice";
import type { PlayerOptions, Track } from "../types";
import type { LoopMode } from "../types";
import type { Player } from "./Player";
import type { PlayerManager } from "./PlayerManager";
import type { StreamManager } from "./StreamManager";
import type { PreloadManager } from "./PreloadManager";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { PlaybackSession } from "./PlaybackSession";
import type { PlayerAction } from "./PlayerAction";
import type { AudioFilter, StreamInfo } from "../types";
import type { VoiceConnection } from "@discordjs/voice";
import type { AudioResource, PlayerSubscription } from "@discordjs/voice";
import type { Readable } from "stream";
import type { ChildProcess } from "child_process";
import type { ActiveStream } from "../types";
import { DEFAULT_PLAYER_ID, isPlayerScopedId, requirePlayerId, type PlayerId } from "./playerScope";
import type { PlayerSessionId, PlayerRequestId } from "../types/bus";
import { PlaybackMode } from "../types";

export interface QueueStateSnapshot {
	tracks: Track[];
	history: Track[];
	currentTrack: Track | null;
	willNext: Track | null;
	related: Track[];
	loopMode: LoopMode;
	autoPlayEnabled: boolean;
}

export class QueueState implements QueueStateSnapshot {
	public tracks: Track[] = [];
	public history: Track[] = [];
	public currentTrack: Track | null = null;
	public willNext: Track | null = null;
	public related: Track[] = [];
	public loopMode: LoopMode = "off";
	public autoPlayEnabled = false;
}

export class VolumeState {
	public volume: number;
	public muted = false;
	public unmuteVolume = 100;
	public constructor(initialVolume = 100) {
		this.volume = initialVolume;
	}
}

export class FilterState {
	public activeFilters: AudioFilter[] = [];
	public streamType: "webm/opus" | "ogg/opus" | "arbitrary" | "mp3" = "arbitrary";
	public ffmpegOutput: Readable | null = null;
	public currentInputStream: Readable | string | null = null;
	public ffmpegProcess: ChildProcess | null = null;
	public ffmpegAbortController: AbortController | null = null;
	public ffmpegGeneration = 0;
	public seekStartupTimer: ReturnType<typeof setTimeout> | null = null;
	public lastFilteredStream: StreamInfo | null = null;
}

export class ConnectionState {
	public connection: VoiceConnection | null = null;
	public channel: unknown = null;
	public sessionId: PlayerSessionId | null = null;
	public requestId: PlayerRequestId | null = null;
	public audioPlayer: AudioPlayer | null = null;
	public subscription: PlayerSubscription | null = null;
	public operation: Promise<void> = Promise.resolve();
	public selfDeaf = true;
	public selfMute = false;
	public group?: string;
}

export class PlaybackNodeState {
	public audioPlayer: AudioPlayer | null = null;
	public activeResource: AudioResource | null = null;
	public activeSession: PlaybackSession | null = null;
	public transitionTimer: ReturnType<typeof setTimeout> | null = null;
	public fadeTimer: ReturnType<typeof setInterval> | null = null;
	public stuckTimer: ReturnType<typeof setTimeout> | null = null;
	public resourceRefreshInProgress = false;
	public fadeGain: number | null = null;
	public onStateChange?: (oldState: unknown, newState: unknown) => void;
	public onError?: (error: Error) => void;
}

export class StreamNodeState {
	public active: ActiveStream | null = null;
	public streamManager?: StreamManager;
}

export class PreloadNodeState {
	public manager?: PreloadManager;
}

export class SessionNodeState {
	public session: PlaybackSession | null = null;
	public pendingRetire: PlaybackSession | null = null;
}

export class LifecycleNodeState {
	public leaveTimer: NodeJS.Timeout | null = null;
	public isPlaying = false;
	public leaveOnEnd = true;
	public leaveOnEmpty = true;
	public leaveTimeout = 100000;
}

export class ForwardNodeState {
	public leaderId?: string;
	public readonly followers = new Set<string>();
	public mode: PlaybackMode = PlaybackMode.NATIVE;
}

export class AntiStuckNodeState {
	public readonly failures = new Map<string, number>();
	public timer: NodeJS.Timeout | null = null;
	public generation = 0;
}

export class ResourceRefreshNodeState {
	public refreshSequence = 0;
	public refreshAbortController: AbortController | null = null;
}

export interface PlayerContext {
	readonly playerId: PlayerId;
	options: PlayerOptions;
	manager?: PlayerManager;
	player?: Player | null;
	destroyed: boolean;
	rejectNewActions: boolean;
	audioPlayer: AudioPlayer | null;
	streamManager?: StreamManager;
	preloadManager?: PreloadManager;
	pluginManager?: PluginManager;
	extensionManager?: ExtensionManager;
	actions?: PlayerAction;
	queue: QueueState;
	volume: VolumeState;
	filter: FilterState;
	connection: ConnectionState;
	playback: PlaybackNodeState;
	stream: StreamNodeState;
	preload: PreloadNodeState;
	session: SessionNodeState;
	lifecycle: LifecycleNodeState;
	forward: ForwardNodeState;
	antiStuck: AntiStuckNodeState;
	resourceRefresh: ResourceRefreshNodeState;
}

export function createPlayerContext(
	playerId: PlayerId,
	options: PlayerOptions = {},
	manager?: PlayerManager,
): PlayerContext {
	return {
		playerId,
		options,
		manager,
		player: null,
		destroyed: false,
		rejectNewActions: false,
		audioPlayer: null,
		queue: new QueueState(),
		volume: new VolumeState(options.volume ?? 100),
		filter: new FilterState(),
		connection: new ConnectionState(),
		playback: new PlaybackNodeState(),
		stream: new StreamNodeState(),
		preload: new PreloadNodeState(),
		session: new SessionNodeState(),
		lifecycle: new LifecycleNodeState(),
		forward: new ForwardNodeState(),
		antiStuck: new AntiStuckNodeState(),
		resourceRefresh: new ResourceRefreshNodeState(),
	};
}

/**
 * Process-wide player state partition. Controllers look up slices by playerId
 * instead of retaining a current-player pointer.
 */
export class PlayerStateRegistry {
	private static readonly GLOBAL_KEY = Symbol.for("ziplayer.PlayerStateRegistry");
	private readonly players = new Map<PlayerId, PlayerContext>();

	public static global(): PlayerStateRegistry {
		const root = globalThis as typeof globalThis & {
			[PlayerStateRegistry.GLOBAL_KEY]?: PlayerStateRegistry;
		};
		root[PlayerStateRegistry.GLOBAL_KEY] ??= new PlayerStateRegistry();
		return root[PlayerStateRegistry.GLOBAL_KEY]!;
	}

	public create(playerId: PlayerId, options: PlayerOptions = {}, manager?: PlayerManager): PlayerContext {
		if (!isPlayerScopedId(playerId)) throw new Error("playerId is required to create player state");
		this.delete(playerId);
		const context = createPlayerContext(playerId, options, manager);
		this.players.set(playerId, context);
		return context;
	}

	public get(playerId: PlayerId): PlayerContext | undefined {
		return this.players.get(playerId);
	}

	public require(playerId: PlayerId): PlayerContext {
		const context = this.players.get(requirePlayerId(playerId, "registry lookup"));
		if (!context) throw new Error(`Unknown playerId: ${playerId}`);
		if (context.destroyed || context.rejectNewActions) throw new Error(`Player ${playerId} is destroyed`);
		return context;
	}

	public has(playerId: PlayerId): boolean {
		return this.players.has(playerId);
	}

	public attachPlayer(playerId: PlayerId, player: Player): void {
		const context = this.players.get(playerId);
		if (context) context.player = player;
	}

	public markDestroying(playerId: PlayerId): PlayerContext | undefined {
		const context = this.players.get(playerId);
		if (context) {
			context.rejectNewActions = true;
			context.destroyed = true;
		}
		return context;
	}

	public delete(playerId: PlayerId): boolean {
		return this.players.delete(playerId);
	}

	public ids(): PlayerId[] {
		return [...this.players.keys()].filter((id) => id !== DEFAULT_PLAYER_ID);
	}

	public clear(): void {
		this.players.clear();
	}

	public get size(): number {
		return this.players.size;
	}
}

export const playerStateRegistry = PlayerStateRegistry.global();
