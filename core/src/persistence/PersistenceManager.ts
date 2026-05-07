import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";
import type {
	SerializedPlayer,
	SerializedQueue,
	SerializedTrack,
	PersistenceOptions,
	PersistenceProvider,
	DestroyedRecord,
	BackupInfo,
} from "../types";
import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Track } from "../types";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// File provider implementation with enhanced backup management
class FileProvider implements PersistenceProvider {
	private basePath: string;
	private maxBackups: number;
	private maxTotalBackups: number;
	private backupRetentionDays: number;

	constructor(
		basePath: string,
		options: {
			maxBackups?: number;
			maxTotalBackups?: number;
			backupRetentionDays?: number;
		} = {},
	) {
		this.basePath = basePath;
		this.maxBackups = options.maxBackups ?? 5;
		this.maxTotalBackups = options.maxTotalBackups ?? 50;
		this.backupRetentionDays = options.backupRetentionDays ?? 7;

		if (!fs.existsSync(basePath)) {
			fs.mkdirSync(basePath, { recursive: true });
		}
	}

	private getFilePath(key: string): string {
		return path.join(this.basePath, `${key}.json`);
	}

	private getBackupPath(key: string, timestamp: number): string {
		return path.join(this.basePath, `${key}_backup_${timestamp}.json`);
	}

	private getAllBackups(): BackupInfo[] {
		const files = fs.readdirSync(this.basePath);
		const backups: BackupInfo[] = [];

		for (const file of files) {
			const match = file.match(/^(.+)_backup_(\d+)\.json(\.gz)?$/);
			if (match) {
				const [, key, timestampStr] = match;
				const timestamp = parseInt(timestampStr, 10);
				const filePath = path.join(this.basePath, file);
				const stats = fs.statSync(filePath);
				const isCompressed = file.endsWith(".gz");

				backups.push({
					key,
					path: filePath,
					timestamp,
					size: stats.size,
					isCompressed,
				});
			}
		}

		return backups.sort((a, b) => b.timestamp - a.timestamp);
	}

	private getBackupsByKey(key: string): BackupInfo[] {
		return this.getAllBackups().filter((b) => b.key === key);
	}

	private cleanOldBackups(key: string): void {
		const backups = this.getBackupsByKey(key);

		// Delete old backups exceeding maxBackups per player
		for (let i = this.maxBackups; i < backups.length; i++) {
			try {
				fs.unlinkSync(backups[i].path);
				console.log(`[Persistence] Deleted old backup: ${path.basename(backups[i].path)}`);
			} catch (err) {
				console.error(`[Persistence] Failed to delete backup: ${backups[i].path}`, err);
			}
		}
	}

	private cleanOldBackupsByAge(): void {
		const now = Date.now();
		const retentionMs = this.backupRetentionDays * 24 * 60 * 60 * 1000;
		const backups = this.getAllBackups();

		let deletedCount = 0;
		for (const backup of backups) {
			if (now - backup.timestamp > retentionMs) {
				try {
					fs.unlinkSync(backup.path);
					deletedCount++;
				} catch (err) {
					console.error(`[Persistence] Failed to delete old backup: ${backup.path}`, err);
				}
			}
		}

		if (deletedCount > 0) {
			console.log(`[Persistence] Deleted ${deletedCount} backups older than ${this.backupRetentionDays} days`);
		}
	}

	private cleanTotalBackupsLimit(): void {
		let backups = this.getAllBackups();

		if (backups.length <= this.maxTotalBackups) return;

		// Delete oldest backups
		const toDelete = backups.slice(this.maxTotalBackups);
		let deletedCount = 0;

		for (const backup of toDelete) {
			try {
				fs.unlinkSync(backup.path);
				deletedCount++;
			} catch (err) {
				console.error(`[Persistence] Failed to delete backup: ${backup.path}`, err);
			}
		}

		if (deletedCount > 0) {
			console.log(`[Persistence] Deleted ${deletedCount} backups (exceeded limit ${this.maxTotalBackups})`);
		}
	}

