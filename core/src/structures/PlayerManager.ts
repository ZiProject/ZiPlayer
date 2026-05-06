import { EventEmitter } from "events";
import { Player } from "./Player";
import {
	PlayerManagerOptions,
	PlayerOptions,
	Track,
	SourcePlugin,
	SearchResult,
	ManagerEvents,
	PlayerStats,
	PersistenceOptions,
} from "../types";
import type { BaseExtension } from "../extensions";
import { withTimeout } from "../utils/timeout";
import { PersistenceManager } from "../persistence/PersistenceManager";

const GLOBAL_MANAGER_KEY: symbol = Symbol.for("ziplayer.PlayerManager.instance");

export const getGlobalManager = (): PlayerManager | null => {
	try {
		const instance = (globalThis as any)[GLOBAL_MANAGER_KEY];
		if (!instance) {
			return null;
		}
		return instance as PlayerManager;
	} catch (error) {
		console.error("[PlayerManager] Error getting global instance:", error);
		return null;
	}
};

const setGlobalManager = (instance: PlayerManager): void => {
	try {
		(globalThis as any)[GLOBAL_MANAGER_KEY] = instance;
	} catch (error) {
		console.error("[PlayerManager] Error setting global instance:", error);
	}
};

export declare interface PlayerManager {
	on<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void): this;
	emit<K extends keyof ManagerEvents>(event: K, ...args: ManagerEvents[K]): boolean;
}

interface ManagerCacheEntry<T> {
	data: T;
	timestamp: number;
	expiresAt: number;
}

/**
 * The main class for managing players across multiple Discord guilds.
 *
 * @example
 * // Basic setup with plugins and extensions
 * const manager = new PlayerManager({
 *   plugins: [
 *     new YouTubePlugin(),
 *     new SoundCloudPlugin(),
 *     new SpotifyPlugin(),
 *     new TTSPlugin({ defaultLang: "en" })
 *   ],
 *   extensions: [
 *     new voiceExt(null, { lang: "en-US" }),
 *     new lavalinkExt(null, {
 *       nodes: [{ host: "localhost", port: 2333, password: "youshallnotpass" }]
 *     })
 *   ],
 *   extractorTimeout: 10000,
 *   autoCleanup: true,
 *   cleanupInterval: 60000
 * });
 *
 * // Create a player for a guild
 * const player = await manager.create(guildId, {
 *   tts: { interrupt: true, volume: 1 },
 *   leaveOnEnd: true,
 *   leaveTimeout: 30000
 * });
 *
 * // Get existing player
 * const existingPlayer = manager.get(guildId);
 * if (existingPlayer) {
 *   await existingPlayer.play("Never Gonna Give You Up", userId);
 * }
 */
export class PlayerManager extends EventEmitter {
	private static instance: PlayerManager | null = null;
	private players: Map<string, Player> = new Map();
	private searchCache: Map<string, ManagerCacheEntry<SearchResult>>;
	private readonly SEARCH_CACHE_TTL = 60 * 1000; // 1 minute
	private readonly MAX_CACHE_SIZE = 100;
	private cleanupInterval: NodeJS.Timeout | null = null;
	private statsInterval: NodeJS.Timeout | null = null;

	private persistenceManager?: PersistenceManager;
	static async default(opt?: PlayerOptions): Promise<Player> {
		let globaldef = getGlobalManager();
		if (!globaldef) {
			globaldef = new PlayerManager({});
		}
		return await globaldef.create("default", opt);
	}

	private plugins: SourcePlugin[];
	private extensions: any[];
	private B_debug: boolean = false;
	private extractorTimeout: number = 10000;
	private autoCleanup: boolean = true;
	private cleanupTimeout: number = 60000; // 1 minute
	private enableSearchCache: boolean = true;

	private debug(message?: any, ...optionalParams: any[]): void {
		if (this.listenerCount("debug") > 0) {
			this.emit("debug", `[PlayerManager] ${message}`, ...optionalParams);
			if (!this.B_debug) {
				this.B_debug = true;
			}
		}
	}

