import { EventEmitter } from "events";
import { LRUCache } from "lru-cache";
import { Player } from "./Player";
import { Bus } from "./Bus";
import {
	PlaybackMode,
	PlayerManagerOptions,
	PlayerOptions,
	type Track,
	SourcePlugin,
	SearchResult,
	ManagerEvents,
	PlayerStats,
	type PlaybackMirrorOptions,
	type TrackMiddleware,
	type PlayerDebugLevel,
	normalizeTrackMiddleware,
	SharedControllerSet,
} from "../types";
import type { BaseExtension } from "../extensions";
import { withTimeout } from "../utils/timeout";
import { PlayerEventDebug } from "../controller/PlayerEventDebug";
import { BusLatencyTrace } from "../controller/BusLatencyTrace";
import { TrackLoader } from "./TrackLoader";
import { TrackResolver } from "./TrackResolver";
import { PlaybackController } from "../controller/PlaybackController";
import { StreamController } from "../controller/StreamController";
import { FilterController } from "../controller/FilterController";
import { QueueController } from "../controller/QueueController";
import { AntiStuckController } from "../controller/AntiStuckController";
import { TransitionController } from "../controller/TransitionController";
import { VolumeController } from "../controller/VolumeController";
import { PreloadController } from "../controller/PreloadController";
import { ConnectionController } from "../controller/ConnectionController";
import { LifecycleController } from "../controller/LifecycleController";
import { ForwardController } from "../controller/ForwardController";
import { TTSController } from "../controller/TTSController";
import { PlayerEventBridge } from "../controller/PlayerEventBridge";
import { ResourceRefreshController } from "../controller/ResourceRefreshController";
import { PluginController } from "../controller/PluginController";
import { ExtensionController } from "../controller/ExtensionController";
import { SearchController } from "../controller/SearchController";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { PlaybackOrchestrator } from "./PlaybackOrchestrator";
import { SaveController } from "../controller/SaveController";
import { PlaybackSessionController } from "../controller/PlaybackSessionController";
import { BUS_EVENT, CONTROLLER_RPC, PLAYER_RPC } from "./BusContract";
import { createAudioPlayer, NoSubscriberBehavior } from "@discordjs/voice";

export function createSharedControllers(params: {
	options?: PlayerManagerOptions;
	debugSink?: (...args: any[]) => void;
	bus?: Bus;
	busLatencyTrace?: BusLatencyTrace;
}): SharedControllerSet {
	const bus = params.bus ?? new Bus(params.busLatencyTrace);
	const sessionController = new PlaybackSessionController(bus);
	const preloadManager = new PreloadManager(bus);
	const trackLoader = new TrackLoader(bus, preloadManager);
	const preloadController = new PreloadController(bus, { loader: trackLoader, manager: preloadManager });
	const playbackController = new PlaybackController(bus);
	const connectionController = new ConnectionController(bus);
	const trackResolver = new TrackResolver(bus);
	const orchestrator = new PlaybackOrchestrator(bus, { sessionController });

	return {
		bus,
		connection: connectionController,
		playback: playbackController,
		preload: preloadController,
		preloadManager,
		trackLoader,
		trackResolver,
		orchestrator,

		queue: new QueueController(bus),
		volume: new VolumeController(bus),
		filter: new FilterController(bus),
		transition: new TransitionController(bus),
		antiStuck: new AntiStuckController(bus),
		stream: new StreamController(bus),
		save: new SaveController(bus),
		lifecycle: new LifecycleController(bus),
		tts: new TTSController(bus),
		search: new SearchController(bus),
		forward: new ForwardController(bus),
		resourceRefresh: new ResourceRefreshController(bus),
		eventBridge: new PlayerEventBridge(bus),
		plugin: new PluginController(bus),
		extension: new ExtensionController(bus),
		session: sessionController,
	};
}