	// NEW: Clean all backups for a specific player
	async cleanAllBackupsForPlayer(key: string): Promise<number> {
		const backups = this.getBackupsByKey(key);
		let deletedCount = 0;

		for (const backup of backups) {
			try {
				fs.unlinkSync(backup.path);
				deletedCount++;
			} catch (err) {
				console.error(`[Persistence] Failed to delete backup: ${backup.path}`, err);
			}
		}

		if (deletedCount > 0) {
			console.log(`[Persistence] Deleted ${deletedCount} backups for player: ${key}`);
		}

		return deletedCount;
	}

	// NEW: Clean all backups
	async cleanAllBackups(): Promise<number> {
		const backups = this.getAllBackups();
		let deletedCount = 0;

		for (const backup of backups) {
			try {
				fs.unlinkSync(backup.path);
				deletedCount++;
			} catch (err) {
				console.error(`[Persistence] Failed to delete backup: ${backup.path}`, err);
			}
		}

		if (deletedCount > 0) {
			console.log(`[Persistence] Deleted all ${deletedCount} backups`);
		}

		return deletedCount;
	}

	// NEW: Get backup statistics
	getBackupStats(): {
		totalBackups: number;
		totalSize: number;
		oldestBackup: number | null;
		newestBackup: number | null;
		backupsByPlayer: Map<string, number>;
	} {
		const backups = this.getAllBackups();
		let totalSize = 0;
		let oldestBackup: number | null = null;
		let newestBackup: number | null = null;
		const backupsByPlayer = new Map<string, number>();

		for (const backup of backups) {
			totalSize += backup.size;
			if (oldestBackup === null || backup.timestamp < oldestBackup) oldestBackup = backup.timestamp;
			if (newestBackup === null || backup.timestamp > newestBackup) newestBackup = backup.timestamp;
			backupsByPlayer.set(backup.key, (backupsByPlayer.get(backup.key) || 0) + 1);
		}

		return {
			totalBackups: backups.length,
			totalSize,
			oldestBackup,
			newestBackup,
			backupsByPlayer,
		};
	}

	async save(key: string, data: any, compress: boolean = false): Promise<void> {
		const filePath = this.getFilePath(key);
		let content = JSON.stringify(data, null, 2);

		if (compress) {
			const compressed = await gzip(content);
			content = compressed.toString("base64");
			fs.writeFileSync(filePath + ".gz", content);
			return;
		}

		// Create backup before overwriting
		if (fs.existsSync(filePath)) {
			const backupPath = this.getBackupPath(key, Date.now());
			fs.copyFileSync(filePath, backupPath);
			this.cleanOldBackups(key);
			this.cleanTotalBackupsLimit();
			this.cleanOldBackupsByAge();
		}

		fs.writeFileSync(filePath, content);
	}

	async load(key: string): Promise<any> {
		const filePath = this.getFilePath(key);
		const gzPath = filePath + ".gz";

		if (fs.existsSync(gzPath)) {
			const compressed = fs.readFileSync(gzPath, "utf8");
			const buffer = Buffer.from(compressed, "base64");
			const decompressed = await gunzip(buffer);
			return JSON.parse(decompressed.toString());
		}

		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf8");
			return JSON.parse(content);
		}

		return null;
	}

	async delete(key: string): Promise<void> {
		const filePath = this.getFilePath(key);
		const gzPath = filePath + ".gz";

		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);

		// Also delete backups for this player
		await this.cleanAllBackupsForPlayer(key);
	}

	async list(): Promise<string[]> {
		const files = fs.readdirSync(this.basePath);
		return files
			.filter((f) => {
				// Exclude backup files
				if (f.includes("_backup_")) return false;
				return f.endsWith(".json") || f.endsWith(".json.gz");
			})
			.map((f) => f.replace(/\.json(\.gz)?$/, ""));
	}

	async restoreBackup(key: string, backupTimestamp?: number): Promise<boolean> {
		let backupFile: string | null = null;

		if (backupTimestamp) {
			const specific = this.getBackupPath(key, backupTimestamp);
			if (fs.existsSync(specific)) {
				backupFile = specific;
			}
		} else {
			// Get latest backup
			const backups = this.getBackupsByKey(key);
			if (backups.length > 0) {
				backupFile = backups[0].path;
			}
		}

		if (backupFile && fs.existsSync(backupFile)) {
			const content = fs.readFileSync(backupFile, "utf8");
			const data = JSON.parse(content);
			await this.save(key, data);
			return true;
		}

		return false;
	}
}

