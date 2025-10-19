import { EventEmitter } from "events";
import { Player } from "./Player";
import { PlayerManagerOptions, PlayerOptions, Track, SourcePlugin, SearchResult, ManagerEvents } from "../types";
import type { BaseExtension } from "../extensions";
import { withTimeout } from "../utils/timeout";

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
 *   extractorTimeout: 10000
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

	private debug(message?: any, ...optionalParams: any[]): void {
		if (this.listenerCount("debug") > 0) {
			this.emit("debug", message, ...optionalParams);
			if (!this.B_debug) {
				this.B_debug = true;
			}
		}
	}

	constructor(options: PlayerManagerOptions = {}) {
		super();
		this.plugins = [];
		const provided = options.plugins || [];
		for (const p of provided as any[]) {
			try {
				if (p && typeof p === "object") {
					this.plugins.push(p as SourcePlugin);
				} else if (typeof p === "function") {
					const instance = new (p as any)();
					this.plugins.push(instance as SourcePlugin);
				}
			} catch (e) {
				this.debug(`[PlayerManager] Failed to init plugin:`, e);
			}
		}
		this.extensions = options.extensions || [];

		setGlobalManager(this);
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

	/**
	 * Create a new player for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @param {PlayerOptions} options - Player configuration options
	 * @returns {Promise<Player>} The created player instance
	 *
	 * @example
	 * // Create player with basic options
	 * const player = await manager.create(guildId, {
	 *   tts: { interrupt: true, volume: 1 },
	 *   leaveOnEnd: true,
	 *   leaveTimeout: 30000
	 * });
	 *
	 * // Create player with advanced options
	 * const advancedPlayer = await manager.create(guild, {
	 *   volume: 0.8,
	 *   quality: "high",
	 *   selfDeaf: false,
	 *   selfMute: false,
	 *   tts: {
	 *     createPlayer: true,
	 *     interrupt: true,
	 *     volume: 1.0,
	 *     Max_Time_TTS: 30000
	 *   },
	 *   userdata: { customData: "example" }
	 * });
	 *
	 * // Connect and play immediately
	 * await player.connect(voiceChannel);
	 * await player.play("Never Gonna Give You Up", userId);
	 */

	async create(guildOrId: string | { id: string }, options?: PlayerOptions): Promise<Player> {
		const guildId = this.resolveGuildId(guildOrId);
		if (this.players.has(guildId)) {
			return this.players.get(guildId)!;
		}

		this.debug(`[PlayerManager] Creating player for guildId: ${guildId}`);
		const player = new Player(guildId, options, this);
		this.plugins.forEach((plugin) => player.addPlugin(plugin));

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
		}

		for (const ext of extsToActivate) {
			let instance = ext;
			if (typeof ext === "function") {
				try {
					instance = new ext(player);
				} catch (e) {
					this.debug(`[PlayerManager] Extension constructor error:`, e);
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
						this.debug(`[PlayerManager] Extension ${extInstance?.name} active`);
					} catch (e) {
						activated = false;
						this.debug(`[PlayerManager] Extension activation error:`, e);
					}
					if (activated === false) {
						player.detachExtension(extInstance);
						continue;
					}
				}
			}
		}

		// Forward all player events
		player.on("willPlay", (track, tracks) => this.emit("willPlay", player, track as Track, tracks as Track[]));
		player.on("trackStart", (track) => this.emit("trackStart", player, track as Track));
		player.on("trackEnd", (track) => this.emit("trackEnd", player, track as Track));
		player.on("queueEnd", () => this.emit("queueEnd", player));
		player.on("playerError", (error, track) => this.emit("playerError", player, error, track as Track));
		player.on("connectionError", (error) => this.emit("connectionError", player, error));
		player.on("volumeChange", (old, volume) => this.emit("volumeChange", player, old as number, volume as number));
		player.on("queueAdd", (track) => this.emit("queueAdd", player, track as Track));
		player.on("queueAddList", (tracks) => this.emit("queueAddList", player, tracks as Track[]));
		player.on("queueRemove", (track, index) => this.emit("queueRemove", player, track as Track, index));
		player.on("playerPause", (track) => this.emit("playerPause", player, track as Track));
		player.on("playerResume", (track) => this.emit("playerResume", player, track as Track));
		player.on("playerStop", () => this.emit("playerStop", player));
		player.on("playerDestroy", () => {
			this.emit("playerDestroy", player);
			this.players.delete(guildId);
		});
		player.on("ttsStart", (payload) => this.emit("ttsStart", player, payload));
		player.on("ttsEnd", () => this.emit("ttsEnd", player));
		player.on("debug", (...args) => {
			if (this.listenerCount("debug") > 0) {
				this.emit("debug", ...args);
			}
		});

		this.players.set(guildId, player);
		return player;
	}

	/**
	 * Get an existing player for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {Player | undefined} The player instance or undefined if not found
	 * @example
	 * // Get player by guild ID
	 * const player = manager.get(guildId);
	 * if (player) {
	 *   await player.play("Never Gonna Give You Up", userId);
	 * } else {
	 *   console.log("No player found for this guild");
	 * }
	 *
	 * // Get player by guild object
	 * const playerFromGuild = manager.get(guild);
	 * if (playerFromGuild) {
	 *   playerFromGuild.setVolume(0.5);
	 * }
	 *
	 * // Check if player exists before using
	 * const existingPlayer = manager.get(guildId);
	 * if (existingPlayer && existingPlayer.playing) {
	 *   existingPlayer.pause();
	 * }
	 */

	get(guildOrId: string | { id: string }): Player | undefined {
		const guildId = this.resolveGuildId(guildOrId);
		return this.players.get(guildId);
	}

	/**
	 * Get an existing player for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {Player | undefined} The player instance or undefined
	 * @example
	 * const player = manager.get(guildId);
	 * if (player) {
	 *   await player.play("song name", userId);
	 * }
	 */
	getPlayer(guildOrId: string | { id: string }): Player | undefined {
		const guildId = this.resolveGuildId(guildOrId);
		return this.players.get(guildId);
	}

	/**
	 * Get all players
	 *
	 * @returns {Player[]} All player instances
	 * @example
	 * const players = manager.getall();
	 * console.log(`Players: ${players.length}`);
	 */
	getall(): Player[] | [] {
		return Array.from(this.players.values());
	}

	/**
	 * Destroy a player and clean up resources
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {boolean} True if player was destroyed, false if not found
	 * @example
	 * // Destroy player by guild ID
	 * const destroyed = manager.delete(guildId);
	 * if (destroyed) {
	 *   console.log("Player destroyed successfully");
	 * } else {
	 *   console.log("No player found to destroy");
	 * }
	 *
	 * // Destroy player by guild object
	 * const destroyedFromGuild = manager.delete(guild);
	 * console.log(`Player destroyed: ${destroyedFromGuild}`);
	 *
	 * // Clean up all players
	 * for (const [guildId, player] of manager.players) {
	 *   const destroyed = manager.delete(guildId);
	 *   console.log(`Destroyed player for ${guildId}: ${destroyed}`);
	 * }
	 */
	delete(guildOrId: string | { id: string }): boolean {
		const guildId = this.resolveGuildId(guildOrId);
		const player = this.players.get(guildId);
		if (player) {
			this.debug(`[PlayerManager] Deleting player for guildId: ${guildId}`);
			player.destroy();
			return this.players.delete(guildId);
		}
		return false;
	}

	/**
	 * Check if a player exists for a guild
	 *
	 * @param {string | {id: string}} guildOrId - Guild ID or guild object
	 * @returns {boolean} True if player exists, false if not
	 * @example
	 * const exists = manager.has(guildId);
	 * console.log(`Player exists: ${exists}`);
	 */
	has(guildOrId: string | { id: string }): boolean {
		const guildId = this.resolveGuildId(guildOrId);
		return this.players.has(guildId);
	}

	get size(): number {
		return this.players.size;
	}

	get debugEnabled(): boolean {
		return this.B_debug;
	}
	/**
	 * Destroy all players
	 *
	 * @returns {void}
	 * @example
	 * manager.destroy();
	 * console.log(`All players destroyed`);
	 */
	destroy(): void {
		this.debug(`[PlayerManager] Destroying all players`);
		for (const player of this.players.values()) {
			player.destroy();
		}
		this.players.clear();
		this.removeAllListeners();
	}

	/**
	 * Search using registered plugins without creating a Player.
	 *
	 * @param {string} query - The query to search for
	 * @param {string} requestedBy - The user ID who requested the search
	 * @returns {Promise<SearchResult>} The search result
	 * @example
	 * const result = await manager.search("Never Gonna Give You Up", userId);
	 * console.log(`Search result: ${result.tracks.length} tracks`);
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.debug(`[PlayerManager] Search called with query: ${query}, requestedBy: ${requestedBy}`);
		const plugin = this.plugins.find((p) => p.canHandle(query));
		if (!plugin) {
			this.debug(`[PlayerManager] No plugin found to handle: ${query}`);
			throw new Error(`No plugin found to handle: ${query}`);
		}

		try {
			return await this.withTimeout(plugin.search(query, requestedBy), "Search operation timed out");
		} catch (error) {
			this.debug(`[PlayerManager] Search error:`, error);
			throw error as Error;
		}
	}
}

export function getInstance(): PlayerManager | null {
	const globalInst = getGlobalManager();
	if (!globalInst) {
		console.error("[PlayerManager] Global instance not found, make sure to initialize with new PlayerManager(options)");
		return null;
	}
	return globalInst;
}