const GLOBAL_MANAGER_KEY: symbol = Symbol.for("ziplayer.PlayerManager.instance");
/** Guild id for the internal search-only player (never stored in {@link PlayerManager.players}). */
const SEARCH_PLAYER_GUILD_ID = "__ziplayer_search__";

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
	private _debugLevel: PlayerDebugLevel = "info";
	/**
	 * Manager-wide PRIORITY hub. Every `this.debug(...)` call in this class routes through
	 * it, and each per-guild {@link Player} owns its own tracer seeded from this level.
	 */
	private readonly debugTracer = new PlayerEventDebug(
		undefined,
		"manager",
		(message, ...args) => {
			if (this.listenerCount("debug") > 0) {
				this.emit("debug", message, ...args);
				this.B_debug = true;
			}
		},
		"info",
	);
	/** Read-only access to the manager-level debug hub, e.g. for custom log sinks. */
	public get debugTracerInstance(): PlayerEventDebug {
		return this.debugTracer;
	}
	public get debugLevel(): PlayerDebugLevel {
		return this._debugLevel;
	}
	public set debugLevel(level: PlayerDebugLevel) {
		this._debugLevel = level;
		this.debugTracer.setDebugLevel(level);
	}
	private static instance: PlayerManager | null = null;
	private players: Map<string, Player> = new Map();
	public readonly bus: Bus;
	private readonly controllers: SharedControllerSet;
	private readonly perPlayerResources = new Map<
		string,
		{ streamManager: StreamManager; pluginManager: PluginManager; extensionManager: ExtensionManager }
	>();
	private disposed = false;
	private pendingPlayers: Map<string, Promise<Player>> = new Map();
	/** Teardowns still running; {@link dispose} waits for them before the Bus goes away. */
	private readonly pendingTeardowns = new Set<Promise<void>>();
	private searchCache: Map<string, ManagerCacheEntry<SearchResult>>;

	public get sharedControllers(): SharedControllerSet {
		return this.controllers;
	}

	private readonly debugSink = (message?: any, ...optionalParams: any[]): void => {
		if (this.listenerCount("debug") > 0 || this.debugEnabled) {
			this.emit("debug", message, ...optionalParams);
		}
	};

	private createPlayerBus(_playerId: string): Bus {
		return this.bus;
	}

	/**
	 * Shared LRU cache available to all registered plugins.
	 *
	 * Plugins should namespace their keys to avoid collisions, e.g.
	 * `youtube:video:${videoId}`.
	 *
	 * The cache only owns entries and evicts the least recently used ones
	 * when the maximum size is reached. Plugins remain responsible for
	 * choosing their key format and value types.
	 */
	public readonly cache = new LRUCache<string, object>({
		max: 500,
	});
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
	/** Reused player for {@link search}; not registered in {@link players}. */
	private searchPlayer: Player | null = null;
	private extensions: any[];
	private B_debug: boolean = false;
	private extractorTimeout: number = 10000;
	private autoCleanup: boolean = true;
	private cleanupTimeout: number = 60000; // 1 minute
	private enableSearchCache: boolean = true;
	private trackMiddlewareFromOptions: TrackMiddleware[] = [];

	private debug(message?: any, ...optionalParams: any[]): void {
		this.debugTracer.log("debug", "PlayerManager", message, ...optionalParams);
	}

	constructor(options: PlayerManagerOptions = {}) {
		super();
		this.controllers = createSharedControllers({
			options,
			debugSink: this.debugSink,
			busLatencyTrace: this.debugTracer.latencyTraceInstance,
		});
		this.bus = this.controllers.bus;
		this.plugins = [];
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
		this.debugLevel = options.debugLevel ?? "info";
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

	/**
	 * Lazy internal player used only for {@link search}.
	 * Not added to {@link players} and does not forward manager events.
	 */
	private assertNotDisposed(): void {
		if (this.disposed) throw new Error("PlayerManager is disposed");
	}

	private getSearchPlayer(): Player {
		if (this.searchPlayer && !this.searchPlayer.destroyed) {
			return this.searchPlayer;
		}
		this.assertNotDisposed();

		this.attachPlayerControllers(SEARCH_PLAYER_GUILD_ID, { extractorTimeout: this.extractorTimeout });
		const player = new Player(SEARCH_PLAYER_GUILD_ID, this.bus, { extractorTimeout: this.extractorTimeout }, this);
		this.perPlayerResources.get(SEARCH_PLAYER_GUILD_ID)?.extensionManager.attachPlayer(player);
		this.controllers.eventBridge?.attachPlayer(SEARCH_PLAYER_GUILD_ID, player);
		for (const plugin of this.plugins) {
			player.addPlugin(plugin);
		}

		this.searchPlayer = player;
		this.debug(`Created internal search player (not stored in players map)`);
		return player;
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
		for (const [guildId, player] of this.players) {
			// Clean up players that are not playing and not connected
			if (!player.isPlaying && !player.connection && player.queueSize === 0) {
				const idleTime = Date.now() - ((player as any)._lastActivity || Date.now());
				if (idleTime > this.cleanupTimeout) {
					this.debug(`Cleaning up inactive player for guild: ${guildId}`);

					// Always go through destroy() so the shared controllers detach too.
					void this.destroy(guildId).catch((error) => {
						this.debug(`Failed to cleanup inactive player ${guildId}:`, error);
					});
				}
			}
		}
	}

	private attachPlayerControllers(playerId: string, options?: PlayerOptions): void {
		const channel = (tag: string, level: PlayerDebugLevel = "debug") => this.debugTracer.channel(tag, level);
		const middleware: TrackMiddleware[] = [
			...this.getTrackMiddlewareChain(),
			...(Array.isArray(options?.trackMiddleware) ? options?.trackMiddleware
			: options?.trackMiddleware ? [options?.trackMiddleware]
			: []),
		];
		const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 100 } });
		this.controllers.connection.attach(playerId, {
			audioPlayer,
			options: options ?? {},
			debug: channel("ConnectionController"),
		});
		this.controllers.playback.attach(playerId, {
			audioPlayer,
			stuckTimeoutMs: options?.antiStuck?.stuckTimeoutMs,
		});
		this.controllers.preload.attach(playerId);

		const streamManager = new StreamManager({
			maxConcurrentStreams: options?.maxStreamStore ?? 4,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		streamManager.on("debug", channel("StreamManager"));
		const pluginManager = new PluginManager(null, this, {
			extractorTimeout: options?.extractorTimeout,
			debug: channel("Plugins"),
		});
		pluginManager.setStreamManager(streamManager);
		const extensionManager = new ExtensionManager(null as any, this, channel("Extensions"));
		this.controllers.preloadManager.attach(playerId, {
			streamManager,
			debug: channel("Preload"),
			isDestroyed: () => this.disposed || !this.perPlayerResources.has(playerId),
			isEnabled: () =>
				options?.lowPerformance && options?.preload?.autoDisableInLowPerformance ? false : (options?.preload?.enabled ?? true),
		});
		this.controllers.orchestrator.attach(playerId, { debug: channel("PlaybackOrchestrator") });
		this.controllers.trackLoader.attach(playerId, {
			middleware,
			context: { playerId, manager: this } as any,
			resolvers: [
				(track, session) => this.bus.requestRpc(playerId, PLAYER_RPC.streamResolve, { track }, { signal: session.signal }),
			],
			debug: channel("TrackLoader"),
		});
		this.controllers.trackResolver.attach(playerId, {
			streamManager,
			pluginManager,
			extensionManager,
			isDestroyed: () => this.disposed || !this.perPlayerResources.has(playerId),
		});

		this.controllers.lifecycle?.attach(playerId, options ?? {}, channel("LifecycleController"));
		this.controllers.forward?.attach(playerId);
		this.controllers.plugin?.attach(playerId, pluginManager);
		this.controllers.extension?.attach(playerId, extensionManager);
		this.controllers.tts?.attach(playerId, {
			pluginManager,
			extensionManager,
			audioPlayer,
			debug: channel("TTSController"),
			maxTimeTts: options?.tts?.maxTimeTts,
			volume: options?.tts?.volume ?? options?.volume ?? 100,
		});
		this.controllers.queue?.attach(playerId);
		this.controllers.transition?.attach(playerId, {
			enabled:
				options?.lowPerformance && options?.crossfade?.autoDisableInLowPerformance ?
					false
				:	(options?.crossfade?.enabled ?? options?.crossfade?.autoEnable ?? true),
			durationMs: options?.crossfade?.durationMs,
			smartEnabled: options?.smartTransition?.enabled ?? true,
			genreAware: options?.smartTransition?.genreAware ?? true,
			beatAlign: options?.smartTransition?.beatAlign ?? true,
			baseDurationMs: options?.smartTransition?.baseDurationMs ?? options?.crossfade?.durationMs,
			minDurationMs: options?.smartTransition?.minDurationMs,
			maxDurationMs: options?.smartTransition?.maxDurationMs,
			beatAlignMaxWaitMs: options?.smartTransition?.beatAlignMaxWaitMs,
			genreDurations: options?.smartTransition?.genreDurations,
		});
		this.controllers.volume?.attach(playerId, {
			initialVolume: options?.volume ?? 100,
			loudness: options?.loudnessNormalization,
		});
		this.controllers.antiStuck?.attach(playerId, { ...options?.antiStuck });
		this.controllers.stream?.attach(playerId, streamManager);
		this.controllers.save?.attach(playerId, {
			middleware: [async (track) => this.controllers.trackLoader.applyMiddleware(playerId, track)],
			middlewareContext: { playerId, manager: this } as any,
			resolveStream: (track) => pluginManager.getStream(track),
			resolveVideoStream: (track) => pluginManager.getVideo(track),
			debug: channel("SaveController"),
		});
		this.controllers.filter?.attach(playerId, undefined, channel("FilterController"), {
			initialFilters: Array.isArray(options?.filters) ? options?.filters : [],
			onFilterApplied: (filter) => this.bus.event(playerId, { type: BUS_EVENT.filterApplied, filter }),
			onFilterRemoved: (filter) => this.bus.event(playerId, { type: BUS_EVENT.filterRemoved, filter }),
			onFiltersCleared: () => this.bus.event(playerId, { type: BUS_EVENT.filtersCleared }),
			onProcessingError: (error) => {
				void this.bus.requestRpc(playerId, CONTROLLER_RPC.playbackReportFilterError, { error }).catch(() => undefined);
			},
		});
		this.controllers.session?.attach(playerId);
		this.controllers.resourceRefresh?.attach(playerId);
		this.controllers.search?.attach(playerId, {
			extensionManager,
			pluginManager,
			debug: channel("SearchController"),
		});
		this.controllers.eventBridge?.attach(playerId, this.debugTracer);

		this.perPlayerResources.set(playerId, { streamManager, pluginManager, extensionManager });
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
		this.assertNotDisposed();

		if (guildId === SEARCH_PLAYER_GUILD_ID) {
			throw new Error(`Guild id "${SEARCH_PLAYER_GUILD_ID}" is reserved for internal search.`);
		}

		if (this.players.has(guildId)) {
			this.debug(`Player already exists for guildId: ${guildId}, returning existing`);
			return this.players.get(guildId)!;
		}

		// Check if a player is already being created for this guild
		if (this.pendingPlayers.has(guildId)) {
			this.debug(`Player creation already in progress for guildId: ${guildId}, awaiting...`);
			return this.pendingPlayers.get(guildId)!;
		}

		const creationPromise = (async () => {
			await Promise.resolve();
			// What has been attached so far, so a failed or aborted creation can release exactly that.
			let controllersAttached = false;
			let created: Player | null = null;
			try {
				this.assertNotDisposed();
				this.debug(`Creating player for guildId: ${guildId}`);
				const playerId = guildId;
				const bus = this.createPlayerBus(playerId);

				controllersAttached = true;
				this.attachPlayerControllers(playerId, options);

				const player = new Player(playerId, bus, options, this);
				created = player;
				this.perPlayerResources.get(playerId)?.extensionManager.attachPlayer(player);
				this.controllers.eventBridge?.attachPlayer(playerId, player);

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
					// Extension activation awaits: dispose() may have started in the meantime.
					this.assertNotDisposed();
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

				// Last check before the player becomes visible: from here on dispose() sees it and tears it down.
				this.assertNotDisposed();

				// Forward all player events to manager
				this.setupEventForwarding(player, guildId);

				// Mark last activity
				(player as any)._lastActivity = Date.now();

				this.players.set(guildId, player);
				this.debug(`Player created for guildId: ${guildId}`);
				return player;
			} catch (error) {
				// Not registered in `players`, so nobody else will release what was attached.
				if (controllersAttached) {
					await this.runTeardown(guildId, created).catch((err) =>
						this.debug(`Error rolling back player creation for ${guildId}:`, err),
					);
				}
				throw error;
			} finally {
				this.pendingPlayers.delete(guildId);
			}
		})();

		this.pendingPlayers.set(guildId, creationPromise);
		return creationPromise;
	}

	private setupEventForwarding(player: Player, guildId: string): void {
		const originalEmit = player.emit.bind(player);

		player.emit = ((event: string | symbol, ...args: any[]) => {
			const result = originalEmit(event, ...args);

			if (typeof event === "string" && this.listenerCount(event as keyof ManagerEvents) > 0) {
				if (event === "debug") {
					(this.emit as any)(event, ...args);
				} else {
					(this.emit as any)(event, player, ...args);
				}
			}

			return result;
		}) as Player["emit"];

		player.on("playerDestroy", () => {
			// Forward links are released in teardownPlayer() (they need the controllers still attached).
			// Safety net: a no-op when the manager already tore this player down.
			void this.destroy(guildId).catch(() => undefined);
			this.debug(`Player destroyed for guildId: ${guildId}`);
		});

		player.on("trackStart", () => {
			player._lastActivity = Date.now();
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
			void this.destroy(guildId).catch((error) => this.debug(`Error destroying player ${guildId}:`, error));
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
			const playerId = player.playerId;
			void this.destroy(playerId).catch((error) => this.debug(`Error destroying player ${playerId}:`, error));
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
		let forwardHealthStatus = [];
		let leader = 0;
		let follower = 0;

		for (const player of this.players.values()) {
			if (player.isPlaying) activePlayers++;
			if (player.isPaused) pausedPlayers++;
			if (player.connection) connectedPlayers++;
			totalTracksInQueue += player.queueSize;
			const forwardStatus = player.getForwardHealthStatus();
			if (forwardStatus.role === "leader") leader++;
			if (forwardStatus.role === "follower") follower++;

			forwardHealthStatus.push(forwardStatus);
		}

		return {
			totalPlayers: this.players.size,
			leader,
			follower,
			activePlayers,
			pausedPlayers,
			connectedPlayers,
			totalTracksInQueue,
			forwardHealthStatus,
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
					this.debug(`Error broadcasting ${action} to ${player.playerId}:`, error);
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
			if (!wanted.has(player.playerId)) continue;
			if (typeof (player as any)[action] === "function") {
				try {
					(player as any)[action](...args);
				} catch (error) {
					this.debug(`Error broadcasting ${action} to ${player.playerId}:`, error);
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
		if (!leader.connection) {
			throw new Error(`Leader player ${options.leaderGuildId} is not connected to a voice channel`);
		}
		const followers = [...new Set(options.followerGuildIds)].filter((id) => id !== options.leaderGuildId);

		for (const gid of followers) {
			const fp = this.get(gid);

			if (!fp) {
				this.debug(`Playback mirror: no player for follower guild ${gid}`);
				continue;
			}

			if (!fp.connection) {
				this.debug(`Playback mirror: follower ${gid} not connected to voice channel`);
				continue;
			}

			fp.subscribeTo(leader, {
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
	 * Destroy a specific player or all players / manager when called without arguments.
	 */
	public async destroy(playerId?: string): Promise<void> {
		if (!playerId) {
			return this.dispose();
		}
		const player = this.players.get(playerId);

		if (!player) {
			// create() still running: let it finish, then destroy what it produced.
			const creating = this.pendingPlayers.get(playerId);
			if (!creating) return;
			const createdPlayer = await creating.catch(() => null);
			return createdPlayer ? this.destroy(playerId) : undefined;
		}

		this.players.delete(playerId);
		return this.runTeardown(playerId, player);
	}

	/** Starts {@link teardownPlayer} and tracks it until it settles. */
	private runTeardown(playerId: string, player: Player | null): Promise<void> {
		const teardown = this.teardownPlayer(playerId, player);
		this.pendingTeardowns.add(teardown);
		void teardown.finally(() => this.pendingTeardowns.delete(teardown)).catch(() => undefined);
		return teardown;
	}

	/**
	 * Called by {@link Player.destroy}: takes over the teardown so it always runs in the manager's
	 * order. Returns false when this manager does not track `player` (nothing was started).
	 *
	 * @internal
	 */
	public requestDestroy(player: Player): boolean {
		if (this.players.get(player.playerId) !== player) return false;
		void this.destroy(player.playerId).catch((error) => this.debug(`Error destroying player ${player.playerId}:`, error));
		return true;
	}

	/**
	 * The one teardown path for a player (destroy, delete, cleanup, dispose, search player):
	 *
	 *   1. release forward links   (needs the forward/connection controllers still attached)
	 *   2. Player.abortWorkflow()  (pending play()/actions)
	 *   3. release per-player resources (stream/plugin/extension managers)
	 *   4. detach shared controllers (orchestrator + lifecycle first, connection last)
	 *   5. Player.completeDestroy() -> bus "destroyed" + Bus.disposePlayer(playerId)
	 *
	 * Steps 1-3 and the start of 4 run synchronously, so `players.has()` / `player.destroyed` are
	 * already up to date when the caller gets the promise back.
	 */
	private async teardownPlayer(playerId: string, player: Player | null): Promise<void> {
		try {
			// `player` is null only when creation failed before the Player existed.
			if (player) {
				this.releaseForwardLinks(playerId, player);
				player.abortWorkflow();

				for (const ext of this.extensions) {
					if (ext && typeof ext === "object" && ext.player === player) {
						ext.player = null;
					}
				}
			}

			const res = this.perPlayerResources.get(playerId);
			if (res) {
				this.perPlayerResources.delete(playerId);
				res.streamManager.dispose();
				res.pluginManager.destroy();
				res.extensionManager.destroy();
			}

			await this.detachControllers(playerId);
		} finally {
			// Bus disposal is last, and must happen even if a detach failed.
			try {
				player?.completeDestroy();
			} catch (error) {
				this.debug(`Error destroying player ${playerId}:`, error);
			}
			// Observes the final "destroyed" event, so it goes after completeDestroy().
			try {
				this.controllers.eventBridge?.detach(playerId);
			} catch (error) {
				this.debug(`Error detaching eventBridge for ${playerId}:`, error);
			}
		}
	}

	/**
	 * Detaches every shared controller from `playerId`. Order matters now that the bus is disposed
	 * afterwards: the workers that react to bus events (orchestrator: TRACK_END/queueChanged,
	 * lifecycle: queueChanged/...) go first so nothing reacts to the state being released below;
	 * connection goes last (forward/TTS release their audio player through it).
	 *
	 * Synchronous detaches run back-to-back in one tick; only the async ones (orchestrator,
	 * connection) are awaited. A failing detach is logged and never skips the rest.
	 */
	private async detachControllers(playerId: string): Promise<void> {
		const c = this.controllers;
		const pending: Promise<void>[] = [];
		const run = (name: string, detach: (() => void | Promise<void>) | undefined): void => {
			if (!detach) return;
			try {
				const result = detach();
				if (result && typeof (result as Promise<void>).then === "function") {
					pending.push((result as Promise<void>).catch((error) => this.debug(`Error detaching ${name} for ${playerId}:`, error)));
				}
			} catch (error) {
				this.debug(`Error detaching ${name} for ${playerId}:`, error);
			}
		};

		run("orchestrator", () => c.orchestrator.detach(playerId));
		run("lifecycle", c.lifecycle && (() => c.lifecycle!.detach(playerId)));

		run("preload", () => c.preload.detach(playerId));
		run("preloadManager", () => c.preloadManager.detach(playerId));
		run("playback", () => c.playback.detach(playerId));
		run("trackLoader", () => c.trackLoader.detach(playerId));
		run("trackResolver", () => c.trackResolver.detach(playerId));

		run("queue", c.queue && (() => c.queue!.detach(playerId)));
		run("volume", c.volume && (() => c.volume!.detach(playerId)));
		run("filter", c.filter && (() => c.filter!.detach(playerId)));
		run("transition", c.transition && (() => c.transition!.detach(playerId)));
		run("antiStuck", c.antiStuck && (() => c.antiStuck!.detach(playerId)));
		run("stream", c.stream && (() => c.stream!.detach(playerId)));
		run("save", c.save && (() => c.save!.detach(playerId)));
		run("tts", c.tts && (() => c.tts!.detach(playerId)));
		run("search", c.search && (() => c.search!.detach(playerId)));
		run("forward", c.forward && (() => c.forward!.detach(playerId)));
		run("resourceRefresh", c.resourceRefresh && (() => c.resourceRefresh!.detach(playerId)));
		run("session", c.session && (() => c.session!.detach(playerId)));
		run("plugin", c.plugin && (() => c.plugin!.detach(playerId)));
		run("extension", c.extension && (() => c.extension!.detach(playerId)));

		run("connection", () => c.connection.detach(playerId));

		await Promise.all(pending);
	}

	/**
	 * Unlinks `player` from its forward leader/followers. Runs before any controller detaches:
	 * it talks to the forward and connection controllers of this and of the other players.
	 */
	private releaseForwardLinks(playerId: string, player: Player): void {
		try {
			const followers = [...player.forwardFollowers];
			if (followers.length > 0) {
				this.debug(`Leader ${playerId} destroyed, cleaning up ${followers.length} followers`);
				for (const follower of followers) {
					try {
						if (typeof follower === "string") {
							this.get(follower)?.unsubscribeForward("Leader destroyed");
						} else if (follower && typeof follower.unsubscribeForward === "function") {
							follower.unsubscribeForward("Leader destroyed");
						}
					} catch (err) {
						this.debug(`Failed to unsubscribe follower:`, err);
					}
				}
			}

			// If this player is a follower, unsubscribe from its leader
			if (player.playbackMode === PlaybackMode.FORWARD && player.forwardLeader) {
				this.debug(`Follower ${playerId} destroyed, unsubscribing from leader`);
				player.unsubscribeForward("Follower destroyed");
			}
		} catch (err) {
			this.debug(`Failed to release forward links for ${playerId}:`, err);
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		// Stop cleanup intervals
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		if (this.statsInterval) {
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}

		for (const ext of this.extensions) {
			if (ext && typeof ext === "object" && "player" in ext) {
				ext.player = null;
			}
		}

		// A create() still running sees `disposed`, rolls back what it attached and rejects. Wait for
		// it so no controller state is attached after the players below have been torn down.
		await Promise.allSettled([...this.pendingPlayers.values()]);

		const playerEntries = [...this.players.entries()];
		this.players.clear();

		const searchPlayer = this.searchPlayer;
		this.searchPlayer = null;
		if (searchPlayer && !searchPlayer.destroyed) playerEntries.push([SEARCH_PLAYER_GUILD_ID, searchPlayer]);

		for (const [playerId, player] of playerEntries) {
			this.runTeardown(playerId, player).catch((err) => this.debug(`Error destroying player ${playerId}:`, err));
		}
		// Includes teardowns started earlier by destroy(playerId)/player.destroy(): none may still be
		// running when the shared controllers and the Bus are disposed below.
		await Promise.allSettled([...this.pendingTeardowns]);

		this.searchCache.clear();
		this.cache.clear();

		await this.disposeSharedControllers();
		this.bus.dispose();

		this.removeAllListeners();
		this.debug(`PlayerManager disposed`);
	}

	/**
	 * Disposes the shared controllers one after another, awaiting the async ones (orchestrator,
	 * connection) so nothing is still cleaning up when the Bus is disposed. A failing dispose is
	 * logged and never keeps the Bus (or the remaining controllers) from being disposed.
	 */
	private async disposeSharedControllers(): Promise<void> {
		const c = this.controllers;
		const steps: Array<[string, () => void | Promise<void>]> = [
			["orchestrator", () => c.orchestrator.dispose()],
			["preload", () => c.preload.dispose()],
			["preloadManager", () => c.preloadManager.dispose()],
			["playback", () => c.playback.dispose()],
			["connection", () => c.connection.dispose()],
			["trackLoader", () => c.trackLoader.dispose()],
			["trackResolver", () => c.trackResolver.dispose()],
		];
		for (const [name, dispose] of steps) {
			try {
				await dispose();
			} catch (error) {
				this.debug(`Error disposing ${name} controller:`, error);
			}
		}
	}

	/**
	 * Search via an internal Player instance (all registered plugins) without
	 * storing it in {@link players}.
	 *
	 * Uses the same search pipeline as {@link Player.search}:
	 * extension hooks, plugin deduplication, scoring, and fallback handling.
	 *
	 * @param {string} query
	 * @param {string} requestedBy
	 * @returns {Promise<SearchResult>}
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.debug(`Search called with query: ${query}, requestedBy: ${requestedBy}`);

		const cached = this.getCachedSearch(query);
		if (cached) {
			return cached;
		}

		try {
			const result = await this.getSearchPlayer().search(query, requestedBy);

			this.debug(`Search returned ${result.tracks.length} tracks (score: ${result.score?.score ?? "unknown"}%)`);

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

		this.debug(`Registered plugin: ${plugin.name}`);

		if (this.searchPlayer && !this.searchPlayer.destroyed) {
			this.searchPlayer.addPlugin(plugin);
		}

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

		if (this.searchPlayer && !this.searchPlayer.destroyed) {
			this.searchPlayer.removePlugin(name);
		}

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
