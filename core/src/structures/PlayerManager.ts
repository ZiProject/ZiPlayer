import { EventEmitter } from "events";
import { Player } from "./Player";
import {
	PlayerManagerOptions,
	PlayerOptions,
	type Track,
	SourcePlugin,
	SearchResult,
	ManagerEvents,
	PlayerStats,
	type PlaybackMirrorOptions,
	type TrackMiddleware,
	normalizeTrackMiddleware,
} from "../types";
import type { BaseExtension } from "../extensions";
import { withTimeout } from "../utils/timeout";
import { PluginManager } from "../plugins";

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

	static async default(opt?: PlayerOptions): Promise<Player> {
		let globaldef = getGlobalManager();
		if (!globaldef) {
			globaldef = new PlayerManager({});
		}
		return await globaldef.create("default", opt);
	}

	private plugins: SourcePlugin[];
	private pluginManager: PluginManager;
	private extensions: any[];
	private B_debug: boolean = false;
	private extractorTimeout: number = 10000;
	private autoCleanup: boolean = true;
	private cleanupTimeout: number = 60000; // 1 minute
	private enableSearchCache: boolean = true;
	private trackMiddlewareFromOptions: TrackMiddleware[] = [];

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
		this.pluginManager = new PluginManager(null as any, this, {
			extractorTimeout: this.extractorTimeout,
		});
		this.searchCache = new Map();

		// Initialize plugins
		const provided = options.plugins || [];
		for (const p of provided as any[]) {
			try {
				let instance: SourcePlugin | null = null;

				if (p && typeof p === "object") {
					instance = p as SourcePlugin;
				} else if (typeof p === "function") {
					instance = new (p as any)();
				}

				if (instance) {
					this.plugins.push(instance);
					this.pluginManager.register(instance);
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
		this.trackMiddlewareFromOptions = normalizeTrackMiddleware(options.trackMiddleware);

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
		const forwardEvents = {
			willPlay: "willPlay",
			trackStart: "trackStart",
			trackEnd: "trackEnd",
			queueEnd: "queueEnd",
			playerError: "playerError",
			connectionError: "connectionError",
			volumeChange: "volumeChange",
			queueAdd: "queueAdd",
			queueAddList: "queueAddList",
			queueRemove: "queueRemove",
			playerPause: "playerPause",
			playerResume: "playerResume",
			playerStop: "playerStop",
			ttsStart: "ttsStart",
			ttsEnd: "ttsEnd",
			streamError: "streamError",
			forwardModeStart: "forwardModeStart",
			forwardModeEnd: "forwardModeEnd",
		} as const satisfies Record<string, keyof ManagerEvents>;

		for (const [sourceEvent, targetEvent] of Object.entries(forwardEvents) as [
			keyof typeof forwardEvents,
			keyof ManagerEvents,
		][]) {
			player.on(sourceEvent, (...args: any[]) => {
				if (sourceEvent === "trackStart") {
					player._lastActivity = Date.now();
				}

				(this.emit as any)(targetEvent, player, ...args);
			});
		}

		player.on("playerDestroy", () => {
			this.emit("playerDestroy", player);

			this.players.delete(guildId);

			this.debug(`Player destroyed for guildId: ${guildId}`);
		});

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
	 * Like {@link broadcast} but awaits every return value (for async methods such as `play`).
	 * Uses `Promise.allSettled` — failures are captured per guild, not thrown as a whole.
	 */
	async broadcastAsync(action: string, ...args: any[]): Promise<PromiseSettledResult<unknown>[]> {
		const pending: Promise<unknown>[] = [];
		for (const player of this.players.values()) {
			const fn = (player as any)[action];
			if (typeof fn !== "function") continue;
			try {
				pending.push(Promise.resolve(fn.apply(player, args)));
			} catch (error) {
				pending.push(Promise.reject(error));
			}
		}
		return Promise.allSettled(pending);
	}

	/**
	 * Broadcast a player method only to the given guild ids (players must already exist).
	 */
	broadcastGuilds(guildIds: readonly string[], action: string, ...args: any[]): void {
		const wanted = new Set(guildIds);
		for (const player of this.players.values()) {
			if (!wanted.has(player.guildId)) continue;
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
	 * Global {@link TrackMiddleware} configured on this manager (applied before per-player middleware).
	 */
	getTrackMiddlewareChain(): TrackMiddleware[] {
		return [...this.trackMiddlewareFromOptions];
	}

	/**
	 * Mirror playback from one leader guild to multiple follower guilds.
	 *
	 * Followers directly subscribe to the leader player's audio pipeline,
	 * allowing multiple guilds to hear the same audio stream with extremely
	 * low CPU and bandwidth usage.
	 *
	 * Unlike traditional mirroring, followers do not create independent streams.
	 * Instead, their voice connections subscribe directly to the leader player's
	 * {@link audioPlayer}.
	 *
	 * ## Features
	 * - Shared playback pipeline
	 * - Followers may join at different times
	 * - Real-time track synchronization
	 * - Optional volume synchronization
	 * - Automatic cleanup on destroy
	 * - Low CPU / bandwidth usage
	 *
	 * ## Lifecycle
	 * - Destroying the leader automatically unsubscribes all followers.
	 * - Destroying a follower only removes that follower.
	 * - Followers may manually unsubscribe using {@link Player.unsubscribeForward}.
	 *
	 * ## Requirements
	 * - All guilds must already have active players.
	 * - All players must already be connected to voice channels.
	 *
	 * @param {PlaybackMirrorOptions} options Playback mirror configuration.
	 *
	 * @returns {() => void} Cleanup function that unsubscribes all followers.
	 *
	 * @example
	 * const stopMirror = manager.subscribeForwardMirror({
	 *   leaderGuildId: "123",
	 *   followerGuildIds: ["456", "789"],
	 *   mirrorUserId: client.user.id,
	 *   syncVolume: true,
	 *   forwardMode: true,
	 * });
	 *
	 * // later
	 * stopMirror();
	 */
	subscribeForwardMirror(options: PlaybackMirrorOptions): () => void {
		const leader = this.get(options.leaderGuildId);

		if (!leader) {
			throw new Error(`subscribeForwardMirror: no player for leader guild ${options.leaderGuildId}`);
		}

		const followers = [...new Set(options.followerGuildIds)].filter((id) => id !== options.leaderGuildId);

		for (const gid of followers) {
			const fp = this.get(gid);

			if (!fp) {
				this.debug(`Playback mirror: no player for follower guild ${gid}`);
				continue;
			}

			fp.subscribeTo(leader, {
				syncVolume: options.syncVolume,
				forwardMode: options.forwardMode,
			});
		}

		return () => {
			for (const gid of followers) {
				const fp = this.get(gid);

				try {
					fp?.unsubscribeForward();
				} catch {}
			}
		};
	}

	/**
	 * Destroy all players and clean up
	 */
	destroy(): void {
		this.debug(`Destroying all players`);

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
	 * Search using PluginManager without creating a Player.
	 *
	 * Uses the same search pipeline as Player.search():
	 * - cache
	 * - plugin deduplication
	 * - plugin scoring/evaluation
	 * - fallback handling
	 *
	 * @param {string} query
	 * @param {string} requestedBy
	 * @returns {Promise<SearchResult>}
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.debug(`Search called with query: ${query}, requestedBy: ${requestedBy}`);

		// Cache
		const cached = this.getCachedSearch(query);
		if (cached) {
			return cached;
		}

		try {
			const result = await this.pluginManager.search(query, requestedBy);

			if (!result || !Array.isArray(result.tracks) || result.tracks.length === 0) {
				throw new Error(`No results found for: ${query}`);
			}

			this.debug(`Plugin search returned ${result.tracks.length} tracks (score: ${result.score?.score ?? "unknown"}%)`);

			if (result.score) {
				this.debug(`Search evaluation - ${result.score.reason}`);
			}

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
		this.pluginManager.register(plugin);

		this.debug(`Registered plugin: ${plugin.name}`);

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
		this.pluginManager.unregister(name);

		this.debug(`Unregistered plugin: ${name}`);

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
