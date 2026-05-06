import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";
import type { SerializedPlayer, SerializedQueue, SerializedTrack, PersistenceOptions, PersistenceProvider } from "../types";
import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Track } from "../types";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// File provider implementation
export class FileProvider implements PersistenceProvider {
	private basePath: string;
	private maxBackups: number;

	constructor(basePath: string, maxBackups: number = 5) {
		this.basePath = basePath;
		this.maxBackups = maxBackups;
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

	private cleanOldBackups(key: string): void {
		const backups = fs
			.readdirSync(this.basePath)
			.filter((f) => f.startsWith(key) && f.includes("backup"))
			.sort()
			.reverse();

		// Keep only maxBackups most recent
		for (let i = this.maxBackups; i < backups.length; i++) {
			const backupPath = path.join(this.basePath, backups[i]);
			fs.unlinkSync(backupPath);
		}
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
	}

	async list(): Promise<string[]> {
		const files = fs.readdirSync(this.basePath);
		return files.filter((f) => f.endsWith(".json") || f.endsWith(".json.gz")).map((f) => f.replace(/\.json(\.gz)?$/, ""));
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
			const backups = fs
				.readdirSync(this.basePath)
				.filter((f) => f.startsWith(key) && f.includes("backup"))
				.sort()
				.reverse();
			if (backups.length > 0) {
				backupFile = path.join(this.basePath, backups[0]);
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

// Custom provider for database integration
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
	private provider: PersistenceProvider;
	private saveInterval: NodeJS.Timeout | null = null;
	private isSaving: boolean = false;

	constructor(manager: PlayerManager, options: PersistenceOptions) {
		super();
		this.manager = manager;
		// Fix: Don't use spread that causes duplicate 'enabled'
		this.options = {
			enabled: true,
			provider: "file",
			saveInterval: 60000,
			autoLoad: true,
			maxBackups: 5,
			compress: false,
			filePath: "./players_data",
		};

		// Merge options manually to avoid spread duplication
		if (options.enabled !== undefined) this.options.enabled = options.enabled;
		if (options.provider !== undefined) this.options.provider = options.provider;
		if (options.saveInterval !== undefined) this.options.saveInterval = options.saveInterval;
		if (options.autoLoad !== undefined) this.options.autoLoad = options.autoLoad;
		if (options.maxBackups !== undefined) this.options.maxBackups = options.maxBackups;
		if (options.compress !== undefined) this.options.compress = options.compress;
		if (options.filePath !== undefined) this.options.filePath = options.filePath;
		if (options.redisUrl !== undefined) this.options.redisUrl = options.redisUrl;
		if (options.redisPrefix !== undefined) this.options.redisPrefix = options.redisPrefix;
		if (options.save !== undefined) this.options.save = options.save;
		if (options.load !== undefined) this.options.load = options.load;
		if (options.delete !== undefined) this.options.delete = options.delete;
		if (options.list !== undefined) this.options.list = options.list;

		this.provider = this.createProvider();

		if (this.options.enabled) {
			this.startAutoSave();

			if (this.options.autoLoad) {
				this.loadAll().catch((err) => {
					this.debug("Auto-load error:", err);
				});
			}
		}
	}

	private createProvider(): PersistenceProvider {
		switch (this.options.provider) {
			case "file":
				return new FileProvider(this.options.filePath!, this.options.maxBackups);
			case "redis":
				// Implement Redis provider if needed
				throw new Error("Redis provider not implemented yet");
			case "database":
				if (!this.options.save || !this.options.load) {
					throw new Error("Database provider requires save/load functions");
				}
				// Fix: Pass the save and load functions with correct signatures
				return new CustomProvider(
					async (key: string, data: any) => {
						if (this.options.save) {
							// Call with single object argument if that's expected
							const saveFn = this.options.save as any;
							if (saveFn.length === 1) {
								// Save function expects { key, data }
								await saveFn({ key, data });
							} else {
								// Save function expects (key, data)
								await saveFn(key, data);
							}
						}
					},
					async (key: string) => {
						if (this.options.load) {
							const loadFn = this.options.load as any;
							if (loadFn.length === 0) {
								// Load function expects no args, returns all data
								const allData = await loadFn();
								return allData?.get?.(key) || allData?.[key] || null;
							} else {
								// Load function expects key
								return await loadFn(key);
							}
						}
						return null;
					},
					this.options.delete,
					this.options.list,
				);
			default:
				return new FileProvider(this.options.filePath!, this.options.maxBackups);
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

	private serializeTrack(track: Track): SerializedTrack {
		// Create base object with required fields only (avoid duplication)
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

		// Add optional fields if they exist on the track
		const trackAny = track as any;
		if (trackAny.author) serialized.author = trackAny.author;
		if (trackAny.artwork) serialized.artwork = trackAny.artwork;

		// Add any extra metadata (excluding fields we already set)
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
		// Get filters safely - access through public method
		let filters: string[] = [];
		try {
			const filterString = (player as any).filter?.getFilterString();
			if (filterString) {
				filters = filterString.split(",").filter(Boolean);
			}
		} catch (e) {
			// Filter may not be accessible
		}

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
		};
	}

	private deserializeTrack(data: SerializedTrack): Track {
		// Create base track object
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

		// Add optional fields if they exist
		if (data.author) track.author = data.author;
		if (data.artwork) track.artwork = data.artwork;

		// Add any extra metadata from serialized data
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

		try {
			const data = this.serializePlayer(player);
			await this.provider.save(player.guildId, data);
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

			// Save in parallel with limit
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
	async loadPlayer(guildId: string, restorePosition: boolean = true): Promise<boolean> {
		if (!this.options.enabled) return false;

		try {
			const data = await this.provider.load(guildId);
			if (!data) return false;

			// Check if player already exists
			let player = this.manager.get(guildId);
			if (!player) {
				player = await this.manager.create(guildId, data.options);
			}

			// Restore queue
			const queue = data.queue as SerializedQueue;

			// Clear current queue
			player.queue.clear();
			player.queue.loop(queue.loopMode);
			player.queue.autoPlay(queue.autoPlay);

			// Restore tracks
			if (queue.tracks.length > 0) {
				const tracks = queue.tracks.map((t: SerializedTrack) => this.deserializeTrack(t));
				player.queue.addMultiple(tracks);
			}

			// Restore current track if exists
			if (queue.current && player.connection) {
				const currentTrack = this.deserializeTrack(queue.current);
				player.queue.willNextTrack(currentTrack);

				// Restore playback position if requested
				if (restorePosition && queue.position && queue.position > 0) {
					await player.refreshPlayerResource(true, queue.position);
				} else {
					await player.play(currentTrack);
				}
			}

			// Restore volume
			player.setVolume(data.volume);

			// Restore filters - safely access through public method
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
	 * Load all saved players
	 */
	async loadAll(restorePosition: boolean = true): Promise<Map<string, boolean>> {
		if (!this.options.enabled) return new Map();

		const results = new Map<string, boolean>();

		try {
			const keys = await this.provider.list();
			this.debug(`Found ${keys.length} saved players`);

			for (const guildId of keys) {
				const success = await this.loadPlayer(guildId, restorePosition);
				results.set(guildId, success);
			}

			this.emit("loadedAll", results);
		} catch (error) {
			this.debug("Failed to load players:", error);
			this.emit("error", error);
		}

		return results;
	}

	/**
	 * Delete a player's saved data
	 */
	async deletePlayer(guildId: string): Promise<boolean> {
		if (!this.options.enabled) return false;

		try {
			await this.provider.delete(guildId);
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

		return await (this.provider as FileProvider).restoreBackup(guildId, timestamp);
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
		this.debug("Persistence manager shut down");
	}
}
