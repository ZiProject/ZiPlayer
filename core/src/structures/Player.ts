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
	public currentResource: AudioResource | null = null;

	public manager: PlayerManager;
	public pluginManager: PluginManager;
	public extensionManager: ExtensionManager;
	public streamManager: StreamManager;
	public preloadManager: PreloadManager;
	public filter!: FilterManager;

	public forwardMode: Boolean = false;
	public playbackFollowers = new Set<Player>();
	public playbackLeader: Player | null = null;
	private playbackSyncVolume: boolean = true;

	private leaveTimeout: NodeJS.Timeout | null = null;
	private volumeInterval: NodeJS.Timeout | null = null;
	private stuckTimer: NodeJS.Timeout | null = null;

	private skipLoop = false;
	private refreshLock = false;

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
	private destroyed = false;
	private readonly trackMiddlewareChain: TrackMiddleware[];

	// Cache for search results to avoid duplicate calls
	private searchCache: LRUCache<string, SearchResult>;
	private readonly SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
	private ttsPlayer: DiscordAudioPlayer | null = null;
	private lastDuration: number = 0;

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
			getNextTrack: () => this.queue.nextTrack,
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

		this.debug(`[Player] Creating AudioResource with filters: ${filterString || "none"}, seek: ${position}ms`);

		try {
			let stream: Readable = streamInfo.stream;
			// Apply filters and seek if needed
			if (filterString || position > 0) {
				stream = await this.filter.applyFiltersAndSeek(streamInfo.stream, position);
				streamInfo.type = StreamType.Arbitrary;
			}

			// Create AudioResource with better error handling
			const resource = createAudioResource(stream, {
				metadata: track,
				inputType:
					streamInfo.type === "webm/opus" ? StreamType.WebmOpus
					: streamInfo.type === "ogg/opus" ? StreamType.OggOpus
					: StreamType.Arbitrary,
				inlineVolume: true,
			});

			return resource;
		} catch (error) {
			this.debug(`[Player] Error creating AudioResource with filters+seek:`, error);
			// Fallback to basic AudioResource
			try {
				const resource = createAudioResource(streamInfo.stream, {
					metadata: track,
					inputType:
						streamInfo.type === "webm/opus" ? StreamType.WebmOpus
						: streamInfo.type === "ogg/opus" ? StreamType.OggOpus
						: StreamType.Arbitrary,
					inlineVolume: true,
				});
				return resource;
			} catch (fallbackError) {
				this.debug(`[Player] Fallback AudioResource creation failed:`, fallbackError);
				throw fallbackError;
			}
		}
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

		if (existingStream && !existingStream.destroyed) {
			this.debug(`[Stream] Using existing stream from manager for: ${track.title}`);
			return { stream: existingStream, type: "arbitrary" };
		}

		let stream = await this.extensionManager.provideStream(track);
		if (this.destroyed) {
			if (stream?.stream && typeof stream.stream.destroy === "function" && !stream.stream.destroyed) {
				stream.stream.destroy();
			}
			throw new Error("PLAYER_DESTROYED");
		}
		if (stream?.stream) {
			this.debug(`[Stream] Extension provided stream for: ${track.title}`);
			return stream;
		}

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
			// Register with StreamManager
			this.debug(`[Stream] Plugin provided stream for: ${track.title}`);
			return stream;
		}

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
		try {
			// Try to use preloaded resource
			if (this.preloadManager.hasValidPreload(track)) {
				this.debug(`[Player] Using preloaded stream for: ${track.title}`);

				// Stop current playback
				this.audioPlayer.stop(true);

				// Clean up old current stream (but delay to be safe)
				const oldStreamId = this.currentSlot.streamId;
				if (oldStreamId && this.streamManager) {
					setTimeout(() => {
						if (this.currentSlot.streamId === oldStreamId) {
							this.streamManager.unregisterStream(oldStreamId, true);
						}
					}, 3000);
				}

				// Set current slot from preload
				this.promotePreloadToCurrent(track);
				const currentResource = this.currentSlot.resource;
				if (!currentResource) {
					return false;
				}
				const targetVolume = this.getTrackTargetVolume(track);

				// Apply volume
				if (currentResource.volume) {
					currentResource.volume.setVolume(this.crossfadeEnabled ? 0 : targetVolume);
				}

				// Play
				await this.maybeAlignToBeatBoundary();
				this.audioPlayer.play(currentResource);
				await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
				await this.applyCrossfadeIn(currentResource, track);

				// Start preloading next track (async, don't await)
				this.preloadNextTrack().catch((err) => {
					this.debug(`[Player] Preload error:`, err);
				});

				return true;
			}

			// No valid preload, load fresh
			this.debug(`[Player] No preload available, loading fresh: ${track.title}`);
			return await this.loadFreshStream(track);
		} catch (error) {
			this.debug(`[Player] startTrack error:`, error);
			this.emit("playerError", error as Error, track);
			return false;
		}
	}

	/**
	 * Swap preload slot to current slot
	 */
	private async swapToCurrent(track: Track): Promise<boolean> {
		if (!this.preloadManager.hasValidPreload(track)) {
			return false;
		}
		const oldStreamId = this.currentSlot.streamId;

		// Stop current playback
		this.audioPlayer.stop(true);

		// Clean up old current stream (but keep it for a moment)
		if (oldStreamId && this.streamManager) {
			// Delay cleanup to avoid destroying if still needed
			setTimeout(() => {
				if (this.currentSlot.streamId === oldStreamId) {
					this.streamManager.unregisterStream(oldStreamId, true);
				}
			}, 5000);
		}

		// Set new current
		this.promotePreloadToCurrent(track);
		const currentResource = this.currentSlot.resource;
		if (!currentResource) {
			return false;
		}
		const targetVolume = this.getTrackTargetVolume(track);

		// Apply volume
		if (currentResource.volume) {
			currentResource.volume.setVolume(this.crossfadeEnabled ? 0 : targetVolume);
		}

		// Play
		await this.maybeAlignToBeatBoundary();
		this.audioPlayer.play(currentResource);

		try {
			await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
			await this.applyCrossfadeIn(currentResource, track);

			// Start preloading next track
			this.preloadNextTrack().catch((err) => {
				this.debug(`[Player] Preload error:`, err);
			});

			return true;
		} catch (err) {
			this.debug(`[Player] Failed to play swapped track:`, err);
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

			if (!streamInfo?.stream) {
				throw new Error(`No stream available`);
			}

			// Register with StreamManager
			const streamId = this.streamManager.registerStream(streamInfo.stream, track, {
				source: track.source || "stream",
				isPreload: false,
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

			// Apply volume
			const targetVolume = this.getTrackTargetVolume(track);
			if (resource.volume) {
				resource.volume.setVolume(this.crossfadeEnabled ? 0 : targetVolume);
			}

			// Play
			await this.maybeAlignToBeatBoundary();
			this.audioPlayer.stop(true);
			this.audioPlayer.play(resource);
			await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
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
	private async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
		this.debug("[Player] playNext called");

		// Don't cancel preload here unless absolutely necessary
		// Let startTrack handle it

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
				const recovered = await this.attemptTrackRecovery(track, new Error("TRACK_START_RETURNED_FALSE"));
				if (recovered) {
					return true;
				}
				if (this.antiStuckEnabled && this.antiStuckConsecutiveFailures < this.antiStuckControlledSkipThreshold) {
					this.queue.insert(track, 0);
					if (this.antiStuckRetryDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, this.antiStuckRetryDelayMs));
					}
				}
			} catch (err) {
				this.debug(`[Player] playNext error:`, err);
				this.emit("playerError", err as Error, track);
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
				}
				continue;
			}
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
	async connect(channel: VoiceChannel): Promise<VoiceConnection> {
		try {
			this.debug(`[Player] Connecting to voice channel: ${channel.id}`);
			const connection = joinVoiceChannel({
				channelId: channel.id,
				guildId: channel.guildId,
				adapterCreator: channel.guild.voiceAdapterCreator as any,
				selfDeaf: this.options.selfDeaf ?? true,
				selfMute: this.options.selfMute ?? false,
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
	 * @param options.forwardMode When true, the follower voice connection directly subscribes to the leader audioPlayer. Default: true.
	 *
	 * @returns {boolean} True if subscription succeeded.
	 *
	 * @example
	 * follower.subscribeTo(leader);
	 *
	 * @example
	 * follower.subscribeTo(leader, {
	 *   syncVolume: true,
	 *   forwardMode: true
	 * });
	 */
	public subscribeTo(
		leader: Player,
		options?: {
			syncVolume?: boolean;
			forwardMode?: boolean;
		},
	): boolean {
		if (!leader) return false;

		if (leader === this) {
			this.debug(`[Player] Cannot subscribe to self`);
			return false;
		}

		if (!this.connection || !leader.connection) {
			this.debug(`[Player] Missing connection for subscribeTo`);
			return false;
		}

		// cleanup old leader
		if (this.playbackLeader) {
			this.unsubscribePlayback();
		}

		this.playbackLeader = leader;

		this.forwardMode = options?.forwardMode ?? true;

		this.playbackSyncVolume = options?.syncVolume ?? true;

		leader.playbackFollowers.add(this);

		try {
			// clear local playback
			this.stop();

			this.queue.clear();

			if (leader.currentTrack) {
				this.queue.setCurrentTrack(leader.currentTrack);
			}

			if (this.forwardMode) {
				this.connection.subscribe(leader.audioPlayer);
			}

			// sync state
			if (this.playbackSyncVolume) {
				this.setVolume(leader.volume);
			}

			this.emit("forwardModeStart", leader);

			this.debug(`[Player] Forward mode subscribed ${this.guildId} -> ${leader.guildId}`);

			return true;
		} catch (e) {
			this.debug(`[Player] subscribeTo error:`, e);

			this.playbackLeader = null;

			leader.playbackFollowers.delete(this);

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
	 * follower.unsubscribePlayback();
	 */
	public unsubscribePlayback(): boolean {
		if (!this.playbackLeader) {
			return false;
		}

		const leader = this.playbackLeader;

		leader.playbackFollowers.delete(this);

		this.playbackLeader = null;

		this.forwardMode = false;

		try {
			this.connection?.subscribe(this.audioPlayer);
		} catch {}

		this.emit("forwardModeEnd", leader);

		this.debug(`[Player] Forward mode unsubscribed ${this.guildId} <- ${leader.guildId}`);

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
		this.debug(`[Player] pause called`);
		if (this.isPlaying && !this.isPaused) {
			return this.audioPlayer.pause();
		}
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
		this.debug(`[Player] resume called`);
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
		this.debug(`[Player] stop called`);

		// Cancel preload when stopping
		this.cancelPreload();

		this.queue.clear();
		const result = this.audioPlayer.stop();
		this.destroyCurrentStream();
		this.currentResource = null;

		this.emit("playerStop");
		for (const fp of this.playbackFollowers) {
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
		this.debug(`[Player] seek called with position: ${position}ms`);

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

		await this.refreshPlayerResource(true, position);

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
		this.debug(`[Player] skip called with index: ${index}`);

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
		this.debug(`[Player] loop called with mode: ${mode}`);

		if (typeof mode === "number") {
			// Number mode: convert to text mode
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
		this.debug(`[Player] setVolume called: ${volume}`);
		if (volume < 0 || volume > 200) return false;

		const oldVolume = this.volume;
		this.volume = volume;
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
		for (const fp of this.playbackFollowers) {
			if (!fp.playbackSyncVolume) continue;

			try {
				fp.setVolume(volume);
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
		if (!total) return this.formatTimeCompact(resource.playbackDuration);

		const current = resource.playbackDuration;
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
		const current = resource.playbackDuration;

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
		this.unsubscribePlayback();

		// release followers
		for (const fp of [...this.playbackFollowers]) {
			try {
				fp.unsubscribePlayback();
			} catch {}
		}

		this.playbackFollowers.clear();
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
		if (this.refreshLock) return false;
		this.refreshLock = true;
		try {
			const track = this.queue.currentTrack;
			this.debug(`[Player] Refreshing player resource for track: ${track.title}`);

			// Get current position for seeking
			const currentPosition = position > 0 ? position : this.currentResource?.playbackDuration || 0;

			const streaminfo = await this.getStream(track);
			if (!streaminfo?.stream) {
				this.debug(`[Player] No stream to refresh`);
				return false;
			}

			// Create AudioResource with filters and seek to current position
			const resource = await this.createResource(streaminfo, track, currentPosition);

			// Stop current playback and destroy old resource/stream
			const wasPlaying = this.isPlaying;
			const wasPaused = this.isPaused;

			this.audioPlayer.stop();

			// Properly destroy the old resource and stream
			try {
				if (this.currentResource) {
					const oldStream = (this.currentResource as any)._readableState?.stream || (this.currentResource as any).stream;
					if (oldStream && typeof oldStream.destroy === "function") {
						oldStream.destroy();
					}
				}
			} catch (error) {
				this.debug(`[Player] Error destroying old stream in refreshPlayerResource:`, error);
			} finally {
				this.refreshLock = false;
			}

			this.currentResource = resource;

			// Subscribe to new resource
			if (this.connection) {
				this.connection.subscribe(this.audioPlayer);
				this.audioPlayer.play(resource);
			}

			// Restore playing state
			if (wasPaused) {
				this.audioPlayer.pause();
			}

			this.debug(`[Player] Successfully applied filter to current track at position ${currentPosition}ms`);
			return true;
		} catch (error) {
			this.debug(`[Player] Error applying filter to current track:`, error);
			// Filter was still added to active filters, so return true
			return true;
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
			if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
				// Track ended
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track ended: ${track.title}`);
					this.emit("trackEnd", track);
				}
				void this.playNext();
			} else if (
				newState.status === AudioPlayerStatus.Playing &&
				(oldState.status === AudioPlayerStatus.Idle || oldState.status === AudioPlayerStatus.Buffering)
			) {
				// Track started
				this.clearLeaveTimeout();
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track started: ${track.title}`);
					this.emit("trackStart", track);

					for (const fp of this.playbackFollowers) {
						try {
							fp.queue.clear();

							fp.queue.setCurrentTrack(track);

							fp.emit("trackStart", track);
						} catch (e) {
							this.debug(`[Player] Failed to sync follower ${fp.guildId}:`, e);
						}
					}
				}
			} else if (newState.status === AudioPlayerStatus.Paused && oldState.status !== AudioPlayerStatus.Paused) {
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player paused on track: ${track.title}`);
					this.emit("playerPause", track);
					for (const fp of this.playbackFollowers) {
						fp.emit("playerPause", track);
					}
				}
			} else if (newState.status !== AudioPlayerStatus.Paused && oldState.status === AudioPlayerStatus.Paused) {
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player resumed on track: ${track.title}`);
					this.emit("playerResume", track);
					for (const fp of this.playbackFollowers) {
						fp.emit("playerResume", track);
					}
				}
			} else if (newState.status === AudioPlayerStatus.AutoPaused) {
				this.debug(`[Player] AudioPlayerStatus.AutoPaused`);
			} else if (newState.status === AudioPlayerStatus.Buffering) {
				this.debug(`[Player] AudioPlayerStatus.Buffering`);
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
		return this.currentTrack?.isLive === true;
	}

	public get isPlaying(): boolean {
		return (
			this.audioPlayer.state.status === AudioPlayerStatus.Playing || this.audioPlayer.state.status === AudioPlayerStatus.Buffering
		);
	}

	public get isPaused(): boolean {
		return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
	}

	public get isIdle(): boolean {
		return this.audioPlayer.state.status === AudioPlayerStatus.Idle;
	}

	public get isBuffering(): boolean {
		return this.audioPlayer.state.status === AudioPlayerStatus.Buffering;
	}
	//#endregion
}
