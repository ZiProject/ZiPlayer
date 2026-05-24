import { EventEmitter } from "events";
import {
	createAudioPlayer,
	createAudioResource,
	entersState,
	AudioPlayerStatus,
	VoiceConnection,
	AudioPlayer as DiscordAudioPlayer,
	VoiceConnectionStatus,
	NoSubscriberBehavior,
	joinVoiceChannel,
	AudioResource,
	StreamType,
} from "@discordjs/voice";

import { Readable } from "stream";
import { LRUCache } from "lru-cache";
import type { BaseExtension } from "../extensions";
import {
	PlaybackMode,
	normalizeTrackMiddleware,
	type Track,
	type PlayerOptions,
	type PlayerEvents,
	type SourcePlugin,
	type SearchResult,
	type ProgressBarOptions,
	type LoopMode,
	type StreamInfo,
	type SaveOptions,
	type VoiceChannel,
	type PlayerSession,
	type ExtensionPlayRequest,
	type ExtensionPlayResponse,
	type ExtensionAfterPlayPayload,
	type StreamSlot,
	type TrackMiddleware,
	ForwardHealthStatus,
} from "../types";
import type { PlayerManager } from "./PlayerManager";

import { Queue } from "./Queue";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { FilterManager } from "./FilterManager";
import { StreamManager } from "./StreamManager";
import { PreloadManager } from "./PreloadManager";

export declare interface Player {
	on<K extends keyof PlayerEvents>(event: K, listener: (...args: PlayerEvents[K]) => void): this;
	emit<K extends keyof PlayerEvents>(event: K, ...args: PlayerEvents[K]): boolean;
}

/**
 * Represents a music player for a specific Discord guild.
 *
 * @example
 * // Create and configure player
 * const player = await manager.create(guildId, {
 *   tts: { interrupt: true, volume: 1 },
 *   leaveOnEnd: true,
 *   leaveTimeout: 30000
 * });
 *
 * // Connect to voice channel
 * await player.connect(voiceChannel);
 *
 * // Play different types of content
 * await player.play("Never Gonna Give You Up", userId); // Search query
 * await player.play("https://youtube.com/watch?v=dQw4w9WgXcQ", userId); // Direct URL
 * await player.play("tts: Hello everyone!", userId); // Text-to-Speech
 *
 * // Player controls
 * player.pause(); // Pause current track
 * player.resume(); // Resume paused track
 * player.skip(); // Skip to next track
 * player.stop(); // Stop and clear queue
 * player.setVolume(0.5); // Set volume to 50%
 *
 * // Event handling
 * player.on("trackStart", (player, track) => {
 *   console.log(`Now playing: ${track.title}`);
 * });
 *
 * player.on("queueEnd", (player) => {
 *   console.log("Queue finished");
 * });
 *
 */
export class Player extends EventEmitter {
	public readonly guildId: string;
	public connection: VoiceConnection | null = null;
	public audioPlayer: DiscordAudioPlayer;
	public queue: Queue;
	public volume: number = 100;
	public options: PlayerOptions;
	public userdata?: Record<string, any>;
	public _lastActivity: number = Date.now();
	public _remotePaused = false;
	public currentResource: AudioResource | null = null;
	public destroyed: boolean = false;

	public manager: PlayerManager;
	public pluginManager: PluginManager;
	public extensionManager: ExtensionManager;
	public streamManager: StreamManager;
	public preloadManager: PreloadManager;
	public filter!: FilterManager;

	public playbackMode = PlaybackMode.NATIVE;

	public forwardFollowers = new Set<Player>();
	public forwardLeader: Player | null = null;

	private leaveTimeout: NodeJS.Timeout | null = null;
	private volumeInterval: NodeJS.Timeout | null = null;
	private stuckTimer: NodeJS.Timeout | null = null;

	private skipLoop = false;
	private refreshLock = false;
	private seekInProgress = false;
	private remoteHandle: StreamInfo["handle"];

	private currentSlot: StreamSlot = {
		resource: null,
		track: null,
		streamId: null,
		abortController: null,
		isValid: false,
		isLoading: false,
		loadPromise: null,
	};

	private preloadEnabled = true;
	private crossfadeEnabled = true;
	private crossfadeDurationMs = 500;
	private lowPerformanceMode = false;
	private crossfadeTransitionLock = false;
	private smartTransitionEnabled = true;
	private smartTransitionGenreAware = true;
	private smartTransitionBeatAlign = true;
	private smartTransitionBaseMs = 800;
	private smartTransitionMinMs = 120;
	private smartTransitionMaxMs = 8000;
	private smartTransitionGenreDurations: Record<string, number> = {
		chill: 700,
		ambient: 750,
		lofi: 650,
		pop: 450,
		rock: 350,
		edm: 220,
		house: 250,
		techno: 200,
	};
	private smartTransitionBeatAlignMaxWaitMs = 180;
	private antiStuckEnabled = true;
	private antiStuckMaxRetries = 2;
	private antiStuckRetryDelayMs = 900;
	private antiStuckReusePreloadFirst = true;
	private antiStuckReduceQualityOnRetry = true;
	private antiStuckControlledSkipThreshold = 3;
	private antiStuckConsecutiveFailures = 0;
	private loudnessNormalizationEnabled = false;
	private loudnessTargetLUFS = -14;
	private loudnessMaxBoostDb = 8;
	private loudnessMaxCutDb = 10;
	private loudnessLimiterCeiling = 0.95;
	private readonly trackMiddlewareChain: TrackMiddleware[];

	// Cache for search results to avoid duplicate calls
	private searchCache: LRUCache<string, SearchResult>;
	private readonly SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
	private ttsPlayer: DiscordAudioPlayer | null = null;
	private lastDuration: number = 0;
	private seekOffset: number = 0;

	constructor(guildId: string, options: PlayerOptions = {}, manager: PlayerManager) {
		super();
		this.debug(`[Player] Constructor called for guildId: ${guildId}`);
		this.guildId = guildId;
		this.queue = new Queue();
		this.manager = manager;
		this.audioPlayer = createAudioPlayer({
			behaviors: {
				noSubscriber: NoSubscriberBehavior.Pause,
				maxMissedFrames: 100,
			},
		});

		this.options = {
			leaveOnEnd: true,
			leaveOnEmpty: true,
			leaveTimeout: 100000,
			volume: 100,
			quality: "high",
			extractorTimeout: 50000,
			selfDeaf: true,
			selfMute: false,
			...options,
			tts: {
				createPlayer: false,
				interrupt: true,
				volume: 100,
				maxTimeTts: 60_000,
				...(options?.tts || {}),
			},
		};
		this.lowPerformanceMode = this.options.lowPerformance ?? this.options.quality === "low";

		const preloadOptions = this.options.preload || {};
		const preloadAutoDisable = preloadOptions.autoDisableInLowPerformance ?? true;
		this.preloadEnabled = preloadOptions.enabled ?? true;
		if (this.lowPerformanceMode && preloadAutoDisable) {
			this.preloadEnabled = false;
		}

		const crossfadeOptions = this.options.crossfade || {};
		const crossfadeAutoEnable = crossfadeOptions.autoEnable ?? true;
		const crossfadeAutoDisable = crossfadeOptions.autoDisableInLowPerformance ?? true;
		this.crossfadeDurationMs = Math.max(0, crossfadeOptions.durationMs ?? 500);

		if (typeof crossfadeOptions.enabled === "boolean") {
			this.crossfadeEnabled = crossfadeOptions.enabled;
		} else {
			this.crossfadeEnabled = crossfadeAutoEnable;
		}

		if (this.lowPerformanceMode && crossfadeAutoDisable) {
			this.crossfadeEnabled = false;
		}

		const smartTransitionOptions = this.options.smartTransition || {};
		this.smartTransitionEnabled = smartTransitionOptions.enabled ?? true;
		this.smartTransitionGenreAware = smartTransitionOptions.genreAware ?? true;
		this.smartTransitionBeatAlign = smartTransitionOptions.beatAlign ?? true;
		this.smartTransitionBaseMs = Math.max(0, smartTransitionOptions.baseDurationMs ?? this.crossfadeDurationMs);
		this.smartTransitionMinMs = Math.max(0, smartTransitionOptions.minDurationMs ?? 1200);
		this.smartTransitionMaxMs = Math.max(this.smartTransitionMinMs, smartTransitionOptions.maxDurationMs ?? 8000);
		this.smartTransitionBeatAlignMaxWaitMs = Math.max(0, smartTransitionOptions.beatAlignMaxWaitMs ?? 1200);
		this.smartTransitionGenreDurations = {
			...this.smartTransitionGenreDurations,
			...(smartTransitionOptions.genreDurations || {}),
		};

		const antiStuckOptions = this.options.antiStuck || {};
		this.antiStuckEnabled = antiStuckOptions.enabled ?? true;
		this.antiStuckMaxRetries = Math.max(0, antiStuckOptions.maxRetries ?? 2);
		this.antiStuckRetryDelayMs = Math.max(0, antiStuckOptions.retryDelayMs ?? 900);
		this.antiStuckReusePreloadFirst = antiStuckOptions.reusePreloadFirst ?? true;
		this.antiStuckReduceQualityOnRetry = antiStuckOptions.reduceQualityOnRetry ?? true;
		this.antiStuckControlledSkipThreshold = Math.max(1, antiStuckOptions.controlledSkipThreshold ?? 3);

		const loudnessOptions = this.options.loudnessNormalization || {};
		this.loudnessNormalizationEnabled = loudnessOptions.enabled ?? false;
		this.loudnessTargetLUFS = loudnessOptions.targetLUFS ?? -14;
		this.loudnessMaxBoostDb = Math.max(0, loudnessOptions.maxBoostDb ?? 8);
		this.loudnessMaxCutDb = Math.max(0, loudnessOptions.maxCutDb ?? 10);
		this.loudnessLimiterCeiling = Math.min(1, Math.max(0.1, loudnessOptions.limiterCeiling ?? 0.95));

		this.debug(
			`[Player] Runtime options resolved: lowPerformance=${this.lowPerformanceMode}, preload=${this.preloadEnabled}, crossfade=${this.crossfadeEnabled} (${this.crossfadeDurationMs}ms), smartTransition=${this.smartTransitionEnabled}, antiStuck=${this.antiStuckEnabled}, loudnessNormalization=${this.loudnessNormalizationEnabled}`,
		);

		this.trackMiddlewareChain = [...this.manager.getTrackMiddlewareChain(), ...normalizeTrackMiddleware(options.trackMiddleware)];

		this.filter = new FilterManager(this, this.manager);
		this.extensionManager = new ExtensionManager(this, this.manager);
		this.pluginManager = new PluginManager(this, this.manager, {
			extractorTimeout: this.options.extractorTimeout,
		});
		this.streamManager = new StreamManager({
			maxConcurrentStreams: 2,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
		});
		this.preloadManager = new PreloadManager({
			streamManager: this.streamManager,
			debug: this.debug.bind(this),
			getNextTrack: () => {
				if (this.queue.loop() === "track") {
					return this.queue.currentTrack;
				}
				return this.queue.nextTrack;
			},
			getStream: (track) => this.getStream(track),
			isDestroyed: () => this.destroyed,
			isEnabled: () => this.preloadEnabled,
		});
		this.volume = this.options.volume || 100;
		this.userdata = this.options.userdata;
		this.searchCache = new LRUCache<string, SearchResult>({
			max: 200,
			ttl: this.SEARCH_CACHE_TTL,
			dispose: (value, key, reason) => {
				if (this.listenerCount("debug") > 0) {
					this.debug(`[SearchCache] Disposed cache entry: ${key}, reason: ${reason}`);
				}
			},
			allowStale: false,
			updateAgeOnGet: true,
		});

		this.setupEventListeners();

		// Initialize filters from options
		if (this.options.filters && this.options.filters.length > 0) {
			this.debug(`[Player] Initializing ${this.options.filters.length} filters from options`);
			// Use async version but don't await in constructor
			this.filter.applyFilters(this.options.filters).catch((error: any) => {
				this.debug(`[Player] Error initializing filters:`, error);
			});
		}

		// Optionally pre-create the TTS AudioPlayer
		if (this.options?.tts?.createPlayer) {
			this.ensureTTSPlayer();
		}
	}