// Custom provider for database integration (giữ nguyên)
class CustomProvider implements PersistenceProvider {
	constructor(
		private saveFn: (key: string, data: any) => Promise<void>,
		private loadFn: (key: string) => Promise<any>,
		private deleteFn?: (key: string) => Promise<void>,
		private listFn?: () => Promise<string[]>,
	) {}

	async save(key: string, data: any): Promise<void> {
		await this.saveFn(key, data);
	}

	async load(key: string): Promise<any> {
		return await this.loadFn(key);
	}

	async delete(key: string): Promise<void> {
		if (this.deleteFn) {
			await this.deleteFn(key);
		}
	}

	async list(): Promise<string[]> {
		if (this.listFn) {
			return await this.listFn();
		}
		return [];
	}
}

export class PersistenceManager extends EventEmitter {
	private manager: PlayerManager;
	private options: PersistenceOptions;
	private provider: FileProvider | CustomProvider;
	private saveInterval: NodeJS.Timeout | null = null;
	private isSaving: boolean = false;
	private isRestoring: boolean = false;
	private destroyedPlayers: Map<string, DestroyedRecord> = new Map();
	private restoredPlayers: Set<string> = new Set();
	private backupCleanupDone: boolean = false;

	constructor(manager: PlayerManager, options: PersistenceOptions) {
		super();
		this.manager = manager;

		// Default options
		this.options = {
			enabled: true,
			provider: "file",
			saveInterval: 60000,
			autoLoad: true,
			autoRestoreOnRestart: true,
			restoreDelay: 5000,
			maxBackups: 5,
			maxTotalBackups: 10,
			autoCleanupBackupsOnStart: true,
			backupRetentionDays: 2,
			compress: false,
			filePath: "./players_data",
		};

		// Merge manually
		if (options.enabled !== undefined) this.options.enabled = options.enabled;
		if (options.provider !== undefined) this.options.provider = options.provider;
		if (options.saveInterval !== undefined) this.options.saveInterval = options.saveInterval;
		if (options.autoLoad !== undefined) this.options.autoLoad = options.autoLoad;
		if (options.autoRestoreOnRestart !== undefined) this.options.autoRestoreOnRestart = options.autoRestoreOnRestart;
		if (options.restoreDelay !== undefined) this.options.restoreDelay = options.restoreDelay;
		if (options.maxBackups !== undefined) this.options.maxBackups = options.maxBackups;
		if (options.maxTotalBackups !== undefined) this.options.maxTotalBackups = options.maxTotalBackups;
		if (options.autoCleanupBackupsOnStart !== undefined)
			this.options.autoCleanupBackupsOnStart = options.autoCleanupBackupsOnStart;
		if (options.backupRetentionDays !== undefined) this.options.backupRetentionDays = options.backupRetentionDays;
		if (options.compress !== undefined) this.options.compress = options.compress;
		if (options.filePath !== undefined) this.options.filePath = options.filePath;
		if (options.redisUrl !== undefined) this.options.redisUrl = options.redisUrl;
		if (options.redisPrefix !== undefined) this.options.redisPrefix = options.redisPrefix;
		if (options.save !== undefined) this.options.save = options.save;
		if (options.load !== undefined) this.options.load = options.load;
		if (options.delete !== undefined) this.options.delete = options.delete;
		if (options.list !== undefined) this.options.list = options.list;

		this.provider = this.createProvider();

		// Hook into player destroy events
		this.setupDestroyTracking();

		// Clean up old backups on start
		if (this.options.enabled && this.options.autoCleanupBackupsOnStart) {
			this.cleanupBackupsOnStart().catch((err) => {
				this.debug("Backup cleanup on start error:", err);
			});
		}

		if (this.options.enabled) {
			this.startAutoSave();

			if (this.options.autoLoad) {
				this.loadAll().catch((err) => {
					this.debug("Auto-load error:", err);
				});
			}
		}
	}