	constructor(options: PlayerManagerOptions = {}) {
		super();
		this.plugins = [];
		this.searchCache = new Map();

		// Initialize plugins
		const provided = options.plugins || [];
		for (const p of provided as any[]) {
			try {
				if (p && typeof p === "object") {
					this.plugins.push(p as SourcePlugin);
				} else if (typeof p === "function") {
					const instance = new (p as any)();
					this.plugins.push(instance as SourcePlugin);
				}
				this.debug(`Registered plugin: ${p.name || "unnamed"}`);
			} catch (e) {
				this.debug(`Failed to init plugin:`, e);
			}
		}

		this.extensions = options.extensions || [];
		this.extractorTimeout = options.extractorTimeout ?? 10000;
		this.autoCleanup = options.autoCleanup ?? true;
		this.cleanupTimeout = options.cleanupInterval ?? 60000;
		this.enableSearchCache = options.enableSearchCache ?? true;

		if (options.persistence) {
			this.initPersistence(options.persistence);
		}
		// Setup auto cleanup
		if (this.autoCleanup) {
			this.startAutoCleanup();
		}

		// Setup stats collection (optional)
		if (options.enableStatsCollection) {
			this.startStatsCollection();
		}

		setGlobalManager(this);
		this.debug(`Initialized with ${this.plugins.length} plugins, ${this.extensions.length} extensions`);
	}