	/**
	 * Destroy current stream to prevent memory leaks
	 * @private
	 */
	private destroyCurrentStream(): void {
		this.audioPlayer.stop(true);
		if (!this.currentResource) return;

		const stream = (this.currentResource as any)?.metadata?.stream ?? (this.currentResource as any)?.stream;

		if (stream && typeof stream.destroy === "function") {
			stream.destroy().catch((e: any) => this.debug("Stream destroy error:", e));
		}

		this.currentResource = null;
	}

	//#region Search

	/**
	 * Search for tracks using the player's extensions and plugins
	 *
	 * @param {string} query - The query to search for
	 * @param {string} requestedBy - The user ID who requested the search
	 * @returns {Promise<SearchResult>} The search result
	 * @example
	 * const result = await player.search("Never Gonna Give You Up", userId);
	 * console.log(`Search result: ${result.tracks.length} tracks`);
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.debug(`[Player] Search called with query: ${query}, requestedBy: ${requestedBy}`);

		// Check player cache first (LRU)
		const cachedResult = this.getCachedSearchResult(query);
		if (cachedResult) {
			return cachedResult;
		}

		// Try extensions first
		const extensionResult = await this.extensionManager.provideSearch(query, requestedBy);
		if (extensionResult && Array.isArray(extensionResult.tracks) && extensionResult.tracks.length > 0) {
			this.debug(`[Player] Extension handled search for query: ${query}`);
			this.cacheSearchResult(query, extensionResult);
			return extensionResult;
		}

		// Use PluginManager for search with deduplication and evaluation
		const pluginResult = await this.pluginManager.search(query, requestedBy);

		if (pluginResult && pluginResult.tracks.length > 0) {
			this.debug(`[Player] Plugin search returned ${pluginResult.tracks.length} tracks (score: ${pluginResult.score?.score}%)`);

			if (pluginResult.score) {
				this.debug(`[Player] Search evaluation - ${pluginResult.score.reason}`);
			}

			this.cacheSearchResult(query, pluginResult);
			return pluginResult;
		}

		this.debug(`[Player] No search results for query: ${query}`);
		throw new Error(`No results found for: ${query}`);
	}

	/**
	 * Get cached search result or null if not found/expired
	 * @param query The search query
	 * @returns Cached search result or null
	 */
	private getCachedSearchResult(query: string): SearchResult | null {
		const cacheKey = query.toLowerCase().trim();
		const cached = this.searchCache.get(cacheKey);
		if (cached) {
			this.debug(`[SearchCache] Using cached search result for: ${query}`);
			return cached;
		}

		return null;
	}

	/**
	 * Cache search result
	 * @param query The search query
	 * @param result The search result to cache
	 */
	private cacheSearchResult(query: string, result: SearchResult): void {
		const cacheKey = query.toLowerCase().trim();
		this.searchCache.set(cacheKey, result);
		this.debug(`[SearchCache] Cached search result for: ${query} (${result.tracks.length} tracks)`);
	}

	/**
	 * Clear expired search cache entries
	 */
	private clearExpiredSearchCache(): void {
		this.searchCache.purgeStale();
		this.debug(`[SearchCache] Purged stale search cache entries`);
	}

	/**
	 * Clear all search cache entries
	 * @example
	 * player.clearSearchCache();
	 */
	public clearSearchCache(): void {
		const cacheSize = this.searchCache.size;
		this.searchCache.clear();
		this.debug(`[SearchCache] Cleared all ${cacheSize} search cache entries`);
	}

	/**
	 * Debug method to check for duplicate search calls
	 * @param query The search query to check
	 * @returns Debug information about the query
	 */
	public debugSearchQuery(query: string): {
		isCached: boolean;
		cacheAge?: number;
		pluginCount: number;
		ttsFiltered: boolean;
	} {
		const cacheKey = query.toLowerCase().trim();
		const cached = this.searchCache.get(cacheKey);
		const isCached = !!cached;

		const allPlugins = this.pluginManager.getAll();
		const plugins = allPlugins.filter((p) => {
			if (p.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")) {
				return false;
			}
			return true;
		});

		return {
			isCached,
			cacheAge: undefined,
			pluginCount: plugins.length,
			ttsFiltered: allPlugins.length > plugins.length,
		};
	}

	private async generateWillNext(): Promise<void> {
		const lastTrack = this.queue.previousTracks[this.queue.previousTracks.length - 1] ?? this.queue.currentTrack;
		if (!lastTrack) return;
		const related = await this.pluginManager.getRelatedTracks(lastTrack);
		if (!related || related.length === 0) return;
		const randomchoice = Math.floor(Math.random() * related.length);
		const nextTrack = this.queue.nextTrack ? this.queue.nextTrack : related[randomchoice];
		this.queue.willNextTrack(nextTrack);
		this.queue.relatedTracks(related);
		this.debug(`[Player] Will next track if autoplay: ${nextTrack?.title}]`);
		this.emit("willPlay", nextTrack, related);
	}
	//#endregion
	//#region Play