	private setupDestroyTracking(): void {
		this.manager.on("playerDestroy", (player: Player) => {
			this.markAsDestroyed(player.guildId);
		});
	}

	private createProvider(): FileProvider | CustomProvider {
		switch (this.options.provider) {
			case "file":
				return new FileProvider(this.options.filePath!, {
					maxBackups: this.options.maxBackups,
					maxTotalBackups: this.options.maxTotalBackups,
					backupRetentionDays: this.options.backupRetentionDays,
				});
			case "redis":
				throw new Error("Redis provider not implemented yet");
			case "database":
				if (!this.options.save || !this.options.load) {
					throw new Error("Database provider requires save/load functions");
				}
				return new CustomProvider(
					async (key: string, data: any) => {
						if (this.options.save) {
							const saveFn = this.options.save as any;
							if (saveFn.length === 1) {
								await saveFn({ key, data });
							} else {
								await saveFn(key, data);
							}
						}
					},
					async (key: string) => {
						if (this.options.load) {
							const loadFn = this.options.load as any;
							if (loadFn.length === 0) {
								const allData = await loadFn();
								return allData?.get?.(key) || allData?.[key] || null;
							} else {
								return await loadFn(key);
							}
						}
						return null;
					},
					this.options.delete,
					this.options.list,
				);
			default:
				return new FileProvider(this.options.filePath!, {
					maxBackups: this.options.maxBackups,
					maxTotalBackups: this.options.maxTotalBackups,
					backupRetentionDays: this.options.backupRetentionDays,
				});
		}
	}

