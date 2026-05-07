import type { Track, LoopMode, PlayerOptions } from "../types";

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
	[key: string]: any;
}

export interface SerializedQueue {
	tracks: SerializedTrack[];
	current: SerializedTrack | null;
	history: SerializedTrack[];
	loopMode: LoopMode;
	autoPlay: boolean;
	position?: number;
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
	version: string;
	wasDestroyed?: boolean; // Track if player was destroyed
	destroyedAt?: number; // When it was destroyed
}

export interface PersistenceOptions {
	enabled: boolean;
	provider?: "file" | "redis" | "database";
	saveInterval?: number;
	autoLoad?: boolean;
	autoRestoreOnRestart?: boolean; //  Auto restore after restart
	restoreDelay?: number; // Delay before restoring (ms)
	maxBackups?: number; // Max backups per player (default: 5)
	maxTotalBackups?: number; // Max total backups across all players
	autoCleanupBackupsOnStart?: boolean; // Auto delete old backups on restart
	backupRetentionDays?: number; // Delete backups older than N days
	compress?: boolean;
	filePath?: string;
	redisUrl?: string;
	redisPrefix?: string;

	// Database provider functions (different signatures)
	save?: ((key: string, data: any) => Promise<void>) | ((data: any) => Promise<void>);
	load?: ((key: string) => Promise<any>) | (() => Promise<any>);
	delete?: (key: string) => Promise<void>;
	list?: () => Promise<string[]>;
}

export interface PersistenceProvider {
	save(key: string, data: any): Promise<void>;
	load(key: string): Promise<any>;
	delete(key: string): Promise<void>;
	list(): Promise<string[]>;
}

// Track destroyed players for restart detection
export interface DestroyedRecord {
	guildId: string;
	destroyedAt: number;
	reason?: string;
}

export interface BackupInfo {
	key: string;
	path: string;
	timestamp: number;
	size: number;
	isCompressed: boolean;
}