	/**
	 * Play a track, search query, search result, or play from queue
	 *
	 * @param {string | Track | SearchResult | null} query - Track URL, search query, Track object, SearchResult, or null for play
	 * @param {string} requestedBy - User ID who requested the track
	 * @returns {Promise<boolean>} True if playback started successfully
	 * @example
	 * await player.play("Never Gonna Give You Up", userId); // Search query
	 * await player.play("https://youtube.com/watch?v=dQw4w9WgXcQ", userId); // Direct URL
	 * await player.play("tts: Hello everyone!", userId); // Text-to-Speech
	 * await player.play(trackObject, userId); // Track object
	 * await player.play(searchResult, userId); // SearchResult object
	 * await player.play(null); // play from queue
	 */
	async play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot play while subscribed to another player. Call unsubscribeForward() first.");
			return false;
		}
		const debugInfo =
			query === null ? "null"
			: typeof query === "string" ? query
			: "tracks" in query ? `${query.tracks.length} tracks`
			: query.title || "unknown";
		this.debug(`[Player] Play called with query: ${debugInfo}`);
		this.clearLeaveTimeout();
		let tracksToAdd: Track[] = [];
		let isPlaylist = false;
		let effectiveRequest: ExtensionPlayRequest = { query: query as string | Track, requestedBy };
		let hookResponse: ExtensionPlayResponse = {};

		try {
			// Handle null query - play from queue
			if (query === null) {
				this.debug(`[Player] Play from queue requested`);
				if (this.queue.isEmpty) {
					this.debug(`[Player] Queue is empty, nothing to play`);
					return false;
				}

				if (!this.isPlaying) {
					return await this.playNext();
				}
				return true;
			}

			// Handle SearchResult
			if (query && typeof query === "object" && "tracks" in query && Array.isArray(query.tracks)) {
				this.debug(`[Player] Playing SearchResult with ${query.tracks.length} tracks`);
				tracksToAdd = query.tracks;
				isPlaylist = !!query.playlist || query.tracks.length > 1;

				if (query.playlist) {
					this.debug(`[Player] Added playlist: ${query.playlist.name} (${tracksToAdd.length} tracks)`);
				}
			} else {
				// Handle other types (string, Track)
				const hookOutcome = await this.extensionManager.beforePlayHooks(effectiveRequest);
				effectiveRequest = hookOutcome.request;
				hookResponse = hookOutcome.response;
				if (effectiveRequest.requestedBy === undefined) {
					effectiveRequest.requestedBy = requestedBy;
				}

				const hookTracks = Array.isArray(hookResponse.tracks) ? hookResponse.tracks : undefined;

				if (hookResponse.handled && (!hookTracks || hookTracks.length === 0)) {
					const handledPayload: ExtensionAfterPlayPayload = {
						success: hookResponse.success ?? true,
						query: effectiveRequest.query,
						requestedBy: effectiveRequest.requestedBy,
						tracks: [],
						isPlaylist: hookResponse.isPlaylist ?? false,
						error: hookResponse.error,
					};
					await this.extensionManager.afterPlayHooks(handledPayload);
					if (hookResponse.error) {
						this.emit("playerError", hookResponse.error);
					}
					return hookResponse.success ?? true;
				}

				if (hookTracks && hookTracks.length > 0) {
					tracksToAdd = hookTracks;
					isPlaylist = hookResponse.isPlaylist ?? hookTracks.length > 1;
				} else if (typeof effectiveRequest.query === "string") {
					const searchResult = await this.search(effectiveRequest.query, effectiveRequest.requestedBy || "Unknown");
					tracksToAdd = searchResult.tracks;
					if (searchResult.playlist) {
						isPlaylist = true;
						this.debug(`[Player] Added playlist: ${searchResult.playlist.name} (${tracksToAdd.length} tracks)`);
					}
				} else if (effectiveRequest.query) {
					tracksToAdd = [effectiveRequest.query as Track];
				}
			}

			if (tracksToAdd.length === 0) {
				this.debug(`[Player] No tracks found for play`);
				throw new Error("No tracks found");
			}

			const isTTS = (t: Track | undefined) => {
				if (!t) return false;
				try {
					return typeof t.source === "string" && t.source.toLowerCase().includes("tts");
				} catch {
					return false;
				}
			};

			const queryLooksTTS =
				typeof effectiveRequest.query === "string" && effectiveRequest.query.trim().toLowerCase().startsWith("tts");

			if (
				!isPlaylist &&
				tracksToAdd.length > 0 &&
				this.options?.tts?.interrupt !== false &&
				(isTTS(tracksToAdd[0]) || queryLooksTTS)
			) {
				this.debug(`[Player] Interrupting with TTS: ${tracksToAdd[0].title}`);
				await this.interruptWithTTSTrack(tracksToAdd[0]);
				await this.extensionManager.afterPlayHooks({
					success: true,
					query: effectiveRequest.query,
					requestedBy: effectiveRequest.requestedBy,
					tracks: tracksToAdd,
					isPlaylist,
				});
				return true;
			}

			if (isPlaylist) {
				this.queue.addMultiple(tracksToAdd);
				this.emit("queueAddList", tracksToAdd);
			} else {
				this.queue.add(tracksToAdd[0]);
				this.emit("queueAdd", tracksToAdd[0]);
			}

			if (this.isPlaying && !this.destroyed) {
				void this.preloadNextTrack().catch((err) => this.debug("[Player] Preload after queue add error:", err));
			}

			const started = !this.isPlaying ? await this.playNext() : true;

			await this.extensionManager.afterPlayHooks({
				success: started,
				query: effectiveRequest.query,
				requestedBy: effectiveRequest.requestedBy,
				tracks: tracksToAdd,
				isPlaylist,
			});

			return started;
		} catch (error) {
			await this.extensionManager.afterPlayHooks({
				success: false,
				query: effectiveRequest.query,
				requestedBy: effectiveRequest.requestedBy,
				tracks: tracksToAdd,
				isPlaylist,
				error: error as Error,
			});
			this.debug(`[Player] Play error:`, error);
			this.emit("playerError", error as Error);
			return false;
		}
	}
	//#endregion
	//#region Preload
	/**
	 * Main preload method - only one at a time
	 */
	private async preloadNextTrack(): Promise<void> {
		await this.preloadManager.preloadNextTrack();
	}

	/**
	 * Safe cancel preload - doesn't throw
	 */
	private async safeCancelPreload(): Promise<void> {
		await this.preloadManager.safeCancelPreload();
	}

	// Preload stream fetch/cancel flow has been moved to PreloadManager.
	/**
	 * Preload next track with proper error handling and cleanup
	 */
	async preloadNext(): Promise<void> {
		await this.preloadManager.preloadNextTrack();
	}

	private async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		if (!resource.volume) return;

		const safeDuration = Math.max(0, durationMs);
		if (safeDuration === 0) {
			resource.volume.setVolume(to);
			return;
		}

		const steps = Math.max(1, Math.floor(safeDuration / 50));
		const stepDuration = Math.max(20, Math.floor(safeDuration / steps));
		const delta = (to - from) / steps;

		resource.volume.setVolume(from);
		for (let i = 1; i <= steps; i++) {
			await new Promise((resolve) => setTimeout(resolve, stepDuration));
			resource.volume.setVolume(from + delta * i);
		}
	}

	private async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		if (!this.crossfadeEnabled || !resource.volume) return;
		const targetVolume = this.getTrackTargetVolume(track);
		const transitionMs = this.resolveSmartTransitionDuration(track);
		await this.fadeResourceVolume(resource, 0, targetVolume, transitionMs);
	}

	private async applyCrossfadeOutCurrent(): Promise<void> {
		if (!this.crossfadeEnabled) return;
		const current = this.currentSlot.resource || this.currentResource;
		if (!current?.volume) return;
		const currentVolume = current.volume.volume ?? this.volume / 100;
		const currentTrack = this.queue.currentTrack;
		const transitionMs =
			currentTrack ? this.resolveSmartTransitionDuration(currentTrack) : this.resolveSmartTransitionDuration({} as Track);
		await this.fadeResourceVolume(current, currentVolume, 0, transitionMs);
	}

	private async crossfadeSkipAndStop(): Promise<void> {
		if (!this.crossfadeEnabled) {
			this.audioPlayer.stop();
			return;
		}
		if (this.crossfadeTransitionLock) {
			return;
		}
		this.crossfadeTransitionLock = true;
		try {
			await this.applyCrossfadeOutCurrent();
			this.audioPlayer.stop();
		} finally {
			this.crossfadeTransitionLock = false;
		}
	}

	private getTrackMetadataValue(track: Track, key: string): any {
		const md = track?.metadata as Record<string, any> | undefined;
		if (!md) return undefined;
		return md[key];
	}

	private resolveSmartTransitionDuration(track: Track): number {
		if (!this.smartTransitionEnabled) {
			return this.crossfadeDurationMs;
		}

		let duration = this.smartTransitionBaseMs;
		if (this.smartTransitionGenreAware) {
			const rawGenre = this.getTrackMetadataValue(track, "genre");
			const genre = typeof rawGenre === "string" ? rawGenre.toLowerCase().trim() : "";
			if (genre && this.smartTransitionGenreDurations[genre] !== undefined) {
				duration = this.smartTransitionGenreDurations[genre];
			}
		}

		return Math.min(this.smartTransitionMaxMs, Math.max(this.smartTransitionMinMs, duration));
	}

	private async maybeAlignToBeatBoundary(): Promise<void> {
		if (!this.smartTransitionEnabled || !this.smartTransitionBeatAlign) return;
		const currentTrack = this.queue.currentTrack;
		if (!currentTrack || !this.currentResource) return;

		const bpmRaw = this.getTrackMetadataValue(currentTrack, "bpm");
		const bpm = typeof bpmRaw === "number" ? bpmRaw : Number(bpmRaw);
		if (!Number.isFinite(bpm) || bpm <= 0) return;

		const beatMs = 60000 / bpm;
		const positionMs = this.currentResource.playbackDuration;
		const remainder = positionMs % beatMs;
		const waitMs = beatMs - remainder;
		if (waitMs > 0 && waitMs <= this.smartTransitionBeatAlignMaxWaitMs) {
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}

	private getTrackTargetVolume(track: Track): number {
		const base = this.volume / 100;
		if (!this.loudnessNormalizationEnabled) {
			return base;
		}

		const lufsRaw = this.getTrackMetadataValue(track, "lufs");
		const trackLufs = typeof lufsRaw === "number" ? lufsRaw : Number(lufsRaw);
		if (!Number.isFinite(trackLufs)) {
			return Math.min(base, this.loudnessLimiterCeiling);
		}

		const deltaDbRaw = this.loudnessTargetLUFS - trackLufs;
		const maxBoost = this.loudnessMaxBoostDb;
		const maxCut = this.loudnessMaxCutDb;
		const deltaDb = Math.max(-maxCut, Math.min(maxBoost, deltaDbRaw));
		const multiplier = Math.pow(10, deltaDb / 20);
		const adjusted = base * multiplier;
		return Math.min(this.loudnessLimiterCeiling, Math.max(0, adjusted));
	}

	private async attemptTrackRecovery(track: Track, reason: unknown): Promise<boolean> {
		if (!this.antiStuckEnabled) return false;
		this.debug(`[AntiStuck] Recovery started for: ${track.title}`, reason);

		const originalQuality = this.options.quality;
		let attempted = 0;

		while (attempted < this.antiStuckMaxRetries) {
			attempted++;
			if (this.antiStuckReduceQualityOnRetry) {
				this.options.quality = "low";
			}

			if (this.antiStuckRetryDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, this.antiStuckRetryDelayMs));
			}

			try {
				if (this.antiStuckReusePreloadFirst && this.preloadManager.hasValidPreload(track)) {
					const startedFromPreload = await this.startTrack(track);
					if (startedFromPreload) {
						this.antiStuckConsecutiveFailures = 0;
						this.options.quality = originalQuality;
						return true;
					}
				}

				const started = await this.loadFreshStream(track);
				if (started) {
					this.antiStuckConsecutiveFailures = 0;
					this.options.quality = originalQuality;
					return true;
				}
			} catch (error) {
				this.debug(`[AntiStuck] Retry ${attempted} failed for ${track.title}:`, error);
			}
		}

		this.options.quality = originalQuality;
		this.antiStuckConsecutiveFailures++;
		if (this.antiStuckConsecutiveFailures >= this.antiStuckControlledSkipThreshold) {
			this.debug(`[AntiStuck] Controlled skip threshold reached for ${track.title}`);
			return false;
		}

		// Avoid hard skip storm by leaving track for next natural retry window.
		this.debug(`[AntiStuck] Keeping track for controlled retry window: ${track.title}`);
		return false;
	}

	/**
	 * Cancel preload (when skipping or stopping)
	 */
	private cancelPreload(): void {
		this.preloadManager.cancelPreload();
	}

	/**
	 * Clear a stream slot
	 */
	private clearSlot(slot: StreamSlot): void {
		if (slot.resource) {
			try {
				const stream = slot.resource.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) {
					stream.destroy();
				}
			} catch (err) {
				// Ignore
			}
		}

		if (slot.streamId && this.streamManager) {
			// Don't wait for unregister
			this.streamManager.unregisterStream(slot.streamId, true);
		}

		slot.resource = null;
		slot.track = null;
		slot.streamId = null;
		slot.abortController = null;
		slot.isValid = false;
		slot.isLoading = false;
		slot.loadPromise = null;
	}

	/**
	 * Promote preload slot to current slot without destroying promoted stream.
	 */
	private promotePreloadToCurrent(track: Track): void {
		const promoted = this.preloadManager.promoteToCurrent(track, this.currentSlot);
		this.currentResource = promoted;
	}

	/**
	 * Create AudioResource with filters and seek applied
	 *
	 * @param {StreamInfo} streamInfo - The stream information
	 * @param {Track} track - The track being processed
	 * @param {number} position - Position in milliseconds to seek to (0 = no seek)
	 * @returns {Promise<AudioResource>} The AudioResource with filters and seek applied
	 */
	private async createResource(streamInfo: StreamInfo, track: Track, position: number = 0): Promise<AudioResource> {
		const filterString = this.filter.getFilterString();
		this.debug(`[Player] Creating AudioResource — filters: ${filterString || "none"}, seek: ${position}ms`);

		// -1 = sentinel "no seek requested"
		const seekArg = position > 0 ? position : -1;

		if (filterString || position > 0) {
			// throws on failure — do NOT fall back to the already-piped stream
			const processedStream = await this.filter.applyFiltersAndSeek(streamInfo.stream, seekArg);
			streamInfo.type = StreamType.Arbitrary as any;

			return createAudioResource(processedStream, {
				metadata: track,
				inputType: StreamType.Arbitrary,
				inlineVolume: true,
			});
		}

		return createAudioResource(streamInfo.stream, {
			metadata: track,
			inputType:
				streamInfo.type === "webm/opus" ? StreamType.WebmOpus
				: streamInfo.type === "ogg/opus" ? StreamType.OggOpus
				: StreamType.Arbitrary,
			inlineVolume: true,
		});
	}

	private mergeTrackPreserveRef(target: Track, source: Track): void {
		if (source === target) return;
		const mergedMeta = {
			...(target.metadata || {}),
			...(source.metadata || {}),
		};
		Object.assign(target, source);
		target.metadata = mergedMeta;
	}

	private async applyTrackMiddleware(track: Track): Promise<void> {
		if (this.trackMiddlewareChain.length === 0) return;
		const ctx = { player: this, manager: this.manager };
		for (const mw of this.trackMiddlewareChain) {
			try {
				const out = await mw(track, ctx);
				if (out != null && out !== track) {
					this.mergeTrackPreserveRef(track, out);
				}
			} catch (err) {
				this.debug(`[TrackMiddleware] Error:`, err);
			}
		}
	}

	private async getStream(track: Track): Promise<StreamInfo | null> {
		if (this.destroyed) {
			throw new Error("PLAYER_DESTROYED");
		}
		await this.applyTrackMiddleware(track);
		const trackId = track.id || track.url || track.title;
		const existingStream = this.streamManager.getStreamByTrack(trackId);
		this.playbackMode = PlaybackMode.NATIVE;
		if (existingStream && !existingStream.destroyed) {
			this.debug(`[Stream] Using existing stream from manager for: ${track.title}`);

			return { stream: existingStream, type: "arbitrary" };
		}

		// FIRST: Try to get stream from extensions
		let stream = await this.extensionManager.provideStream(track);

		if (this.destroyed) {
			if (stream?.stream && typeof stream.stream.destroy === "function" && !stream.stream.destroyed) {
				stream.stream.destroy();
			}
			throw new Error("PLAYER_DESTROYED");
		}

		// Handle remote playback - THIS SHOULD BE FIRST PRIORITY
		if (stream?.remote && stream.handle) {
			this.debug(`[Stream] Remote handle provided by extension for: ${track.title}`);
			this.playbackMode = PlaybackMode.REMOTE;
			this.preloadEnabled = false;
			this.crossfadeEnabled = false;

			// Clear any existing preload for remote mode
			this.cancelPreload();

			return stream;
		}

		// If extension returned a regular stream
		if (stream?.stream) {
			this.debug(`[Stream] Extension provided stream for: ${track.title}`);
			this.playbackMode = PlaybackMode.NATIVE;
			return stream;
		}

		// SECOND: Try plugins only if extension didn't handle it
		this.debug(`[Stream] Extension didn't provide stream, trying plugins for: ${track.title}`);

		stream = await this.pluginManager.getStream(track);

		if (this.destroyed) {
			if (stream?.stream && typeof stream.stream.destroy === "function" && !stream.stream.destroyed) {
				stream.stream.destroy();
			}
			throw new Error("PLAYER_DESTROYED");
		}

		if (stream?.stream) {
			const existingAgain = this.streamManager.getStreamByTrack(trackId);
			if (existingAgain && !existingAgain.destroyed) {
				if (stream.stream.destroy) stream.stream.destroy();
				return { stream: existingAgain, type: "arbitrary" };
			}
			this.debug(`[Stream] Plugin provided stream for: ${track.title}`);
			this.playbackMode = PlaybackMode.NATIVE;
			return stream;
		}

		// Check if any plugin claims to support this track but failed
		if (!this.pluginManager.hasStreamCandidate(track)) {
			throw new Error(`UNRECOVERABLE_NO_PLUGIN:${track.title}`);
		}

		throw new Error(`No stream available for track: ${track.title}`);
	}

	private isUnrecoverableStreamError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		return error.message.startsWith("UNRECOVERABLE_NO_PLUGIN:");
	}

	/**
	 * Start playing a specific track immediately, replacing the current resource.
	 */
	private async startTrack(track: Track): Promise<boolean> {
		if (this.destroyed) return false;

		// First, get stream info (this will handle remote detection)
		let streamInfo: StreamInfo | null = null;

		try {
			streamInfo = await this.getStream(track);
		} catch (error) {
			this.debug(`[Player] Failed to get stream for track: ${track.title}`, error);
			throw error;
		}

		// Handle remote playback
		if (streamInfo?.remote && streamInfo.handle) {
			return await this.playRemote(track, streamInfo);
		}

		// Handle native playback
		try {
			// Try to use preloaded resource
			if (this.preloadManager.hasValidPreload(track)) {
				this.debug(`[Player] Using preloaded stream for: ${track.title}`);

				const oldStreamId = this.currentSlot.streamId;
				if (oldStreamId && this.streamManager) {
					setTimeout(() => {
						if (this.currentSlot.streamId === oldStreamId) {
							this.streamManager.unregisterStream(oldStreamId, true);
						}
					}, 3000);
				}

				this.promotePreloadToCurrent(track);
				const currentResource = this.currentSlot.resource;
				if (!currentResource) {
					return false;
				}
				this.seekOffset = 0;
				const targetVolume = this.getTrackTargetVolume(track);

				if (currentResource.volume) {
					currentResource.volume.setVolume(this.crossfadeEnabled ? 0 : targetVolume);
				}

				await this.maybeAlignToBeatBoundary();
				this.refreshLock = true;
				try {
					this.audioPlayer.stop(true);
					this.audioPlayer.play(currentResource);
					await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
				} finally {
					this.refreshLock = false;
				}
				await this.applyCrossfadeIn(currentResource, track);

				this.preloadNextTrack().catch((err) => {
					this.debug(`[Player] Preload error:`, err);
				});

				return true;
			}

			this.debug(`[Player] No preload available, loading fresh: ${track.title}`);
			return await this.loadFreshStream(track);
		} catch (error) {
			this.debug(`[Player] startTrack error:`, error);
			this.emit("playerError", error as Error, track);
			return false;
		}
	}

	/**
	 * Load fresh stream when no preload available
	 */
	private async loadFreshStream(track: Track): Promise<boolean> {
		if (this.destroyed) return false;

		// Cancel preload to free resources
		await this.safeCancelPreload();

		try {
			const streamInfo = await this.getStream(track);

			// Handle remote playback
			if (streamInfo?.remote && streamInfo.handle) {
				return await this.playRemote(track, streamInfo);
			}

			if (!streamInfo?.stream) {
				throw new Error(`No stream available`);
			}

			// Register with StreamManager
			const streamId = this.streamManager.registerStream(streamInfo.stream, track, {
				source: track.source || "stream",
				isPreload: false,
				isRemote: !!streamInfo?.remote,
				priority: 10,
			});

			// Create resource
			const resource = await this.createResource(streamInfo, track, 0);

			// Clean up old current
			if (this.currentSlot.streamId && this.currentSlot.streamId !== streamId) {
				this.streamManager.unregisterStream(this.currentSlot.streamId, true);
			}

			// Set current slot
			this.currentSlot.resource = resource;
			this.currentSlot.track = track;
			this.currentSlot.streamId = streamId;
			this.currentSlot.isValid = true;
			this.currentResource = resource;
			this.seekOffset = 0; // new track — reset seek baseline

			// Apply volume
			const targetVolume = this.getTrackTargetVolume(track);
			if (resource.volume) {
				resource.volume.setVolume(this.crossfadeEnabled ? 0 : targetVolume);
			}

			// Play — lock refresh so Idle event doesn't spawn duplicate playNext
			await this.maybeAlignToBeatBoundary();
			this.refreshLock = true;
			try {
				this.audioPlayer.stop(true);
				this.audioPlayer.play(resource);
				await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
			} finally {
				this.refreshLock = false;
			}
			await this.applyCrossfadeIn(resource, track);

			// Preload next (async)
			if (!this.destroyed) {
				this.preloadNextTrack().catch((err) => {
					this.debug(`[Player] Preload error:`, err);
				});
			}

			return true;
		} catch (error) {
			this.debug(`[Player] loadFreshStream error:`, error);
			throw error;
		}
	}

	/**
	 * Play the next track in the queue, handling errors and edge cases gracefully
	 */
	public async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
		this.debug("[Player] playNext called");

		while (true) {
			const track = this.queue.next(this.skipLoop);
			this.skipLoop = false;

			if (!track) {
				if (this.queue.autoPlay()) {
					const willnext = this.queue.willNextTrack();
					if (willnext) {
						this.queue.addMultiple([willnext]);
						void this.preloadNextTrack().catch((err) => this.debug("[Player] Preload autoplay error:", err));
						continue;
					}

					await this.generateWillNext().catch((err) => this.debug("[Player] generateWillNext autoplay fallback error:", err));
					const generatedNext = this.queue.willNextTrack();
					if (generatedNext) {
						this.queue.add(generatedNext);
						void this.preloadNextTrack().catch((err) => this.debug("[Player] Preload autoplay generated error:", err));
						continue;
					}
				}

				this.debug(`[Player] No next track in queue`);
				this.emit("queueEnd");

				// Clean up both slots when queue is empty
				this.clearSlot(this.currentSlot);
				await this.safeCancelPreload();

				if (this.options.leaveOnEnd) {
					this.scheduleLeave();
				}

				return false;
			}

			this.generateWillNext().catch((err) => this.debug("[Player] generateWillNext error:", err));
			this.clearLeaveTimeout();
			this.debug(`[Player] playNext called for track: ${track.title}`);

			try {
				const started = await this.startTrack(track);
				if (started) {
					this.antiStuckConsecutiveFailures = 0;
					return true;
				}

				// For remote playback, if startTrack returns false, it's a failure
				if (this.playbackMode === PlaybackMode.REMOTE) {
					this.debug(`[Player] Remote track failed to start: ${track.title}`);
					continue; // Skip to next track
				}

				const recovered = await this.attemptTrackRecovery(track, new Error("TRACK_START_RETURNED_FALSE"));
				if (recovered) {
					return true;
				}
				if (this.antiStuckEnabled && this.antiStuckConsecutiveFailures < this.antiStuckControlledSkipThreshold) {
					this.queue.insert(track, 0);
					if (this.antiStuckRetryDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, this.antiStuckRetryDelayMs));
					}
				} else {
					this.antiStuckConsecutiveFailures = 0;
					this.skipLoop = true;
				}
			} catch (err) {
				this.debug(`[Player] playNext error:`, err);
				this.emit("playerError", err as Error, track);

				// For remote playback, just skip to next track
				if (this.playbackMode === PlaybackMode.REMOTE) {
					this.debug(`[Player] Remote track error, skipping: ${track.title}`);
					continue;
				}

				if (this.isUnrecoverableStreamError(err)) {
					this.debug(`[Player] Skipping unrecoverable track (no plugin): ${track.title}`);
					continue;
				}
				const recovered = await this.attemptTrackRecovery(track, err);
				if (recovered) {
					return true;
				}
				if (this.antiStuckEnabled && this.antiStuckConsecutiveFailures < this.antiStuckControlledSkipThreshold) {
					this.queue.insert(track, 0);
					if (this.antiStuckRetryDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, this.antiStuckRetryDelayMs));
					}
				} else {
					this.antiStuckConsecutiveFailures = 0;
					this.skipLoop = true;
				}
				continue;
			}
		}
	}

	private async playRemote(track: Track, stream: StreamInfo): Promise<boolean> {
		if (!stream.handle) return false;

		try {
			// Store the remote handle for later use
			this.remoteHandle = stream.handle;

			// Set current track before playing
			this.queue.setCurrentTrack(track);

			// Emit track start event before playing (so UI updates)
			this.emit("trackStart", track);

			// Start playback via remote handle
			await stream.handle.play();

			this.debug(`[Player] Remote playback started for: ${track.title}`);

			return true;
		} catch (error) {
			this.debug(`[Player] Remote playback error:`, error);
			this.emit("playerError", error as Error, track);
			return false;
		}
	}

	//#endregion
	//#region TTS

	private ensureTTSPlayer(): DiscordAudioPlayer {
		if (this.ttsPlayer) return this.ttsPlayer;
		this.ttsPlayer = createAudioPlayer({
			behaviors: {
				noSubscriber: NoSubscriberBehavior.Pause,
				maxMissedFrames: 100,
			},
		});
		this.ttsPlayer.on("error", (e) => this.debug("[TTS] error:", e));
		return this.ttsPlayer;
	}
	/**
	 * Interrupt current music with a TTS track. Pauses music, swaps the
	 * subscription to a dedicated TTS player, plays TTS, then resumes.
	 *
	 * @param {Track} track - The track to interrupt with
	 * @returns {Promise<void>}
	 * @example
	 * await player.interruptWithTTSTrack(track);
	 */
	public async interruptWithTTSTrack(track: Track): Promise<void> {
		const wasPlaying =
			this.audioPlayer.state.status === AudioPlayerStatus.Playing ||
			this.audioPlayer.state.status === AudioPlayerStatus.Buffering;

		let ttsResource: AudioResource | null = null;
		let ttsStream: any = null;

		try {
			if (!this.connection) throw new Error("No voice connection for TTS");
			const ttsPlayer = this.ensureTTSPlayer();

			await this.applyTrackMiddleware(track);

			// Build resource from plugin stream
			const streamInfo = await this.pluginManager.getStream(track);
			if (!streamInfo) {
				throw new Error(`No stream available for track: ${track.title}`);
			}
			ttsStream = streamInfo.stream;
			const resource = await this.createResource(streamInfo as StreamInfo, track);
			if (!resource) {
				throw new Error(`No resource available for track: ${track.title}`);
			}
			ttsResource = resource;
			if (resource.volume) {
				resource.volume.setVolume((this.options?.tts?.volume ?? this?.volume ?? 100) / 100);
			}

			// Pause current music if any
			try {
				this.pause();
			} catch {}

			// Swap subscription and play TTS
			this.connection.subscribe(ttsPlayer);
			this.emit("ttsStart", { track });
			ttsPlayer.play(resource);

			// Wait until TTS starts then finishes
			await entersState(ttsPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => null);
			// Derive timeoutMs from resource/track duration when available, with a sensible cap
			const md: any = (resource as any)?.metadata ?? {};
			const declared =
				typeof md.duration === "number" ? md.duration
				: typeof track?.duration === "number" ? track.duration
				: undefined;
			const declaredMs =
				declared ?
					declared > 1000 ?
						declared
					:	declared * 1000
				:	undefined;
			const cap = this.options?.tts?.maxTimeTts ?? 60_000;
			const idleTimeout = declaredMs ? Math.min(cap, Math.max(1_000, declaredMs + 1_500)) : cap;
			await entersState(ttsPlayer, AudioPlayerStatus.Idle, idleTimeout).catch(() => null);

			// Swap back and resume if needed
			this.connection.subscribe(this.audioPlayer);
		} catch (err) {
			this.debug("[TTS] error while playing:", err);
			this.emit("playerError", err as Error);
		} finally {
			// Clean up TTS stream and resource
			try {
				if (ttsStream && typeof ttsStream.destroy === "function") {
					ttsStream.destroy();
				}
			} catch (error) {
				this.debug("[TTS] Error destroying stream:", error);
			}

			if (wasPlaying) {
				try {
					this.resume();
				} catch {}
			}
			this.emit("ttsEnd");
		}
	}

	//#endregion
	//#region Player Function

	/**
	 * Connect to a voice channel
	 *
	 * @param {VoiceChannel} channel - Discord voice channel
	 * @returns {Promise<VoiceConnection>} The voice connection
	 * @example
	 * await player.connect(voiceChannel);
	 */
	async connect(
		channel: VoiceChannel,
		options: { group: string; selfDeaf: boolean; selfMute: boolean },
	): Promise<VoiceConnection> {
		try {
			this.debug(`[Player] Connecting to voice channel: ${channel.id}`);

			const connection = joinVoiceChannel({
				...options,
				channelId: channel.id,
				guildId: channel.guildId,
				adapterCreator: channel.guild.voiceAdapterCreator as any,
				selfDeaf: options?.selfDeaf ?? this.options?.selfDeaf ?? true,
				selfMute: options?.selfMute ?? this.options?.selfMute ?? false,
				group: options?.group ?? this.options?.group ?? "Ziplayer",
			});

			await entersState(connection, VoiceConnectionStatus.Ready, 50_000);
			this.connection = connection;

			connection.on(VoiceConnectionStatus.Disconnected, async () => {
				try {
					//  move channel
					await Promise.race([
						entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
						entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
					]);
					//  Signalling/Connecting → reconnect
					this.debug(`[Player] Reconnecting after channel move...`);
				} catch {
					// no reconnect in 5 giây → disconnect
					this.debug(`[Player] Truly disconnected, destroying player`);
					this.destroy();
				}
			});

			connection.on("error", (error) => {
				this.debug(`[Player] Voice connection error:`, error);
				this.emit("connectionError", error);
			});
			connection.subscribe(this.audioPlayer);

			this.clearLeaveTimeout();
			return this.connection;
		} catch (error) {
			this.debug(`[Player] Connection error:`, error);
			this.emit("connectionError", error as Error);
			this.connection?.destroy();
			throw error;
		}
	}

	/**
	 * Subscribe this player to another player's playback stream.
	 *
	 * This enables "forward mode", where the follower player directly subscribes
	 * to the leader player's {@link audioPlayer} instead of creating its own stream.
	 *
	 * Greatly reduces CPU, bandwidth, and extractor usage because only the leader
	 * creates and decodes the audio resource.
	 *
	 * ## Features
	 * - Real-time shared playback
	 * - Followers may join at any time
	 * - Automatic track synchronization
	 * - Optional volume synchronization
	 * - Automatic cleanup on destroy
	 * - Supports unlimited followers
	 *
	 * ## Lifecycle
	 * - When the leader starts a track, followers automatically receive the same track metadata.
	 * - When the leader pauses/resumes/stops, followers are synchronized.
	 * - Destroying the leader automatically unsubscribes all followers.
	 * - Destroying a follower only removes that follower.
	 *
	 * ## Notes
	 * - Both players must already be connected to voice.
	 * - A player cannot subscribe to itself.
	 * - Existing playback subscriptions are automatically replaced.
	 *
	 * @param {Player} leader The leader player to subscribe to.
	 * @param options Additional playback mirror options.
	 * @param options.syncVolume When true, follower volume automatically follows the leader. Default: true.
	 *
	 * @returns {boolean} True if subscription succeeded.
	 *
	 * @example
	 * follower.subscribeTo(leader);
	 *
	 * @example
	 * follower.subscribeTo(leader, {
	 *   syncVolume: true,
	 * });
	 */
	public subscribeTo(
		leader: Player,
		options?: {
			forwardMode?: boolean;
		},
	): boolean {
		if (!leader) return false;

		if (leader === this) {
			this.debug(`[Player] Cannot subscribe to self`);
			return false;
		}

		if (leader.destroyed) {
			this.debug("[Player] Cannot subscribe to destroyed leader");

			return false;
		}

		if (this.destroyed) {
			this.debug("[Player] Cannot subscribe destroyed player");

			return false;
		}

		if (!!leader.forwardLeader) {
			this.debug("[Player] Cannot subscribe to follower player");

			return false;
		}

		if (!this.connection || !leader.connection) {
			this.debug(`[Player] Missing connection for subscribeTo`);
			return false;
		}

		// cleanup old leader
		if (this.forwardLeader) {
			this.unsubscribeForward("This Player new subscribeTo " + leader.guildId);
		}

		this.forwardLeader = leader;

		leader.forwardFollowers.add(this);

		try {
			// clear local playback
			this.stop();

			// detach current followers first
			for (const fp of [...this.forwardFollowers]) {
				try {
					fp.unsubscribeForward("Leader new subscribeTo " + leader.guildId);
				} catch {}
			}

			this.forwardFollowers.clear();

			this.queue.clear();

			if (leader.currentTrack) {
				this.queue.setCurrentTrack(leader.currentTrack);
			}
			if (options?.forwardMode ?? true) this.playbackMode = PlaybackMode.FORWARD;

			if (this.playbackMode === PlaybackMode.FORWARD && this.connection) {
				this.connection.subscribe(leader.audioPlayer);
			}

			this.volume = leader.volume;

			this.emit("forwardModeStart", leader);

			this.debug(`[Player] Forward mode subscribed ${this.guildId} -> ${leader.guildId}`);

			return true;
		} catch (e) {
			this.debug(`[Player] subscribeTo error:`, e);

			this.forwardLeader = null;

			leader.forwardFollowers.delete(this);

			return false;
		}
	}

	/**
	 * Unsubscribe this player from its current playback leader.
	 *
	 * This disables forward mode and restores the player's own audioPlayer
	 * subscription back to its voice connection.
	 *
	 * Automatically emitted when:
	 * - The leader player is destroyed
	 * - This player is destroyed
	 * - A new leader subscription replaces the old one
	 *
	 * Emits:
	 * - `forwardModeEnd`
	 *
	 * @returns {boolean} True if a playback subscription existed and was removed.
	 *
	 * @example
	 * follower.unsubscribeForward();
	 */
	public unsubscribeForward(reason?: string | undefined): boolean {
		if (!this.forwardLeader) {
			return false;
		}

		const leader = this.forwardLeader;

		leader.forwardFollowers.delete(this);

		this.forwardLeader = null;

		this.playbackMode = PlaybackMode.NATIVE;

		try {
			this.connection?.subscribe(this.audioPlayer);
		} catch {}

		this.queue.clear();

		this.emit("forwardModeEnd", leader, reason);

		this.debug(`[Player] Forward mode unsubscribed ${this.guildId} <- ${leader.guildId}: ${reason ?? null}`);

		return true;
	}

	/**
	 * Pause the current track
	 *
	 * @returns {boolean} True if paused successfully
	 * @example
	 * const paused = player.pause();
	 * console.log(`Paused: ${paused}`);
	 */
	pause(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot pause while subscribed to another player");
			return false;
		}
		this.debug(`[Player] pause called`);
		if (this.playbackMode === PlaybackMode.REMOTE) {
			if (!this.remoteHandle) return false;
			void this.remoteHandle.pause().catch((e) => this.debug("[Player] Remote pause:", e));
			const track = this.queue.currentTrack;
			if (track) this.emit("playerPause", track);
			return true;
		}
		if (this.isPlaying && !this.isPaused) return this.audioPlayer.pause();

		return false;
	}

	/**
	 * Resume the current track
	 *
	 * @returns {boolean} True if resumed successfully
	 * @example
	 * const resumed = player.resume();
	 * console.log(`Resumed: ${resumed}`);
	 */
	resume(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot resume while subscribed to another player");
			return false;
		}
		this.debug(`[Player] resume called`);
		if (this.playbackMode === PlaybackMode.REMOTE) {
			if (!this.remoteHandle) return false;
			void this.remoteHandle.resume().catch((e) => this.debug("[Player] Remote resume:", e));
			const track = this.queue.currentTrack;
			if (track) this.emit("playerResume", track);
			return true;
		}

		if (this.isPaused) {
			const result = this.audioPlayer.unpause();
			if (result) {
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player resumed on track: ${track.title}`);
					// this.emit("playerResume", track); //đã có trong stateChange
				}
			}
			return result;
		}
		return false;
	}

	/**
	 * Stop the current track
	 *
	 * @returns {boolean} True if stopped successfully
	 * @example
	 * const stopped = player.stop();
	 * console.log(`Stopped: ${stopped}`);
	 */
	stop(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot stop while subscribed to another player");
			return false;
		}
		this.debug(`[Player] stop called`);
		if (this.playbackMode === PlaybackMode.REMOTE) {
			this.cancelPreload();
			this.queue.clear();
			void this.remoteHandle?.stop().catch((e) => this.debug("[Player] Remote stop:", e));
			this.emit("playerStop");
			return true;
		}
		// Cancel preload when stopping
		this.cancelPreload();

		this.queue.clear();
		const result = this.audioPlayer.stop();
		this.destroyCurrentStream();
		this.currentResource = null;

		this.emit("playerStop");
		for (const fp of this.forwardFollowers) {
			try {
				fp.connection?.subscribe(fp.audioPlayer);

				fp.audioPlayer.stop(true);

				fp.emit("playerStop");
			} catch {}
		}
		return result;
	}

	/**
	 * Seek to a specific position in the current track
	 *
	 * @param {number} position - Position in milliseconds to seek to
	 * @returns {Promise<boolean>} True if seek was successful
	 * @example
	 * // Seek to 30 seconds (30000ms)
	 * const success = await player.seek(30000);
	 * console.log(`Seek successful: ${success}`);
	 *
	 * // Seek to 1 minute 30 seconds (90000ms)
	 * await player.seek(90000);
	 */
	async seek(position: number): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot seek while subscribed to another player");
			return false;
		}
		this.debug(`[Player] seek called with position: ${position}ms`);

		if (this.playbackMode === PlaybackMode.REMOTE) {
			if (!this.remoteHandle) return false;
			await this.remoteHandle.seek(position);
			return true;
		}

		const track = this.queue.currentTrack;
		if (!track) {
			this.debug(`[Player] No current track to seek`);
			return false;
		}

		const totalDuration = track.duration > 1000 ? track.duration : track.duration * 1000;
		if (position < 0 || position > totalDuration) {
			this.debug(`[Player] Invalid seek position: ${position}ms (track duration: ${totalDuration}ms)`);
			return false;
		}

		const ok = await this.refreshPlayerResource(true, position);
		if (!ok) {
			this.debug(`[Player] Seek failed at position: ${position}ms`);
			return false;
		}
		return true;
	}

	/**
	 * Skip to the next track or skip to a specific index
	 *
	 * @param {number} index - Optional index to skip to (0 = next track)
	 * @returns {boolean} True if skipped successfully
	 * @example
	 * const skipped = player.skip(); // Skip to next track
	 * const skippedToIndex = player.skip(2); // Skip to track at index 2
	 * console.log(`Skipped: ${skipped}`);
	 */
	skip(index?: number): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot skip while subscribed to another player");
			return false;
		}
		this.debug(`[Player] skip called with index: ${index}`);

		if (this.playbackMode === PlaybackMode.REMOTE) {
			if (typeof index === "number" && index >= 0) {
				for (let i = 0; i < index; i++) this.queue.remove(0);
			}
			// signal the remote backend to stop;
			void this.remoteHandle?.stop().catch((e) => this.debug("[Player] Remote skip:", e));
			this.playNext();
			return true;
		}

		try {
			if (typeof index === "number" && index >= 0) {
				const targetTrack = this.queue.getTrack(index);
				if (!targetTrack) {
					this.debug(`[Player] No track found at index ${index}`);
					return false;
				}

				for (let i = 0; i < index; i++) {
					this.queue.remove(0);
				}

				this.debug(`[Player] Skipped to track at index ${index}: ${targetTrack.title}`);
			}

			if (this.isPlaying || this.isPaused) {
				this.skipLoop = true;
				void this.crossfadeSkipAndStop().catch((error) => {
					this.debug(`[Player] crossfade skip error:`, error);
					this.audioPlayer.stop();
				});
				return true;
			}

			return true;
		} catch (error) {
			this.debug(`[Player] skip error:`, error);
			return false;
		}
	}

	/**
	 * Go back to the previous track in history and play it.
	 *
	 * @returns {Promise<boolean>} True if previous track was played successfully
	 * @example
	 * const previous = await player.previous();
	 * console.log(`Previous: ${previous}`);
	 */
	async previous(): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot previous while subscribed to another player");
			return false;
		}
		this.debug(`[Player] previous called`);
		const track = this.queue.previous();
		if (!track) return false;
		if (this.queue.currentTrack) this.insert(this.queue.currentTrack, 0);
		this.clearLeaveTimeout();
		return this.startTrack(track);
	}

	/**
	 * Save a track's stream to a file and return a Readable stream
	 *
	 * @param {Track} track - The track to save
	 * @param {SaveOptions | string} options - Save options or filename string (for backward compatibility)
	 * @returns {Promise<Readable>} A Readable stream containing the audio data
	 * @example
	 * // Save current track to file
	 * const track = player.currentTrack;
	 * if (track) {
	 *   const stream = await player.save(track);
	 *
	 *   // Use fs to write the stream to file
	 *   const fs = require('fs');
	 *   const writeStream = fs.createWriteStream('saved-song.mp3');
	 *   stream.pipe(writeStream);
	 *
	 *   writeStream.on('finish', () => {
	 *     console.log('File saved successfully!');
	 *   });
	 * }
	 *
	 * // Save any track by URL
	 * const searchResult = await player.search("Never Gonna Give You Up", userId);
	 * if (searchResult.tracks.length > 0) {
	 *   const stream = await player.save(searchResult.tracks[0]);
	 *   // Handle the stream...
	 * }
	 *
	 * // Backward compatibility - filename as string
	 * const stream = await player.save(track, "my-song.mp3");
	 */
	async save(track: Track, options?: SaveOptions | string): Promise<Readable> {
		this.debug(`[Player] save called for track: ${track.title}`);

		// Parse options - support both SaveOptions object and filename string (backward compatibility)
		let saveOptions: SaveOptions = {};
		if (typeof options === "string") {
			saveOptions = { filename: options };
		} else if (options) {
			saveOptions = options;
		}

		try {
			await this.applyTrackMiddleware(track);

			// Skip extension manager for saving - we want the raw stream without filters/seek applied, and extensions may not support this
			let streamInfo: StreamInfo | null = await this.pluginManager.getStream(track);

			if (!streamInfo || !streamInfo.stream) {
				throw new Error(`No save stream available for track: ${track.title}`);
			}

			this.debug(`[Player] Save stream obtained for track: ${track.title}`);
			if (saveOptions.filename) {
				this.debug(`[Player] Save options - filename: ${saveOptions.filename}, quality: ${saveOptions.quality || "default"}`);
			}

			// Apply filters if any are active
			let finalStream = streamInfo.stream;

			if (saveOptions.filter || saveOptions.seek) {
				try {
					this.filter.clearAll();
					this.filter.applyFilters(saveOptions.filter || []);
				} catch (err) {
					this.debug(`[Player] Error applying save filters:`, err);
				}

				this.debug(`[Player] Applying filters to save stream: ${this.filter.getFilterString() || "none"}`);
				finalStream = await this.filter.applyFiltersAndSeek(streamInfo.stream, saveOptions.seek || 0).catch((err) => {
					this.debug(`[Player] Error applying filters to save stream:`, err);
					return streamInfo!.stream; // Fallback to original stream
				});
			}

			// Return the stream directly - caller can pipe it to fs.createWriteStream()
			return finalStream;
		} catch (error) {
			this.debug(`[Player] save error:`, error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}

	/**
	 * Loop the current track or queue
	 *
	 * @param {LoopMode | number} mode - The loop mode to set ("off", "track", "queue") or number (0=off, 1=track, 2=queue)
	 * @returns {LoopMode} The loop mode
	 * @example
	 * const loopMode = player.loop("track"); // Loop current track
	 * const loopQueue = player.loop("queue"); // Loop entire queue
	 * const loopTrack = player.loop(1); // Loop current track (same as "track")
	 * const loopQueueNum = player.loop(2); // Loop entire queue (same as "queue")
	 * const noLoop = player.loop("off"); // No loop
	 * const noLoopNum = player.loop(0); // No loop (same as "off")
	 * console.log(`Loop mode: ${loopMode}`);
	 */
	loop(mode?: LoopMode | number): LoopMode {
		if (typeof mode === "number") {
			// Number mode: convert to text mode
			this.debug(`[Player] loop called with mode: ${mode}`);

			switch (mode) {
				case 0:
					return this.queue.loop("off");
				case 1:
					return this.queue.loop("track");
				case 2:
					return this.queue.loop("queue");
				default:
					this.debug(`[Player] Invalid loop number: ${mode}, using "off"`);
					return this.queue.loop("off");
			}
		}

		return this.queue.loop(mode as LoopMode);
	}

	/**
	 * Set the auto-play mode
	 *
	 * @param {boolean} mode - The auto-play mode to set
	 * @returns {boolean} The auto-play mode
	 * @example
	 * const autoPlayMode = player.autoPlay(true);
	 * console.log(`Auto-play mode: ${autoPlayMode}`);
	 */
	autoPlay(mode?: boolean): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			if (!mode) return this.forwardLeader?.autoPlay() ?? false;
			this.debug("[Player] Cannot autoPlay while subscribed to another player");
			return false;
		}
		return this.queue.autoPlay(mode);
	}

	/**
	 * Set the volume of the current track
	 *
	 * @param {number} volume - The volume to set
	 * @returns {boolean} True if volume was set successfully
	 * @example
	 * const volumeSet = player.setVolume(50);
	 * console.log(`Volume set: ${volumeSet}`);
	 */
	setVolume(volume: number): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot setVolume while subscribed to another player");
			return false;
		}
		this.debug(`[Player] setVolume called: ${volume}`);
		if (volume < 0 || volume > 200) return false;

		const oldVolume = this.volume;
		this.volume = volume;

		if (this.playbackMode === PlaybackMode.REMOTE) {
			void this.remoteHandle?.setVolume(volume).catch((e) => this.debug("[Player] Remote volume:", e));
			this.emit("volumeChange", oldVolume, volume);
			return true;
		}

		const resourceVolume = this.currentResource?.volume;

		if (resourceVolume) {
			if (this.volumeInterval) clearInterval(this.volumeInterval);

			const start = resourceVolume.volume;
			const target = this.volume / 100;
			const steps = 10;
			let currentStep = 0;

			this.volumeInterval = setInterval(() => {
				currentStep++;
				const value = start + ((target - start) * currentStep) / steps;
				resourceVolume.setVolume(value);
				if (currentStep >= steps) {
					clearInterval(this.volumeInterval!);
					this.volumeInterval = null;
				}
			}, 300);
		}

		this.emit("volumeChange", oldVolume, volume);
		for (const fp of this.forwardFollowers) {
			try {
				fp.volume = volume;
			} catch {}
		}
		return true;
	}

	/**
	 * Shuffle the queue
	 *
	 * @returns {void}
	 * @example
	 * player.shuffle();
	 */
	shuffle(): void {
		this.debug(`[Player] shuffle called`);
		this.queue.shuffle();
	}

	/**
	 * Clear the queue
	 *
	 * @returns {void}
	 * @example
	 * player.clearQueue();
	 */
	clearQueue(): void {
		this.debug(`[Player] clearQueue called`);
		this.queue.clear();
	}

	/**
	 * Insert a track or list of tracks into the upcoming queue at a specific position (0 = play after current).
	 * - If `query` is a string, performs a search and inserts resulting tracks (playlist supported).
	 * - If a Track or Track[] is provided, inserts directly.
	 * Does not auto-start playback; it only modifies the queue.
	 *
	 * @param {string | Track | Track[]} query - The track or tracks to insert
	 * @param {number} index - The index to insert the tracks at
	 * @param {string} requestedBy - The user ID who requested the insert
	 * @returns {Promise<boolean>} True if the tracks were inserted successfully
	 * @example
	 * const inserted = await player.insert("Song Name", 0, userId);
	 * console.log(`Inserted: ${inserted}`);
	 */
	async insert(query: string | Track | Track[], index: number, requestedBy?: string): Promise<boolean> {
		try {
			if (this.playbackMode === PlaybackMode.FORWARD) {
				this.debug("[Player] Cannot insert while subscribed to another player");
				return false;
			}
			this.debug(`[Player] insert called at index ${index} with type: ${typeof query}`);
			let tracksToAdd: Track[] = [];
			let isPlaylist = false;

			if (typeof query === "string") {
				const searchResult = await this.search(query, requestedBy || "Unknown");
				tracksToAdd = searchResult.tracks || [];
				isPlaylist = !!searchResult.playlist;
			} else if (Array.isArray(query)) {
				tracksToAdd = query;
				isPlaylist = query.length > 1;
			} else if (query) {
				tracksToAdd = [query];
			}

			if (!tracksToAdd || tracksToAdd.length === 0) {
				this.debug(`[Player] insert: no tracks resolved`);
				throw new Error("No tracks to insert");
			}

			if (tracksToAdd.length === 1) {
				this.queue.insert(tracksToAdd[0], index);
				this.emit("queueAdd", tracksToAdd[0]);
				this.debug(`[Player] Inserted track at index ${index}: ${tracksToAdd[0].title}`);
			} else {
				this.queue.insertMultiple(tracksToAdd, index);
				this.emit("queueAddList", tracksToAdd);
				this.debug(`[Player] Inserted ${tracksToAdd.length} ${isPlaylist ? "playlist " : ""}tracks at index ${index}`);
			}

			return true;
		} catch (error) {
			this.debug(`[Player] insert error:`, error);
			this.emit("playerError", error as Error);
			return false;
		}
	}

	/**
	 * Remove a track from the queue
	 *
	 * @param {number} index - The index of the track to remove
	 * @returns {Track | null} The removed track or null
	 * @example
	 * const removed = player.remove(0);
	 * console.log(`Removed: ${removed?.title}`);
	 */
	remove(index: number): Track | null {
		this.debug(`[Player] remove called for index: ${index}`);
		const track = this.queue.remove(index);
		if (track) {
			this.emit("queueRemove", track, index);
		}
		return track;
	}
	/**
	 * Get the progress bar of the current track
	 *
	 * @param {ProgressBarOptions} options - The options for the progress bar
	 * @returns {string} The progress bar
	 * @example
	 * const progressBar = player.getProgressBar();
	 * console.log(`Progress bar: ${progressBar}`);
	 *
	 * // Custom options
	 * const customBar = player.getProgressBar({
	 *   size: 30,
	 *   barChar: "─",
	 *   progressChar: "●",
	 *   timeFormat: "compact" // "compact" = 1:22:12, "full" = 01:22:12
	 * });
	 */
	getProgressBar(options: ProgressBarOptions = {}): string {
		const {
			size = 20,
			barChar = "▬",
			progressChar = "🔘",
			timeFormat = "compact", // "compact" or "full"
			showPercentage = false,
			showTime = true,
		} = options;

		const track = this.queue.currentTrack;
		const resource = this.currentResource;

		// Handle live stream
		if (this.isLive || !track || !resource) {
			if (this.isLive) return "🔴 LIVE";
			return "";
		}

		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		if (!total) return this.formatTimeCompact(resource.playbackDuration + this.seekOffset);

		const current = resource.playbackDuration + this.seekOffset;
		const ratio = Math.min(Math.max(current / total, 0), 1);
		const progress = Math.round(ratio * size);

		// Build progress bar
		let bar = "";
		if (progressChar === "none" || options.hideProgressChar) {
			// Continuous bar without separator
			const filled = barChar.repeat(progress);
			const empty = barChar.repeat(size - progress);
			bar = filled + empty;
		} else {
			// Bar with progress character
			const filled = barChar.repeat(progress);
			const empty = barChar.repeat(Math.max(0, size - progress));
			bar = filled + progressChar + empty;
		}

		// Format time based on option
		const formatTimeFn = timeFormat === "compact" ? this.formatTimeCompact.bind(this) : this.formatTime.bind(this);
		const currentTimeStr = formatTimeFn(current);
		const totalTimeStr = formatTimeFn(total);

		// Build result
		let result = "";
		if (showTime) {
			result = `${currentTimeStr} ${bar} ${totalTimeStr}`;
		} else {
			result = bar;
		}

		// Add percentage if requested
		if (showPercentage) {
			const percent = Math.round(ratio * 100);
			result += ` (${percent}%)`;
		}

		return result;
	}

	/**
	 * Format time with leading zeros (00:00 or 00:00:00)
	 * @param ms - Time in milliseconds
	 * @returns Formatted time string with leading zeros
	 */
	formatTime(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		const parts: string[] = [];
		if (hours > 0) parts.push(String(hours).padStart(2, "0"));
		parts.push(String(minutes).padStart(2, "0"));
		parts.push(String(seconds).padStart(2, "0"));
		return parts.join(":");
	}

	/**
	 * Format time without leading zeros for hours (1:22:12 or 3:45)
	 * @param ms - Time in milliseconds
	 * @returns Compact formatted time string
	 */
	formatTimeCompact(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (hours > 0) {
			return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
		}
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}

	/**
	 * Get the time of the current track
	 *
	 * @returns {Object} The time of the current track
	 * @example
	 * const time = player.getTime();
	 * console.log(`Time: ${time.current}`);
	 * console.log(`Formatted: ${time.formatted.current}`); // "1:22:12" or "3:45"
	 */
	getTime() {
		if (this.isLive)
			return {
				current: 0,
				total: 0,
				format: "LIVE",
				formatted: {
					current: "LIVE",
					total: "LIVE",
				},
			};

		const resource = this.currentResource;
		const track = this.queue.currentTrack;
		if (!track || !resource) {
			return {
				current: 0,
				total: 0,
				format: "00:00",
				formatted: {
					current: "00:00",
					total: "00:00",
				},
			};
		}

		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = resource.playbackDuration + this.seekOffset;

		return {
			current: current,
			total: total,
			format: this.formatTime(current),
			formatted: {
				current: this.formatTimeCompact(current),
				total: this.formatTimeCompact(total),
			},
		};
	}

	/**
	 * Destroy the player
	 *
	 * @returns {void}
	 * @example
	 * player.destroy();
	 */
	destroy(): void {
		this.debug(`[Player] destroy called`);
		if (this.destroyed) return;
		this.destroyed = true;

		if (this.remoteHandle?.destroy) {
			this.remoteHandle.destroy().catch(() => {});
			this.remoteHandle = undefined;
		}

		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
			this.leaveTimeout = null;
		}
		this.streamManager.destroyAll(true);
		// Destroy current stream before stopping audio
		this.destroyCurrentStream();

		this.clearSlot(this.currentSlot);
		this.preloadManager.clearPreloadSlot();

		this.audioPlayer.removeAllListeners();
		this.audioPlayer.stop(true);
		this.preloadManager.cancelPreload();

		if (this.ttsPlayer) {
			try {
				this.ttsPlayer.stop(true);
			} catch {}
			this.ttsPlayer = null;
		}

		if (this.connection) {
			this.connection.destroy();
			this.connection = null;
		}

		this.queue.clear();
		this.pluginManager.clear();
		this.filter.destroy();
		this.extensionManager.destroy();

		// Clear any remaining intervals
		if (this.volumeInterval) {
			clearInterval(this.volumeInterval);
			this.volumeInterval = null;
		}

		this.emit("playerDestroy");

		this.unsubscribeForward("Player destroy");

		// release followers
		for (const fp of [...this.forwardFollowers]) {
			try {
				fp.unsubscribeForward("Leader destroy");
			} catch {}
		}

		this.forwardFollowers.clear();
		this.removeAllListeners();
	}

	//#endregion
	//#region utils
	private scheduleLeave(): void {
		this.debug(`[Player] scheduleLeave called`);
		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
		}

		if (this.options.leaveOnEnd && this.options.leaveTimeout) {
			this.leaveTimeout = setTimeout(() => {
				this.debug(`[Player] Leaving voice channel after timeoutMs`);
				this.destroy();
			}, this.options.leaveTimeout);
		}
	}

	/**
	 * Refesh player resource (apply filter)
	 *
	 * @param {boolean} applyToCurrent - Apply filter for curent track
	 * @param {number} position - Position to seek to in milliseconds
	 * @returns {Promise<boolean>}
	 * @example
	 * const refreshed = await player.refreshPlayerResource(true, 1000);
	 * console.log(`Refreshed: ${refreshed}`);
	 */
	public async refreshPlayerResource(applyToCurrent: boolean = true, position: number = -1): Promise<boolean> {
		if (!applyToCurrent || !this.queue.currentTrack || !(this.isPlaying || this.isPaused)) {
			return false;
		}
		if (this.refreshLock) {
			this.debug(`[Player] refreshPlayerResource skipped — lock held`);
			return false;
		}

		// Lock before anything so stateChange idle sees it when stop() fires.
		this.refreshLock = true;

		// Clear any existing stuckTimer from the previous playback cycle so it
		// cannot fire while we are mid-refresh.
		if (this.stuckTimer) {
			clearTimeout(this.stuckTimer);
			this.stuckTimer = null;
		}

		try {
			const track = this.queue.currentTrack;
			this.debug(`[Player] Refreshing player resource for track: ${track.title}`);

			const currentPosition = position >= 0 ? position : (this.currentResource?.playbackDuration ?? 0);
			this.seekOffset = currentPosition;
			const wasPaused = this.isPaused;
			const playbackDuration = this.currentResource?.playbackDuration ?? 0;

			// Reuse is only viable for forward seeks (stream is sequential).
			const isForwardSeek = position < 0 || position >= playbackDuration;
			const currentStreamId = this.currentSlot.streamId;

			// Try to grab the live source stream for reuse.
			// getRawStream accepts "paused" streams (discordjs/voice pauses source streams on NoSubscriberBehavior); getStream would reject them.
			let reuseStream: Readable | null = null;
			if (isForwardSeek && currentStreamId) {
				reuseStream = this.streamManager.getRawStream(currentStreamId);
				if (reuseStream) {
					this.debug(`[Player] Will reuse source stream for seek (pos: ${currentPosition}ms)`);
				}
			}

			// ── CRITICAL: unpipe BEFORE stop ──────────────────────────────────────
			// stop() kills discordjs/voice internal FFmpeg → EPIPE on source stream.
			// unpipe() first disconnects our stream cleanly before that happens.
			if (reuseStream) {
				reuseStream.unpipe();
			}

			// Remove StreamManager listeners.
			// forceDestroy=false when reusing so the Readable object stays alive.
			if (currentStreamId) {
				this.streamManager.unregisterStream(currentStreamId, !reuseStream);
				this.currentSlot.streamId = null;
			}

			// Stop the AudioPlayer.
			// stateChange (playing→idle) fires; refreshLock=true guards it (v4 fix).
			this.audioPlayer.stop(true);
			this.currentResource = null;
			this.currentSlot.resource = null;
			this.currentSlot.isValid = false;

			// One event-loop tick: lets deferred stream events settle.
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Verify the reuse stream survived stop().
			if (reuseStream) {
				if (reuseStream.destroyed || (reuseStream as any).readable === false) {
					this.debug(`[Player] Source stream did not survive stop — falling back to fresh stream`);
					reuseStream = null;
				}
			}

			let streaminfo: StreamInfo | null = null;

			if (reuseStream) {
				streaminfo = { stream: reuseStream, type: "arbitrary" };
			} else {
				// Clear caches so we don't get the dead Readable back.
				this.pluginManager.clearStreamCache();
				this.extensionManager.clearCache("stream");
				this.debug(`[Player] Fetching fresh stream${!isForwardSeek ? " (backward seek)" : " (reuse failed)"}`);
				streaminfo = await this.getStream(track);
			}

			if (!streaminfo?.stream) {
				this.debug(`[Player] No stream available for refresh`);
				return false;
			}

			// Build AudioResource (input-side FFmpeg seek via FilterManager).
			const resource = await this.createResource(streaminfo, track, currentPosition);

			// Register the source stream.
			const newStreamId = this.streamManager.registerStream(streaminfo.stream, track, {
				source: track.source || "stream",
				isPreload: false,
				priority: 10,
			});
			this.currentSlot.resource = resource;
			this.currentSlot.track = track;
			this.currentSlot.streamId = newStreamId;
			this.currentSlot.isValid = true;
			this.currentResource = resource;

			// ── Set seek flag BEFORE play so the Buffering handler sees it ────────
			if (position >= 0) {
				this.seekInProgress = true;
			}

			if (this.connection) {
				this.connection.subscribe(this.audioPlayer);
				this.audioPlayer.play(resource);
			}
			if (wasPaused) this.audioPlayer.pause();

			this.debug(`[Player] Resource refreshed at position ${currentPosition}ms`);
			return true;
		} catch (error) {
			this.debug(`[Player] refreshPlayerResource error:`, error);
			this.seekInProgress = false; // ensure flag is cleared on failure
			this.emit("playerError", error as Error, this.queue.currentTrack ?? undefined);
			return false;
		} finally {
			this.refreshLock = false; // always released
		}
	}

	/**
	 * Attach an extension to the player
	 *
	 * @param {BaseExtension} extension - The extension to attach
	 * @example
	 * player.attachExtension(new MyExtension());
	 */
	public attachExtension(extension: BaseExtension): void {
		this.extensionManager.register(extension);
	}

	/**
	 * Detach an extension from the player
	 *
	 * @param {BaseExtension} extension - The extension to detach
	 * @example
	 * player.detachExtension(new MyExtension());
	 */
	public detachExtension(extension: BaseExtension): void {
		this.extensionManager.unregister(extension);
	}

	/**
	 * Get all extensions attached to the player
	 *
	 * @returns {readonly BaseExtension[]} All attached extensions
	 * @example
	 * const extensions = player.getExtensions();
	 * console.log(`Extensions: ${extensions.length}`);
	 */
	public getExtensions(): readonly BaseExtension[] {
		return this.extensionManager.getAll();
	}

	private clearLeaveTimeout(): void {
		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
			this.leaveTimeout = null;
			this.debug(`[Player] Cleared leave timeoutMs`);
		}
	}

	private debug(message?: any, ...optionalParams: any[]): void {
		if (this.listenerCount("debug") > 0) {
			this.emit("debug", message, ...optionalParams);
		}
	}

	private setupEventListeners(): void {
		this.audioPlayer.on("stateChange", (oldState, newState) => {
			if (this.destroyed) return;
			this.debug(`[Player] AudioPlayer stateChange from ${oldState.status} to ${newState.status}`);

			// ── Idle: track ended naturally ───────────────────────────────────────
			if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
				if (this.refreshLock) {
					this.debug(`[Player] AudioPlayer went idle during resource refresh — skipping trackEnd/playNext`);
					return;
				}
				// Track ended
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track ended: ${track.title}`);
					this.emit("trackEnd", track);
					for (const fp of this.forwardFollowers) {
						fp.emit("trackEnd", track);
					}
				}
				void this.playNext();
				// ── Playing: started or resumed ───────────────────────────────────────
			} else if (
				newState.status === AudioPlayerStatus.Playing &&
				(oldState.status === AudioPlayerStatus.Idle || oldState.status === AudioPlayerStatus.Buffering)
			) {
				// Track started
				this.clearLeaveTimeout();

				if (this.seekInProgress) {
					this.debug(`[Player] Seek complete — audio output started`);
					this.seekInProgress = false;
				}

				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track started: ${track.title}`);
					this.emit("trackStart", track);

					for (const fp of this.forwardFollowers) {
						try {
							fp.queue.clear();
							fp.connection?.subscribe(this.audioPlayer);
							fp.queue.setCurrentTrack(track);
							fp.emit("trackStart", track);
						} catch (e) {
							this.debug(`[Player] Failed to sync follower ${fp.guildId}:`, e);
						}
					}
				}
				// ── Paused ────────────────────────────────────────────────────────────
			} else if (newState.status === AudioPlayerStatus.Paused && oldState.status !== AudioPlayerStatus.Paused) {
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player paused on track: ${track.title}`);
					this.emit("playerPause", track);
					for (const fp of this.forwardFollowers) {
						fp.emit("playerPause", track);
					}
				}
				// ── Resumed from pause ────────────────────────────────────────────────
			} else if (newState.status !== AudioPlayerStatus.Paused && oldState.status === AudioPlayerStatus.Paused) {
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player resumed on track: ${track.title}`);
					this.emit("playerResume", track);
					for (const fp of this.forwardFollowers) {
						fp.emit("playerResume", track);
					}
				}
			} else if (newState.status === AudioPlayerStatus.AutoPaused) {
				this.debug(`[Player] AudioPlayerStatus.AutoPaused`);
				// ── Buffering: start stuck detector ───────────────────────────────────
			} else if (newState.status === AudioPlayerStatus.Buffering) {
				this.debug(`[Player] AudioPlayerStatus.Buffering`);

				if (this.seekInProgress) {
					this.debug(`[Player] Buffering during seek — stuckTimer suppressed`);
					return;
				}

				this.lastDuration = this.currentResource?.playbackDuration || 0;
				this.stuckTimer = setTimeout(() => {
					if (this.currentResource?.playbackDuration === this.lastDuration) {
						this.emit("trackStuck", this.currentTrack);
						const stuckTrack = this.currentTrack;
						if (stuckTrack && this.antiStuckEnabled) {
							void this.attemptTrackRecovery(stuckTrack, new Error("TRACK_STUCK")).then((recovered) => {
								if (!recovered) {
									this.skip();
								}
							});
							return;
						}
						this.skip();
					}
				}, 10000);
			} else {
				if (this.stuckTimer) {
					clearTimeout(this.stuckTimer);
					this.stuckTimer = null;
				}
			}
		});
		this.audioPlayer.on("error", (error) => {
			if (this.destroyed) return;
			this.debug(`[Player] AudioPlayer error:`, error);
			this.emit("playerError", error, this.queue.currentTrack || undefined);
			const track = this.queue.currentTrack;
			if (track && this.antiStuckEnabled) {
				void this.attemptTrackRecovery(track, error).then((recovered) => {
					if (!recovered) {
						void this.playNext();
					}
				});
				return;
			}
			void this.playNext();
		});

		this.audioPlayer.on("debug", (...args) => {
			if (this.manager.debugEnabled) {
				this.emit("debug", ...args);
			}
		});
		//stream Manager events

		this.streamManager.on("streamError", ({ streamId, error }) => {
			this.debug(`[StreamManager] Error for stream ${streamId}:`, error);
			this.emit("streamError", error, this.queue.currentTrack || null);
		});

		this.streamManager.on("streamRegistered", ({ streamId, track, metadata }) => {
			this.debug(`[StreamManager] Stream registered: ${track.title} (preload: ${metadata.isPreload})`);
		});

		this.streamManager.on("streamUnregistered", ({ streamId, track, reason }) => {
			this.debug(`[StreamManager] Stream unregistered: ${track.title} (reason: ${reason})`);
		});

		this.streamManager.on("debug", (...args) => {
			this.debug(...args);
		});
	}

	addPlugin(plugin: SourcePlugin): void {
		this.debug(`[Player] Adding plugin: ${plugin.name}`);
		this.pluginManager.register(plugin);
	}

	removePlugin(name: string): boolean {
		this.debug(`[Player] Removing plugin: ${name}`);
		return this.pluginManager.unregister(name);
	}
	/**
	 * Save the current session of the player, including queue, current track, position, volume, loop mode, auto-play mode, and active extensions/plugins.
	 *
	 * @returns {PlayerSession} The saved session data
	 */
	saveSession(): PlayerSession {
		return {
			guildId: this.guildId,
			currentTrack: this.currentTrack,
			position: this.currentResource?.playbackDuration || null,
			volume: this.volume,
			queue: this.queue.getTracks(),
			loopMode: this.queue.loop(),
			autoPlay: this.queue.autoPlay(),
			extensions: this.extensionManager.getAll().map((ext) => ext.name),
			plugins: this.pluginManager.getAll().map((plugin) => plugin.name),
		};
	}

	public exitRemoteMode(): void {
		if (this.playbackMode !== PlaybackMode.REMOTE) return;
		this.debug("[Player] Exiting REMOTE mode, restoring native playback");

		void this.remoteHandle?.destroy().catch(() => {});
		this.remoteHandle = undefined;
		this.playbackMode = PlaybackMode.NATIVE;
		this._remotePaused = false;

		// Restore preload/crossfade from original options
		const preloadOptions = this.options.preload ?? {};
		const autoDisable = preloadOptions.autoDisableInLowPerformance ?? true;
		this.preloadEnabled = (preloadOptions.enabled ?? true) && !(this.lowPerformanceMode && autoDisable);

		const crossfadeOptions = this.options.crossfade ?? {};
		const cfAutoDisable = crossfadeOptions.autoDisableInLowPerformance ?? true;
		this.crossfadeEnabled =
			typeof crossfadeOptions.enabled === "boolean" ? crossfadeOptions.enabled : (crossfadeOptions.autoEnable ?? true);
		if (this.lowPerformanceMode && cfAutoDisable) this.crossfadeEnabled = false;
	}

	/**
	 * Get serializable state (for manual persistence)
	 */
	getSerializableState(): object {
		return {
			guildId: this.guildId,
			queue: this.queue.getTracks(),
			currentTrack: this.currentTrack,
			volume: this.volume,
			isPlaying: this.isPlaying,
			isPaused: this.isPaused,
			loopMode: this.queue.loop(),
			autoPlay: this.queue.autoPlay(),
			filters: this.filter.getFilterString(),
			timestamp: Date.now(),
		};
	}

	/**
	 * Restore from saved state
	 */
	async restoreState(state: any): Promise<boolean> {
		try {
			if (state.volume) this.setVolume(state.volume);
			if (state.loopMode) this.queue.loop(state.loopMode);
			if (typeof state.autoPlay === "boolean") this.queue.autoPlay(state.autoPlay);
			if (state.filters) await this.filter.applyFilters(state.filters.split(","));

			// Restore queue
			if (state.queue && Array.isArray(state.queue)) {
				this.queue.clear();
				this.queue.addMultiple(state.queue);
			}

			this.debug("[Player] State restored");
			return true;
		} catch (error) {
			this.debug("[Player] Failed to restore state:", error);
			return false;
		}
	}

	/**
	 * Get stream manager stats
	 */
	getStreamManagerStats() {
		return {
			metrics: this.streamManager.getMetrics(),
			stats: this.streamManager.getStats(),
			totalStreams: this.streamManager.getStreamCount(),
		};
	}

	public getForwardHealthStatus(): ForwardHealthStatus {
		const issues: string[] = [];
		const details: any = {};

		if (this.playbackMode === PlaybackMode.FORWARD && this.forwardLeader) {
			// This player is a follower
			details.leaderId = this.forwardLeader.guildId;
			details.connectionState = this.connection?.state.status;
			details.audioPlayerState = this.audioPlayer.state.status;

			if (this.forwardLeader.destroyed) {
				issues.push("Leader is destroyed");
			}
			if (!this.forwardLeader.connection) {
				issues.push("Leader has no connection");
			}
			if (this.forwardLeader.destroyed || !this.forwardLeader.connection) {
				issues.push("Leader is unavailable");
			}

			return {
				guildId: this.guildId,
				healthy: issues.length === 0,
				role: "follower",
				issues,
				details,
			};
		} else if (this.forwardFollowers.size > 0) {
			// This player is a leader
			details.followerCount = this.forwardFollowers.size;
			details.connectionState = this.connection?.state.status;

			const deadFollowers: string[] = [];
			for (const follower of this.forwardFollowers) {
				if (follower.destroyed) deadFollowers.push(follower.guildId);
			}
			if (deadFollowers.length > 0) {
				issues.push(`Has ${deadFollowers.length} dead followers: ${deadFollowers.join(", ")}`);
			}

			return {
				guildId: this.guildId,
				healthy: true, // Leader being healthy doesn't depend on followers
				role: "leader",
				issues,
				details,
			};
		}

		return {
			guildId: this.guildId,
			healthy: true,
			role: "none",
			issues: [],
			details: {},
		};
	}

	//#endregion
	//#region Getters

	/**
	 * Get the size of the queue
	 *
	 * @returns {number} The size of the queue
	 * @example
	 * const queueSize = player.queueSize;
	 * console.log(`Queue size: ${queueSize}`);
	 */
	get queueSize(): number {
		return this.queue.size;
	}

	/**
	 * Get the current track
	 *
	 * @returns {Track | null} The current track or null
	 * @example
	 * const currentTrack = player.currentTrack;
	 * console.log(`Current track: ${currentTrack?.title}`);
	 */
	get currentTrack(): Track | null {
		return this.queue.currentTrack;
	}

	/**
	 * Get the previous track
	 *
	 * @returns {Track | null} The previous track or null
	 * @example
	 * const previousTrack = player.previousTrack;
	 * console.log(`Previous track: ${previousTrack?.title}`);
	 */
	get previousTrack(): Track | null {
		return this.queue.previousTracks?.at(-1) ?? null;
	}

	/**
	 * Get the upcoming tracks
	 *
	 * @returns {Track[]} The upcoming tracks
	 * @example
	 * const upcomingTracks = player.upcomingTracks;
	 * console.log(`Upcoming tracks: ${upcomingTracks.length}`);
	 */
	get upcomingTracks(): Track[] {
		return this.queue.getTracks();
	}

	/**
	 * Get the previous tracks
	 *
	 * @returns {Track[]} The previous tracks
	 * @example
	 * const previousTracks = player.previousTracks;
	 * console.log(`Previous tracks: ${previousTracks.length}`);
	 */
	get previousTracks(): Track[] {
		return this.queue.previousTracks;
	}

	/**
	 * Get the available plugins
	 *
	 * @returns {string[]} The available plugins
	 * @example
	 * const availablePlugins = player.availablePlugins;
	 * console.log(`Available plugins: ${availablePlugins.length}`);
	 */
	get availablePlugins(): string[] {
		return this.pluginManager.getAll().map((p) => p.name);
	}

	/**
	 * Get the related tracks
	 *
	 * @returns {Track[] | null} The related tracks or null
	 * @example
	 * const relatedTracks = player.relatedTracks;
	 * console.log(`Related tracks: ${relatedTracks?.length}`);
	 */
	get relatedTracks(): Track[] | null {
		return this.queue.relatedTracks();
	}

	get isLive(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return true; //forward Mode -> live from Leader

		return this.currentTrack?.isLive === true;
	}

	public get isPlaying(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			if (!this.forwardLeader || this.forwardLeader.destroyed) {
				this.unsubscribeForward("Leader destroyed");
				return false;
			}
			return this.forwardLeader.isPlaying;
		}
		if (this.playbackMode === PlaybackMode.REMOTE) {
			return !!this.queue.currentTrack; // driven by queue state, not audioPlayer
		}

		return (
			this.audioPlayer.state.status === AudioPlayerStatus.Playing || this.audioPlayer.state.status === AudioPlayerStatus.Buffering
		);
	}

	public get isPaused(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			return this.forwardLeader?.isPaused ?? false;
		}
		if (this.playbackMode === PlaybackMode.REMOTE) {
			// Extension tracks pause state via handle; Player exposes a flag
			return this._remotePaused;
		}
		return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
	}

	public get isIdle(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			return this.forwardLeader?.isIdle ?? false;
		}
		return this.audioPlayer.state.status === AudioPlayerStatus.Idle;
	}

	public get isBuffering(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			return this.forwardLeader?.isBuffering ?? false;
		}
		return this.audioPlayer.state.status === AudioPlayerStatus.Buffering;
	}
	//#endregion
}
