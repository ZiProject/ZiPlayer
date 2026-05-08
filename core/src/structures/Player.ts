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
import type {
	Track,
	PlayerOptions,
	PlayerEvents,
	SourcePlugin,
	SearchResult,
	ProgressBarOptions,
	LoopMode,
	StreamInfo,
	SaveOptions,
	VoiceChannel,
	PlayerSession,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
	PreloadState,
	StreamSlot,
} from "../types";
import type { PlayerManager } from "./PlayerManager";

import { Queue } from "./Queue";
import { PluginManager } from "../plugins";
import { ExtensionManager } from "../extensions";
import { withTimeout } from "../utils/timeout";
import { FilterManager } from "./FilterManager";
import { StreamManager } from "./StreamManager";

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
	public isPlaying: boolean = false;
	public isPaused: boolean = false;
	public options: PlayerOptions;
	public pluginManager: PluginManager;
	public extensionManager: ExtensionManager;
	public streamManager: StreamManager;

	public userdata?: Record<string, any>;
	public _lastActivity: number = Date.now();
	private manager: PlayerManager;
	private leaveTimeout: NodeJS.Timeout | null = null;
	private currentResource: AudioResource | null = null;
	private volumeInterval: NodeJS.Timeout | null = null;
	private stuckTimer: NodeJS.Timeout | null = null;

	private skipLoop = false;
	private filter!: FilterManager;
	private refreshLock = false;
	//preloaded resource

	private preloadState: PreloadState = {
		resource: null,
		track: null,
		abortController: null,
		timeoutId: null,
		isValid: false,
		isBeingUsed: false,
	};
	private isPreloading = false;
	private currentSlot: StreamSlot = {
		resource: null,
		track: null,
		streamId: null,
		abortController: null,
		isValid: false,
		isLoading: false,
		loadPromise: null,
	};

	private preloadSlot: StreamSlot = {
		resource: null,
		track: null,
		streamId: null,
		abortController: null,
		isValid: false,
		isLoading: false,
		loadPromise: null,
	};
	private preloadQueue: Track | null = null;
	private preloadLock = false;
	private isLoadingNext = false;

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
		this.filter = new FilterManager(this, this.manager);
		this.extensionManager = new ExtensionManager(this, this.manager);
		this.pluginManager = new PluginManager(this, this.manager, {
			extractorTimeout: this.options.extractorTimeout,
		});
		this.streamManager = new StreamManager({
			maxConcurrentStreams: 20,
			streamTimeout: 5 * 60 * 1000,
			maxListenersPerStream: 15,
			enableMetrics: true,
			autoDestroy: true,
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
		// Prevent concurrent preloads
		if (this.preloadLock) {
			this.debug(`[Preload] Already preloading, skipping`);
			return;
		}

		const nextTrack = this.queue.nextTrack;
		if (!nextTrack) {
			this.debug(`[Preload] No next track to preload`);
			return;
		}

		// Check if already preloaded correctly
		if (this.preloadSlot.isValid && this.preloadSlot.track?.id === nextTrack.id && this.preloadSlot.resource) {
			this.debug(`[Preload] Already have valid preload for: ${nextTrack.title}`);
			return;
		}

		// Check if currently loading the same track
		if (this.preloadSlot.isLoading && this.preloadSlot.track?.id === nextTrack.id) {
			this.debug(`[Preload] Currently loading same track, waiting...`);
			if (this.preloadSlot.loadPromise) {
				await this.preloadSlot.loadPromise;
			}
			return;
		}

		// Cancel old preload if different track
		if (this.preloadSlot.isValid && this.preloadSlot.track?.id !== nextTrack.id) {
			this.debug(`[Preload] Cancelling old preload for different track: ${this.preloadSlot.track?.title}`);
			await this.safeCancelPreload();
		}

		this.preloadLock = true;

		// Create new abort controller
		const abortController = new AbortController();

		// Setup preload slot
		this.preloadSlot.track = nextTrack;
		this.preloadSlot.abortController = abortController;
		this.preloadSlot.isLoading = true;

		// Create load promise
		const loadPromise = this.executePreload(nextTrack, abortController);
		this.preloadSlot.loadPromise = loadPromise;

		try {
			await loadPromise;
		} catch (err) {
			if (err instanceof Error && err.message === "PRELOAD_CANCELLED") {
				this.debug(`[Preload] Cancelled for ${nextTrack.title}`);
			} else {
				this.debug(`[Preload] Failed for ${nextTrack.title}:`, err);
			}
			this.clearSlot(this.preloadSlot);
		} finally {
			this.preloadLock = false;
			this.preloadSlot.isLoading = false;
			this.preloadSlot.loadPromise = null;
		}
	}

	/**
	 * Execute actual preload
	 */
	private async executePreload(track: Track, abortController: AbortController): Promise<void> {
		this.debug(`[Preload] Starting preload for: ${track.title}`);

		// Check for cancellation
		if (abortController.signal.aborted) {
			throw new Error("PRELOAD_CANCELLED");
		}

		// Check if track still relevant
		if (this.queue.nextTrack?.id !== track.id) {
			this.debug(`[Preload] Track changed, cancelling`);
			throw new Error("PRELOAD_CANCELLED");
		}

		try {
			// Get stream with abort support - NO TIMEOUT
			const streamInfo = await this.getStreamWithCancel(track, abortController.signal);

			// Check cancellation
			if (abortController.signal.aborted) {
				throw new Error("PRELOAD_CANCELLED");
			}

			// Check track relevance again
			if (this.queue.nextTrack?.id !== track.id) {
				this.debug(`[Preload] Track changed after stream fetch`);
				throw new Error("PRELOAD_CANCELLED");
			}

			if (!streamInfo?.stream) {
				throw new Error(`No stream available`);
			}

			// Register with StreamManager as preload
			const streamId = this.streamManager.registerStream(streamInfo.stream, track, {
				source: track.source || "preload",
				isPreload: true,
				priority: 5,
			});

			// Create resource
			const resource = createAudioResource(streamInfo.stream, {
				inlineVolume: true,
				metadata: { ...track, preloaded: true },
			});

			// Verify resource is valid
			if (!resource.playStream || resource.playStream.readable === false) {
				throw new Error("Resource not readable");
			}

			// Update preload slot
			this.preloadSlot.resource = resource;
			this.preloadSlot.streamId = streamId;
			this.preloadSlot.isValid = true;
			this.preloadSlot.track = track;

			this.debug(`[Preload] Successfully preloaded: ${track.title} (Stream ID: ${streamId})`);
		} catch (err) {
			if (err instanceof Error && err.message === "PRELOAD_CANCELLED") {
				throw err;
			}
			this.debug(`[Preload] Error during preload:`, err);
			throw err;
		}
	}

	/**
	 * Safe cancel preload - doesn't throw
	 */
	private async safeCancelPreload(): Promise<void> {
		if (!this.preloadSlot.abortController && !this.preloadSlot.resource) {
			return;
		}

		this.debug(`[Preload] Safely cancelling preload for: ${this.preloadSlot.track?.title || "unknown"}`);

		// Abort the operation
		if (this.preloadSlot.abortController) {
			this.preloadSlot.abortController.abort();
			this.preloadSlot.abortController = null;
		}

		// Clean up stream
		if (this.preloadSlot.streamId && this.streamManager) {
			this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		}

		// Clean up resource
		if (this.preloadSlot.resource) {
			try {
				const stream = this.preloadSlot.resource.playStream;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) {
					stream.destroy();
				}
			} catch (err) {
				// Ignore destroy errors
			}
		}

		// Clear slot
		this.clearSlot(this.preloadSlot);
	}

	/**
	 * Get stream with proper cancellation
	 */
	private async getStreamWithCancel(track: Track, signal: AbortSignal): Promise<StreamInfo | null> {
		// Create abort promise
		const abortPromise = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(new Error("PRELOAD_CANCELLED"));
				return;
			}
			const handler = () => {
				signal.removeEventListener("abort", handler);
				reject(new Error("PRELOAD_CANCELLED"));
			};
			signal.addEventListener("abort", handler);
		});

		try {
			// Check if stream already exists and is valid
			const existingStream = this.streamManager.getStreamByTrack(track.id || track.title);
			if (existingStream && !existingStream.destroyed && existingStream.readable !== false) {
				this.debug(`[Stream] Using existing stream for preload: ${track.title}`);
				return { stream: existingStream, type: "arbitrary" };
			}

			// Race between stream fetch and abort
			const streamPromise = this.getStream(track);
			const result = await Promise.race([streamPromise, abortPromise]);
			return result as StreamInfo | null;
		} catch (err) {
			if (err instanceof Error && err.message === "PRELOAD_CANCELLED") {
				throw err;
			}
			throw err;
		}
	}
	/**
	 * Preload next track with proper error handling and cleanup
	 */
	async preloadNext(): Promise<void> {
		this.cancelPreload();

		const next = this.queue.nextTrack;
		if (!next || this.isPreloading) {
			this.debug(`[Preload] Skipped - ${!next ? "no next track" : "already preloading"}`);
			return;
		}

		this.isPreloading = true;

		// Create new AbortController
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => {
			// this.debug(`[Preload] Timeout for track: ${next.title}`);
			// abortController.abort();
		}, 30000);

		this.preloadState.abortController = abortController;
		this.preloadState.timeoutId = timeoutId;

		try {
			this.debug(`[Preload] Starting preload for: ${next.title}`);

			// Check if already aborted
			if (abortController.signal.aborted) {
				throw new Error("Preload aborted before start");
			}

			// Check if this track is still the next one
			if (this.queue.nextTrack?.id !== next.id) {
				this.debug(`[Preload] Track changed, cancelling preload`);
				return;
			}

			const streamInfo = await this.getStreamWithCancel(next, abortController.signal);

			// Double check
			if (abortController.signal.aborted) {
				throw new Error("Preload aborted after stream fetch");
			}

			if (this.queue.nextTrack?.id !== next.id) {
				this.debug(`[Preload] Track changed after stream fetch`);
				return;
			}

			if (!streamInfo?.stream) {
				throw new Error(`No stream available`);
			}

			// Register with StreamManager
			const streamId = this.streamManager.registerStream(streamInfo.stream, next, {
				source: next.source || "preload",
				isPreload: true,
				priority: 8,
			});

			// Create resource
			const resource = createAudioResource(streamInfo.stream, {
				inlineVolume: true,
				metadata: { ...next, preloaded: true },
			});

			// Store preload state
			this.preloadState = {
				resource,
				track: next,
				abortController,
				timeoutId,
				isValid: true,
				isBeingUsed: false,
				streamId,
			};

			this.debug(`[Preload] Successfully preloaded: ${next.title} (Stream ID: ${streamId})`);
		} catch (err) {
			if (err instanceof Error && err.message.includes("aborted")) {
				this.debug(`[Preload] Cancelled for ${next.title}`);
			} else {
				this.debug(`[Preload] Failed for ${next?.title}:`, err);
			}
			this.cancelPreload();
		} finally {
			this.isPreloading = false;
		}
	}

	/**
	 * Clear preloaded resource with proper cleanup
	 */
	private clearPreload(): void {
		// Abort ongoing preload
		if (this.preloadState.abortController) {
			this.preloadState.abortController.abort();
			this.preloadState.abortController = null;
		}

		// Clean up stream
		const stream = (this.preloadState as any).stream;
		if (stream && typeof stream.destroy === "function") {
			try {
				stream.destroy();
			} catch (err) {
				this.debug(`[Preload] Error destroying stream:`, err);
			}
		}

		// Clean up resource
		if (this.preloadState.resource) {
			try {
				const playStream = this.preloadState.resource.playStream;
				if (playStream && typeof playStream.destroy === "function") {
					playStream.destroy();
				}
			} catch (err) {
				this.debug(`[Preload] Error destroying resource:`, err);
			}
		}

		this.preloadState = {
			resource: null,
			track: null,
			abortController: null,
			timeoutId: null,
			isValid: false,
			isBeingUsed: false,
			streamId: undefined,
		};
	}

	/**
	 * Cancel preload (when skipping or stopping)
	 */
	private cancelPreload(): void {
		if (this.preloadSlot.abortController) {
			this.debug(`[Preload] Cancelling preload for: ${this.preloadSlot.track?.title}`);
			this.preloadSlot.abortController.abort();
		}

		if (this.preloadSlot.streamId && this.streamManager) {
			this.streamManager.unregisterStream(this.preloadSlot.streamId, true);
		}

		this.clearSlot(this.preloadSlot);
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
		const promotedResource = this.preloadSlot.resource;
		const promotedStreamId = this.preloadSlot.streamId;

		// Move ownership to current slot.
		this.currentSlot.resource = promotedResource;
		this.currentSlot.track = track;
		this.currentSlot.streamId = promotedStreamId;
		this.currentSlot.abortController = null;
		this.currentSlot.isValid = !!promotedResource;
		this.currentSlot.isLoading = false;
		this.currentSlot.loadPromise = null;
		this.currentResource = promotedResource;

		// Reset preload slot only (do not destroy promoted resource/stream).
		this.preloadSlot.resource = null;
		this.preloadSlot.track = null;
		this.preloadSlot.streamId = null;
		this.preloadSlot.abortController = null;
		this.preloadSlot.isValid = false;
		this.preloadSlot.isLoading = false;
		this.preloadSlot.loadPromise = null;
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

	private async getStream(track: Track): Promise<StreamInfo | null> {
		const trackId = track.id || track.url || track.title;
		const existingStream = this.streamManager.getStreamByTrack(trackId);

		if (existingStream && !existingStream.destroyed) {
			this.debug(`[Stream] Using existing stream from manager for: ${track.title}`);
			return { stream: existingStream, type: "arbitrary" };
		}

		let stream = await this.extensionManager.provideStream(track);
		if (stream?.stream) {
			// Register with StreamManager
			const streamId = this.streamManager.registerStream(stream.stream, track, {
				source: "extension",
				isPreload: false,
				priority: 10,
			});
			this.debug(`[Stream] Extension stream registered with ID: ${streamId}`);
			return stream;
		}

		stream = await this.pluginManager.getStream(track);
		if (stream?.stream) {
			const existingAgain = this.streamManager.getStreamByTrack(trackId);
			if (existingAgain && !existingAgain.destroyed) {
				if (stream.stream.destroy) stream.stream.destroy();
				return { stream: existingAgain, type: "arbitrary" };
			}
			// Register with StreamManager
			const streamId = this.streamManager.registerStream(stream.stream, track, {
				source: track.source || "plugin",
				isPreload: false,
				priority: 5,
			});
			this.debug(`[Stream] Plugin stream registered with ID: ${streamId}`);
			return stream;
		}

		throw new Error(`No stream available for track: ${track.title}`);
	}

	/**
	 * Start playing a specific track immediately, replacing the current resource.
	 */
	private async startTrack(track: Track): Promise<boolean> {
		try {
			// Try to use preloaded resource
			if (
				this.preloadSlot.isValid &&
				this.preloadSlot.track?.id === track.id &&
				this.preloadSlot.resource &&
				this.preloadSlot.resource.playStream?.readable !== false
			) {
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

				// Apply volume
				if (currentResource.volume) {
					currentResource.volume.setVolume(this.volume / 100);
				}

				// Play
				this.audioPlayer.play(currentResource);
				await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);

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
		// Store preload resource
		const newResource = this.preloadSlot.resource;
		const oldStreamId = this.currentSlot.streamId;

		if (!newResource) {
			return false;
		}

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

		// Apply volume
		if (currentResource.volume) {
			currentResource.volume.setVolume(this.volume / 100);
		}

		// Play
		this.audioPlayer.play(currentResource);

		try {
			await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);

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
			if (resource.volume) {
				resource.volume.setVolume(this.volume / 100);
			}

			// Play
			this.audioPlayer.stop(true);
			this.audioPlayer.play(resource);
			await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);

			// Preload next (async)
			this.preloadNextTrack().catch((err) => {
				this.debug(`[Player] Preload error:`, err);
			});

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
						continue;
					}
				}

				this.debug(`[Player] No next track in queue`);
				this.isPlaying = false;
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
					return true;
				}
			} catch (err) {
				this.debug(`[Player] playNext error:`, err);
				this.emit("playerError", err as Error, track);
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

		this.isPlaying = false;
		this.isPaused = false;
		this.emit("playerStop");
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
				// Just stop - preload will be used in playNext -> startTrack
				return this.audioPlayer.stop();
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

		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
			this.leaveTimeout = null;
		}
		this.streamManager.destroyAll(true);
		// Destroy current stream before stopping audio
		this.destroyCurrentStream();

		this.clearSlot(this.currentSlot);
		this.clearSlot(this.preloadSlot);

		this.audioPlayer.removeAllListeners();
		this.audioPlayer.stop(true);
		this.clearPreload();

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
		this.isPlaying = false;
		this.isPaused = false;

		// Clear any remaining intervals
		if (this.volumeInterval) {
			clearInterval(this.volumeInterval);
			this.volumeInterval = null;
		}

		this.emit("playerDestroy");
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
			if (wasPlaying && !wasPaused) {
				this.isPlaying = true;
				this.isPaused = false;
			} else if (wasPaused) {
				this.isPlaying = false;
				this.isPaused = true;
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
			this.debug(`[Player] AudioPlayer stateChange from ${oldState.status} to ${newState.status}`);
			if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
				// Track ended
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track ended: ${track.title}`);
					this.emit("trackEnd", track);
				}
				this.playNext();
			} else if (
				newState.status === AudioPlayerStatus.Playing &&
				(oldState.status === AudioPlayerStatus.Idle || oldState.status === AudioPlayerStatus.Buffering)
			) {
				// Track started
				this.clearLeaveTimeout();
				this.isPlaying = true;
				this.isPaused = false;
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Track started: ${track.title}`);
					this.emit("trackStart", track);
				}
			} else if (newState.status === AudioPlayerStatus.Paused && oldState.status !== AudioPlayerStatus.Paused) {
				// Track paused
				this.isPaused = true;
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player paused on track: ${track.title}`);
					this.emit("playerPause", track);
				}
			} else if (newState.status !== AudioPlayerStatus.Paused && oldState.status === AudioPlayerStatus.Paused) {
				// Track resumed
				this.isPaused = false;
				const track = this.queue.currentTrack;
				if (track) {
					this.debug(`[Player] Player resumed on track: ${track.title}`);
					this.emit("playerResume", track);
				}
			} else if (newState.status === AudioPlayerStatus.AutoPaused) {
				this.debug(`[Player] AudioPlayerStatus.AutoPaused`);
			} else if (newState.status === AudioPlayerStatus.Buffering) {
				this.debug(`[Player] AudioPlayerStatus.Buffering`);
				this.lastDuration = this.currentResource?.playbackDuration || 0;
				this.stuckTimer = setTimeout(() => {
					if (this.currentResource?.playbackDuration === this.lastDuration) {
						this.emit("trackStuck", this.currentTrack);
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
			this.debug(`[Player] AudioPlayer error:`, error);
			this.emit("playerError", error, this.queue.currentTrack || undefined);
			this.playNext();
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

	//#endregion
}