	private withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
		const timeout = this.extractorTimeout;
		return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeout))]);
	}

	private resolveGuildId(guildOrId: string | { id: string }): string {
		if (typeof guildOrId === "string") return guildOrId;
		if (guildOrId && typeof guildOrId === "object" && "id" in guildOrId) return guildOrId.id;
		throw new Error("Invalid guild or guildId provided.");
	}

	private getSearchCacheKey(query: string): string {
		return query.toLowerCase().trim();
	}

	private getCachedSearch(query: string): SearchResult | null {
		if (!this.enableSearchCache) return null;

		const key = this.getSearchCacheKey(query);
		const cached = this.searchCache.get(key);

		if (cached && Date.now() < cached.expiresAt) {
			this.debug(`[Cache] Search hit for: ${query}`);
			return cached.data;
		}

		if (cached) {
			this.searchCache.delete(key);
		}

		return null;
	}

	private setCachedSearch(query: string, result: SearchResult): void {
		if (!this.enableSearchCache) return;

		// Clean up old entries if cache is too large
		if (this.searchCache.size >= this.MAX_CACHE_SIZE) {
			const oldest = Array.from(this.searchCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
			if (oldest) this.searchCache.delete(oldest[0]);
		}

		const key = this.getSearchCacheKey(query);
		this.searchCache.set(key, {
			data: result,
			timestamp: Date.now(),
			expiresAt: Date.now() + this.SEARCH_CACHE_TTL,
		});
		this.debug(`[Cache] Search stored for: ${query}`);
	}

	private clearExpiredCache(): void {
		const now = Date.now();
		let expiredCount = 0;

		for (const [key, entry] of this.searchCache) {
			if (now >= entry.expiresAt) {
				this.searchCache.delete(key);
				expiredCount++;
			}
		}

		if (expiredCount > 0) {
			this.debug(`[Cache] Cleared ${expiredCount} expired search entries`);
		}
	}

	private startAutoCleanup(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		this.cleanupInterval = setInterval(() => {
			this.cleanupInactivePlayers();
			this.clearExpiredCache();
		}, this.cleanupTimeout);

		this.debug(`Auto-cleanup started with interval: ${this.cleanupTimeout}ms`);
	}

	private startStatsCollection(): void {
		if (this.statsInterval) {
			clearInterval(this.statsInterval);
		}

		this.statsInterval = setInterval(() => {
			const stats = this.getStats();
			this.emit("stats", stats);
		}, 30000); // Every 30 seconds
	}

	private cleanupInactivePlayers(): void {
		let cleanedCount = 0;

		for (const [guildId, player] of this.players) {
			// Clean up players that are not playing and not connected
			if (!player.isPlaying && !player.connection && player.queue.isEmpty) {
				const idleTime = Date.now() - (player as any)._lastActivity || Date.now();
				if (idleTime > this.cleanupTimeout) {
					this.debug(`Cleaning up inactive player for guild: ${guildId}`);
					player.destroy();
					this.players.delete(guildId);
					cleanedCount++;
				}
			}
		}

		if (cleanedCount > 0) {
			this.debug(`Cleaned up ${cleanedCount} inactive players`);
		}
	}

	/**
	 * Create a new player for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @param {PlayerOptions} options - Player configuration options
	 * @returns {Promise<Player>} The created player instance
	 */
	async create(guildOrId: string | { id: string }, options?: PlayerOptions): Promise<Player> {
		const guildId = this.resolveGuildId(guildOrId);

		if (this.players.has(guildId)) {
			this.debug(`Player already exists for guildId: ${guildId}, returning existing`);
			return this.players.get(guildId)!;
		}

		this.debug(`Creating player for guildId: ${guildId}`);
		const player = new Player(guildId, options, this);

		// Add all registered plugins
		this.plugins.forEach((plugin) => player.addPlugin(plugin));

		// Activate extensions
		let extsToActivate: any[] = [];
		const optExts = (options as any)?.extensions as any[] | string[] | undefined;

		if (Array.isArray(optExts)) {
			if (optExts.length === 0) {
				extsToActivate = [];
			} else if (typeof optExts[0] === "string") {
				const wanted = new Set(optExts as string[]);
				extsToActivate = this.extensions.filter((ext) => {
					const name = typeof ext === "function" ? ext.name : ext?.name;
					return !!name && wanted.has(name);
				});
			} else {
				extsToActivate = optExts;
			}
		} else {
			// Use all extensions by default
			extsToActivate = this.extensions;
		}

		for (const ext of extsToActivate) {
			let instance = ext;
			if (typeof ext === "function") {
				try {
					instance = new ext(player);
				} catch (e) {
					this.debug(`Extension constructor error for ${ext.name}:`, e);
					continue;
				}
			}

			if (instance && typeof instance === "object") {
				const extInstance = instance as BaseExtension;
				if ("player" in extInstance && !extInstance.player) extInstance.player = player;
				player.attachExtension(extInstance);

				if (typeof extInstance.active === "function") {
					let activated: boolean | void = true;
					try {
						activated = await withTimeout(
							Promise.resolve(extInstance.active({ manager: this, player })),
							player.options.extractorTimeout ?? 15000,
							`Extension ${extInstance?.name} activation timed out`,
						);
						this.debug(`Extension ${extInstance?.name} active check returned: ${activated}`);
					} catch (e) {
						activated = false;
						this.debug(`Extension activation error for ${extInstance?.name}:`, e);
					}

					if (activated === false) {
						player.detachExtension(extInstance);
						continue;
					}
				}
			}
		}

		// Forward all player events to manager
		this.setupEventForwarding(player, guildId);

		// Mark last activity
		(player as any)._lastActivity = Date.now();

		this.players.set(guildId, player);
		this.debug(`Player created for guildId: ${guildId}`);
		return player;
	}

	private setupEventForwarding(player: Player, guildId: string): void {
		player.on("willPlay", (track, tracks) => this.emit("willPlay", player, track as Track, tracks as Track[]));
		player.on("trackStart", (track) => {
			(player as any)._lastActivity = Date.now();
			this.emit("trackStart", player, track as Track);
		});
		player.on("trackEnd", (track) => this.emit("trackEnd", player, track as Track));
		player.on("queueEnd", () => this.emit("queueEnd", player));
		player.on("playerError", (error, track) => this.emit("playerError", player, error, track as Track));
		player.on("connectionError", (error) => this.emit("connectionError", player, error));
		player.on("volumeChange", (oldVol, newVol) => this.emit("volumeChange", player, oldVol as number, newVol as number));
		player.on("queueAdd", (track) => this.emit("queueAdd", player, track as Track));
		player.on("queueAddList", (tracks) => this.emit("queueAddList", player, tracks as Track[]));
		player.on("queueRemove", (track, index) => this.emit("queueRemove", player, track as Track, index as number));
		player.on("playerPause", (track) => this.emit("playerPause", player, track as Track));
		player.on("playerResume", (track) => this.emit("playerResume", player, track as Track));
		player.on("playerStop", () => this.emit("playerStop", player));
		player.on("playerDestroy", () => {
			this.emit("playerDestroy", player);
			this.players.delete(guildId);
			this.debug(`Player destroyed for guildId: ${guildId}`);
		});
		player.on("ttsStart", (payload) => this.emit("ttsStart", player, payload));
		player.on("ttsEnd", () => this.emit("ttsEnd", player));
		player.on("debug", (...args) => {
			if (this.listenerCount("debug") > 0) {
				this.emit("debug", ...args);
			}
		});
	}

	/**
	 * Get an existing player for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {Player | undefined} The player instance or undefined if not found
	 */
	get(guildOrId: string | { id: string }): Player | undefined {
		const guildId = this.resolveGuildId(guildOrId);
		const player = this.players.get(guildId);
		if (player) {
			(player as any)._lastActivity = Date.now();
		}
		return player;
	}

	/**
	 * Get an existing player for a guild (alias for get)
	 */
	getPlayer(guildOrId: string | { id: string }): Player | undefined {
		return this.get(guildOrId);
	}

	/**
	 * Get all players
	 *
	 * @returns {Player[]} All player instances
	 */
	getAll(): Player[] {
		return Array.from(this.players.values());
	}

	/**
	 * Alias for getAll
	 */
	getall(): Player[] {
		return this.getAll();
	}

	/**
	 * Get players by filter
	 *
	 * @param {(player: Player) => boolean} filter - Filter function
	 * @returns {Player[]} Filtered player instances
	 */
	getPlayersByFilter(filter: (player: Player) => boolean): Player[] {
		return this.getAll().filter(filter);
	}

	/**
	 * Get players in a voice channel
	 *
	 * @param {string} channelId - Voice channel ID
	 * @returns {Player[]} Players in the channel
	 */
	getPlayersInChannel(channelId: string): Player[] {
		return this.getAll().filter((p) => p.connection?.joinConfig.channelId === channelId);
	}

	/**
	 * Destroy a player and clean up resources
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {boolean} True if player was destroyed, false if not found
	 */
	delete(guildOrId: string | { id: string }): boolean {
		const guildId = this.resolveGuildId(guildOrId);
		const player = this.players.get(guildId);

		if (player) {
			this.debug(`Deleting player for guildId: ${guildId}`);
			player.destroy();
			return true;
		}
		return false;
	}

	/**
	 * Destroy multiple players by filter
	 *
	 * @param {(player: Player) => boolean} filter - Filter function
	 * @returns {number} Number of players destroyed
	 */
	deleteWhere(filter: (player: Player) => boolean): number {
		const toDelete = this.getPlayersByFilter(filter);
		let count = 0;

		for (const player of toDelete) {
			const guildId = player.guildId;
			player.destroy();
			this.players.delete(guildId);
			count++;
		}

		if (count > 0) {
			this.debug(`Deleted ${count} players by filter`);
		}
		return count;
	}

	/**
	 * Check if a player exists for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {boolean} True if player exists
	 */
	has(guildOrId: string | { id: string }): boolean {
		const guildId = this.resolveGuildId(guildOrId);
		return this.players.has(guildId);
	}

	/**
	 * Get number of players
	 */
	get size(): number {
		return this.players.size;
	}

	/**
	 * Check if debug is enabled
	 */
	get debugEnabled(): boolean {
		return this.B_debug;
	}

	/**
	 * Get manager statistics
	 *
	 * @returns {PlayerStats} Statistics about players
	 */
	getStats(): PlayerStats {
		let activePlayers = 0;
		let pausedPlayers = 0;
		let connectedPlayers = 0;
		let totalTracksInQueue = 0;

		for (const player of this.players.values()) {
			if (player.isPlaying) activePlayers++;
			if (player.isPaused) pausedPlayers++;
			if (player.connection) connectedPlayers++;
			totalTracksInQueue += player.queueSize;
		}

		return {
			totalPlayers: this.players.size,
			activePlayers,
			pausedPlayers,
			connectedPlayers,
			totalTracksInQueue,
		};
	}

	/**
	 * Broadcast an action to all players
	 *
	 * @param {string} action - Action to perform
	 * @param {...any[]} args - Arguments for the action
	 * @example
	 * manager.broadcast("setVolume", 50);
	 * manager.broadcast("pause");
	 */
	broadcast(action: string, ...args: any[]): void {
		for (const player of this.players.values()) {
			if (typeof (player as any)[action] === "function") {
				try {
					(player as any)[action](...args);
				} catch (error) {
					this.debug(`Error broadcasting ${action} to ${player.guildId}:`, error);
				}
			}
		}
	}

	/**
	 * Destroy all players and clean up
	 */
	destroy(): void {
		this.debug(`Destroying all players`);

		if (this.persistenceManager) {
			this.persistenceManager.saveAll().catch((err) => {
				this.debug("Failed to save players before destroy:", err);
			});
			this.persistenceManager.shutdown().catch(console.error);
		}
		// Stop cleanup intervals
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		if (this.statsInterval) {
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}

		// Destroy all players
		for (const player of this.players.values()) {
			player.destroy();
		}

		this.players.clear();
		this.searchCache.clear();
		this.removeAllListeners();
		this.debug(`PlayerManager destroyed`);
	}

	/**
	 * Search using registered plugins without creating a Player.
	 *
	 * @param {string} query - The query to search for
	 * @param {string} requestedBy - The user ID who requested the search
	 * @returns {Promise<SearchResult>} The search result
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.debug(`Search called with query: ${query}, requestedBy: ${requestedBy}`);

		// Check cache first
		const cached = this.getCachedSearch(query);
		if (cached) {
			return cached;
		}

		const plugin = this.plugins.find((p) => p.canHandle(query));
		if (!plugin) {
			this.debug(`No plugin found to handle: ${query}`);
			throw new Error(`No plugin found to handle: ${query}`);
		}

		try {
			const result = await this.withTimeout(plugin.search(query, requestedBy), "Search operation timed out");
			this.setCachedSearch(query, result);
			return result;
		} catch (error) {
			this.debug(`Search error:`, error);
			throw error as Error;
		}
	}

	/**
	 * Clear search cache
	 */
	clearSearchCache(): void {
		const size = this.searchCache.size;
		this.searchCache.clear();
		this.debug(`Cleared ${size} search cache entries`);
	}

	/**
	 * Register a plugin after initialization
	 *
	 * @param {SourcePlugin} plugin - Plugin to register
	 */
	registerPlugin(plugin: SourcePlugin): void {
		this.plugins.push(plugin);
		this.debug(`Registered plugin: ${plugin.name}`);

		// Register plugin with all existing players
		for (const player of this.players.values()) {
			player.addPlugin(plugin);
		}
	}

	/**
	 * Unregister a plugin
	 *
	 * @param {string} name - Plugin name to unregister
	 * @returns {boolean} True if plugin was unregistered
	 */
	unregisterPlugin(name: string): boolean {
		const index = this.plugins.findIndex((p) => p.name === name);
		if (index === -1) return false;

		this.plugins.splice(index, 1);
		this.debug(`Unregistered plugin: ${name}`);

		// Note: Cannot easily remove plugins from existing players
		return true;
	}

	/**
	 * Get all registered plugins
	 */
	getPlugins(): SourcePlugin[] {
		return [...this.plugins];
	}

	/**
	 * Register an extension after initialization
	 *
	 * @param {BaseExtension} extension - Extension to register
	 */
	registerExtension(extension: BaseExtension): void {
		this.extensions.push(extension);
		this.debug(`Registered extension: ${extension.name}`);

		// Register extension with all existing players
		for (const player of this.players.values()) {
			player.attachExtension(extension);
		}
	}

	/**
	 * Get manager configuration
	 */
	getConfig(): object {
		return {
			extractorTimeout: this.extractorTimeout,
			autoCleanup: this.autoCleanup,
			cleanupTimeout: this.cleanupTimeout,
			enableSearchCache: this.enableSearchCache,
			pluginsCount: this.plugins.length,
			extensionsCount: this.extensions.length,
			playersCount: this.players.size,
		};
	}
	private initPersistence(persistenceOptions: PersistenceOptions): void {
		this.persistenceManager = new PersistenceManager(this, persistenceOptions);

		// Forward persistence events
		this.persistenceManager.on("playerSaved", (guildId) => {
			this.emit("playerSaved", guildId);
		});

		this.persistenceManager.on("playerLoaded", (guildId, data) => {
			this.emit("playerLoaded", guildId, data);
		});

		this.persistenceManager.on("savedAll", (results) => {
			this.emit("savedAll", results);
		});

		this.persistenceManager.on("loadedAll", (results) => {
			this.emit("loadedAll", results);
		});

		this.debug("Persistence manager initialized");
	}

	/**
	 * Get persistence manager
	 */
	getPersistence(): PersistenceManager | undefined {
		return this.persistenceManager;
	}

	/**
	 * Save all players
	 */
	async saveAllPlayers(): Promise<Map<string, boolean>> {
		if (!this.persistenceManager) {
			throw new Error("Persistence not enabled");
		}
		return await this.persistenceManager.saveAll();
	}

	/**
	 * Load all players
	 */
	async loadAllPlayers(restorePosition: boolean = true): Promise<Map<string, boolean>> {
		if (!this.persistenceManager) {
			throw new Error("Persistence not enabled");
		}
		return await this.persistenceManager.loadAll(restorePosition);
	}

	/**
	 * Save a specific player
	 */
	async savePlayer(guildId: string): Promise<boolean> {
		if (!this.persistenceManager) return false;
		const player = this.get(guildId);
		if (!player) return false;
		return await this.persistenceManager.savePlayer(player);
	}
}

/**
 * Get the global PlayerManager instance
 *
 * @returns {PlayerManager | null} Global instance or null
 */
export function getInstance(): PlayerManager | null {
	const globalInst = getGlobalManager();
	if (!globalInst) {
		console.error("[PlayerManager] Global instance not found, make sure to initialize with new PlayerManager(options)");
		return null;
	}
	return globalInst;
}