	private debug(message: any, ...params: any[]): void {
		if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[Persistence] ${message}`, ...params);
		}
	}

	private startAutoSave(): void {
		if (this.saveInterval) {
			clearInterval(this.saveInterval);
		}

		this.saveInterval = setInterval(() => {
			this.saveAll().catch((err) => {
				this.debug("Auto-save error:", err);
				this.emit("error", err);
			});
		}, this.options.saveInterval);

		this.debug(`Auto-save started (interval: ${this.options.saveInterval}ms)`);
	}

	// NEW: Cleanup backups on startup
	private async cleanupBackupsOnStart(): Promise<void> {
		if (this.backupCleanupDone) return;

		this.debug("Starting backup cleanup on startup...");

		// Only works for file provider
		if (this.provider instanceof FileProvider) {
			try {
				// Clean old backups by age
				// This is already handled in FileProvider, but we can log stats
				const stats = this.provider.getBackupStats();

				this.debug(`Backup stats before cleanup:`, {
					totalBackups: stats.totalBackups,
					totalSizeMB: (stats.totalSize / 1024 / 1024).toFixed(2),
					oldestBackup: stats.oldestBackup ? new Date(stats.oldestBackup).toISOString() : null,
					newestBackup: stats.newestBackup ? new Date(stats.newestBackup).toISOString() : null,
					backupsByPlayer: Object.fromEntries(stats.backupsByPlayer),
				});

				// Emit stats event
				this.emit("backupStats", stats);

				// The cleanup is already happening in FileProvider.save()
				// But we can do a one-time deep cleanup on start
				if (this.options.backupRetentionDays && this.options.backupRetentionDays > 0) {
					// Force a cleanup pass
					const deletedCount = await this.cleanOldBackupsByAge();
					if (deletedCount > 0) {
						this.debug(`Cleaned up ${deletedCount} old backups on startup`);
					}
				}

				// Enforce total backup limit
				const totalLimitDeleted = await this.enforceTotalBackupLimit();
				if (totalLimitDeleted > 0) {
					this.debug(`Enforced backup limit: deleted ${totalLimitDeleted} backups`);
				}

				this.backupCleanupDone = true;
				this.emit("backupCleanupDone");
			} catch (error) {
				this.debug("Backup cleanup error:", error);
			}
		} else {
			this.debug("Backup cleanup only supported for file provider");
		}
	}

	// NEW: Clean old backups by age
	private async cleanOldBackupsByAge(): Promise<number> {
		if (!(this.provider instanceof FileProvider)) return 0;

		const retentionMs = (this.options.backupRetentionDays ?? 2) * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const backups = (this.provider as any).getAllBackups();
		let deletedCount = 0;

		for (const backup of backups) {
			if (now - backup.timestamp > retentionMs) {
				try {
					fs.unlinkSync(backup.path);
					deletedCount++;
				} catch (err) {
					this.debug(`Failed to delete old backup: ${backup.path}`, err);
				}
			}
		}

		if (deletedCount > 0) {
			this.debug(`Deleted ${deletedCount} backups older than ${this.options.backupRetentionDays} days`);
		}

		return deletedCount;
	}

	// NEW: Enforce total backup limit
	private async enforceTotalBackupLimit(): Promise<number> {
		if (!(this.provider instanceof FileProvider)) return 0;

		const backups = (this.provider as any).getAllBackups();
		const maxTotal = this.options.maxTotalBackups ?? 50;

		if (backups.length <= maxTotal) return 0;

		const toDelete = backups.slice(maxTotal);
		let deletedCount = 0;

		for (const backup of toDelete) {
			try {
				fs.unlinkSync(backup.path);
				deletedCount++;
			} catch (err) {
				this.debug(`Failed to delete backup: ${backup.path}`, err);
			}
		}

		if (deletedCount > 0) {
			this.debug(`Deleted ${deletedCount} backups (exceeded limit ${maxTotal})`);
		}

		return deletedCount;
	}

	private markAsDestroyed(guildId: string): void {
		this.destroyedPlayers.set(guildId, {
			guildId,
			destroyedAt: Date.now(),
			reason: "player_destroy",
		});
		this.debug(`Marked player as destroyed: ${guildId}`);

		this.saveDestroyedStatus().catch((err) => {
			this.debug("Failed to save destroyed status:", err);
		});
	}

	private isDestroyed(guildId: string): boolean {
		return this.destroyedPlayers.has(guildId);
	}

	private async saveDestroyedStatus(): Promise<void> {
		const destroyedData = Array.from(this.destroyedPlayers.values());
		await this.provider.save("__destroyed_players__", destroyedData);
	}

	private async loadDestroyedStatus(): Promise<void> {
		try {
			const data = await this.provider.load("__destroyed_players__");
			if (data && Array.isArray(data)) {
				this.destroyedPlayers.clear();
				for (const record of data) {
					this.destroyedPlayers.set(record.guildId, record);
				}
				this.debug(`Loaded ${this.destroyedPlayers.size} destroyed player records`);
			}
		} catch (error) {
			this.debug("Failed to load destroyed status:", error);
		}
	}

	private async clearDestroyedStatus(guildId: string): Promise<void> {
		this.destroyedPlayers.delete(guildId);
		await this.saveDestroyedStatus();
	}

	private serializeTrack(track: Track): SerializedTrack {
		const serialized: SerializedTrack = {
			id: track.id,
			title: track.title,
			url: track.url,
			source: track.source,
			duration: track.duration,
			thumbnail: track.thumbnail,
			requestedBy: track.requestedBy,
			isLive: track.isLive || false,
		};

		const trackAny = track as any;
		if (trackAny.author) serialized.author = trackAny.author;
		if (trackAny.artwork) serialized.artwork = trackAny.artwork;

		const excludedFields = new Set([
			"id",
			"title",
			"url",
			"source",
			"duration",
			"thumbnail",
			"requestedBy",
			"isLive",
			"author",
			"artwork",
		]);
		for (const key of Object.keys(trackAny)) {
			if (!excludedFields.has(key) && trackAny[key] !== undefined) {
				(serialized as any)[key] = trackAny[key];
			}
		}

		return serialized;
	}

	private serializeQueue(player: Player): SerializedQueue {
		return {
			tracks: player.upcomingTracks.map((t) => this.serializeTrack(t)),
			current: player.currentTrack ? this.serializeTrack(player.currentTrack) : null,
			history: player.previousTracks.map((t) => this.serializeTrack(t)),
			loopMode: player.queue.loop(),
			autoPlay: player.queue.autoPlay(),
			position: player.getTime().current,
		};
	}

	private serializePlayer(player: Player): SerializedPlayer {
		let filters: string[] = [];
		try {
			const filterString = (player as any).filter?.getFilterString();
			if (filterString) {
				filters = filterString.split(",").filter(Boolean);
			}
		} catch (e) {}

		return {
			guildId: player.guildId,
			queue: this.serializeQueue(player),
			volume: player.volume,
			isPlaying: player.isPlaying,
			isPaused: player.isPaused,
			options: player.options,
			filters: filters.length > 0 ? filters : undefined,
			lastUpdate: Date.now(),
			version: "1.0.0",
			wasDestroyed: false,
		};
	}

	private deserializeTrack(data: SerializedTrack): Track {
		const track: any = {
			id: data.id,
			title: data.title,
			url: data.url,
			source: data.source,
			duration: data.duration,
			thumbnail: data.thumbnail,
			requestedBy: data.requestedBy,
			isLive: data.isLive || false,
		};

		if (data.author) track.author = data.author;
		if (data.artwork) track.artwork = data.artwork;

		for (const key of Object.keys(data)) {
			if (
				!["id", "title", "url", "source", "duration", "thumbnail", "requestedBy", "isLive", "author", "artwork"].includes(key)
			) {
				track[key] = (data as any)[key];
			}
		}

		return track as Track;
	}

	/**
	 * Save a single player
	 */
	async savePlayer(player: Player): Promise<boolean> {
		if (!this.options.enabled) return false;

		if (this.isDestroyed(player.guildId)) {
			this.debug(`Skipping save for destroyed player: ${player.guildId}`);
			return false;
		}

		try {
			const data = this.serializePlayer(player);
			await this.provider.save(player.guildId, data, this.options.compress);
			this.debug(`Saved player: ${player.guildId}`);
			this.emit("playerSaved", player.guildId);
			return true;
		} catch (error) {
			this.debug(`Failed to save player ${player.guildId}:`, error);
			this.emit("error", error);
			return false;
		}
	}

	/**
	 * Save all players
	 */
	async saveAll(): Promise<Map<string, boolean>> {
		if (!this.options.enabled || this.isSaving) return new Map();

		this.isSaving = true;
		const results = new Map<string, boolean>();

		try {
			const players = this.manager.getAll();
			this.debug(`Saving ${players.length} players...`);

			const batchSize = 5;
			for (let i = 0; i < players.length; i += batchSize) {
				const batch = players.slice(i, i + batchSize);
				const promises = batch.map((p) => this.savePlayer(p));
				const batchResults = await Promise.all(promises);
				batch.forEach((p, idx) => results.set(p.guildId, batchResults[idx]));
			}

			this.debug(`Saved ${results.size} players`);
			this.emit("savedAll", results);
		} finally {
			this.isSaving = false;
		}

		return results;
	}

	/**
	 * Load a single player
	 */
	async loadPlayer(guildId: string, restorePosition: boolean = true, skipIfDestroyed: boolean = true): Promise<boolean> {
		if (!this.options.enabled) return false;

		if (skipIfDestroyed && this.isDestroyed(guildId)) {
			this.debug(`Skipping load for destroyed player: ${guildId}`);
			this.emit("playerSkipped", guildId, "destroyed");
			return false;
		}

		if (this.restoredPlayers.has(guildId)) {
			this.debug(`Skipping already restored player: ${guildId}`);
			return true;
		}

		try {
			const data = await this.provider.load(guildId);
			if (!data) return false;

			if (data.wasDestroyed === true) {
				this.debug(`Skipping load for player marked as destroyed: ${guildId}`);
				return false;
			}

			let player = this.manager.get(guildId);
			if (!player) {
				player = await this.manager.create(guildId, data.options);
			}

			const queue = data.queue as SerializedQueue;

			player.queue.clear();
			player.queue.loop(queue.loopMode);
			player.queue.autoPlay(queue.autoPlay);

			if (queue.tracks.length > 0) {
				const tracks = queue.tracks.map((t) => this.deserializeTrack(t));
				player.queue.addMultiple(tracks);
			}

			if (queue.current && player.connection) {
				const currentTrack = this.deserializeTrack(queue.current);
				player.queue.willNextTrack(currentTrack);

				if (restorePosition && queue.position && queue.position > 0) {
					await player.refreshPlayerResource(true, queue.position);
				} else {
					await player.play(currentTrack);
				}
			}

			player.setVolume(data.volume);

			if (data.filters && data.filters.length > 0) {
				try {
					const filterManager = (player as any).filter;
					if (filterManager && typeof filterManager.applyFilters === "function") {
						await filterManager.applyFilters(data.filters);
					}
				} catch (e) {
					this.debug(`Failed to restore filters for ${guildId}:`, e);
				}
			}

			this.restoredPlayers.add(guildId);
			await this.clearDestroyedStatus(guildId);

			this.debug(`Loaded player: ${guildId}`);
			this.emit("playerLoaded", guildId, data);
			return true;
		} catch (error) {
			this.debug(`Failed to load player ${guildId}:`, error);
			this.emit("error", error);
			return false;
		}
	}

	/**
	 * Load all saved players with auto-restore logic
	 */
	async loadAll(restorePosition: boolean = true): Promise<Map<string, boolean>> {
		if (!this.options.enabled) return new Map();

		await this.loadDestroyedStatus();

		const results = new Map<string, boolean>();

		try {
			const keys = await this.provider.list();
			const playerKeys = keys.filter((k) => k !== "__destroyed_players__");
			this.debug(`Found ${playerKeys.length} saved players`);

			if (this.options.autoRestoreOnRestart) {
				this.debug(`Auto-restore enabled, restoring players after ${this.options.restoreDelay}ms delay...`);

				if (this.options.restoreDelay && this.options.restoreDelay > 0) {
					await new Promise((resolve) => setTimeout(resolve, this.options.restoreDelay));
				}

				for (const guildId of playerKeys) {
					const success = await this.loadPlayer(guildId, restorePosition, true);
					results.set(guildId, success);
				}
			} else {
				for (const guildId of playerKeys) {
					const success = await this.loadPlayer(guildId, restorePosition, true);
					results.set(guildId, success);
				}
			}

			this.emit("loadedAll", results);
		} catch (error) {
			this.debug("Failed to load players:", error);
			this.emit("error", error);
		}

		return results;
	}

	/**
	 * Mark a player as destroyed
	 */
	async markPlayerDestroyed(guildId: string, reason?: string): Promise<void> {
		this.destroyedPlayers.set(guildId, {
			guildId,
			destroyedAt: Date.now(),
			reason: reason || "manual_destroy",
		});

		try {
			const data = await this.provider.load(guildId);
			if (data) {
				data.wasDestroyed = true;
				data.destroyedAt = Date.now();
				await this.provider.save(guildId, data, this.options.compress);
			}
		} catch (error) {
			this.debug(`Failed to mark player data as destroyed: ${guildId}`, error);
		}

		await this.saveDestroyedStatus();
		this.debug(`Marked player as destroyed (won't restore on restart): ${guildId}`);
		this.emit("playerMarkedDestroyed", guildId);
	}

	/**
	 * Clear destroyed status for a player
	 */
	async clearDestroyed(guildId: string): Promise<void> {
		await this.clearDestroyedStatus(guildId);

		try {
			const data = await this.provider.load(guildId);
			if (data) {
				data.wasDestroyed = false;
				delete data.destroyedAt;
				await this.provider.save(guildId, data, this.options.compress);
			}
		} catch (error) {
			this.debug(`Failed to clear destroyed flag in data: ${guildId}`, error);
		}

		this.debug(`Cleared destroyed status for: ${guildId}`);
		this.emit("playerDestroyedCleared", guildId);
	}

	/**
	 * Delete a player's saved data
	 */
	async deletePlayer(guildId: string): Promise<boolean> {
		if (!this.options.enabled) return false;

		try {
			await this.provider.delete(guildId);
			await this.clearDestroyedStatus(guildId);
			this.restoredPlayers.delete(guildId);
			this.debug(`Deleted saved data for: ${guildId}`);
			this.emit("playerDeleted", guildId);
			return true;
		} catch (error) {
			this.debug(`Failed to delete player ${guildId}:`, error);
			return false;
		}
	}

	/**
	 * Restore from backup
	 */
	async restoreBackup(guildId: string, timestamp?: number): Promise<boolean> {
		if (!(this.provider instanceof FileProvider)) {
			this.debug("Restore from backup only supported for file provider");
			return false;
		}

		const success = await (this.provider as FileProvider).restoreBackup(guildId, timestamp);
		if (success) {
			await this.clearDestroyed(guildId);
		}
		return success;
	}

	/**
	 * Clean all backups for a specific player
	 */
	async cleanBackupsForPlayer(guildId: string): Promise<number> {
		if (!(this.provider instanceof FileProvider)) {
			this.debug("Backup cleanup only supported for file provider");
			return 0;
		}

		const deleted = await (this.provider as FileProvider).cleanAllBackupsForPlayer(guildId);
		this.debug(`Cleaned ${deleted} backups for player: ${guildId}`);
		this.emit("backupsCleaned", guildId, deleted);
		return deleted;
	}

	/**
	 * Clean all backups
	 */
	async cleanAllBackups(): Promise<number> {
		if (!(this.provider instanceof FileProvider)) {
			this.debug("Backup cleanup only supported for file provider");
			return 0;
		}

		const deleted = await (this.provider as FileProvider).cleanAllBackups();
		this.debug(`Cleaned all ${deleted} backups`);
		this.emit("allBackupsCleaned", deleted);
		return deleted;
	}

	/**
	 * Get backup statistics
	 */
	getBackupStats(): {
		totalBackups: number;
		totalSizeMB: number;
		oldestBackup: Date | null;
		newestBackup: Date | null;
		backupsByPlayer: Record<string, number>;
	} | null {
		if (!(this.provider instanceof FileProvider)) {
			this.debug("Backup stats only supported for file provider");
			return null;
		}

		const stats = (this.provider as FileProvider).getBackupStats();

		return {
			totalBackups: stats.totalBackups,
			totalSizeMB: stats.totalSize / 1024 / 1024,
			oldestBackup: stats.oldestBackup ? new Date(stats.oldestBackup) : null,
			newestBackup: stats.newestBackup ? new Date(stats.newestBackup) : null,
			backupsByPlayer: Object.fromEntries(stats.backupsByPlayer),
		};
	}

	/**
	 * Stop auto-save and clean up
	 */
	async shutdown(): Promise<void> {
		if (this.saveInterval) {
			clearInterval(this.saveInterval);
			this.saveInterval = null;
		}

		await this.saveAll();
		await this.saveDestroyedStatus();
		this.debug("Persistence manager shut down");
	}

	/**
	 * Get list of destroyed players
	 */
	getDestroyedPlayers(): DestroyedRecord[] {
		return Array.from(this.destroyedPlayers.values());
	}

	/**
	 * Check if auto-restore is enabled
	 */
	isAutoRestoreEnabled(): boolean {
		return this.options.autoRestoreOnRestart === true;
	}
}
