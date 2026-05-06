import type { Track, LoopMode, PlayerOptions } from ".";

export interface SerializedTrack {
	id: string;
	title: string;
	url: string;
	source: string;
	duration: number;
	thumbnail?: string;
	author?: string;
	requestedBy?: string;
	isLive?: boolean;
	artwork?: string;
	[key: string]: any; // For additional metadata
}

export interface SerializedQueue {
	tracks: SerializedTrack[];
	current: SerializedTrack | null;
	history: SerializedTrack[];
	loopMode: LoopMode;
	autoPlay: boolean;
	position?: number; // Current playback position in ms
}

export interface SerializedPlayer {
	guildId: string;
	queue: SerializedQueue;
	volume: number;
	isPlaying: boolean;
	isPaused: boolean;
	options: PlayerOptions;
	filters?: string[];
	lastUpdate: number;
	version: string; // For backward compatibility
}

export interface PersistenceOptions {
	enabled: boolean;
	provider?: "file" | "redis" | "database";
	saveInterval?: number; // Auto-save interval (ms)
	autoLoad?: boolean; // Auto-load on start
	maxBackups?: number; // Number of backups to keep
	compress?: boolean; // Compress saved data

	// File provider options
	filePath?: string;

	// Redis provider options
	redisUrl?: string;
	redisPrefix?: string;

	// Database options (for custom provider)
	save?: (data: Map<string, SerializedPlayer>) => Promise<void>;
	load?: () => Promise<Map<string, SerializedPlayer>>;
	delete?: (guildId: string) => Promise<void>;
	list?: () => Promise<string[]>;
}

export interface PersistenceProvider {
	save(key: string, data: any, compress?: boolean): Promise<void>;
	load(key: string): Promise<any>;
	delete(key: string): Promise<void>;
	list(): Promise<string[]>;
}
