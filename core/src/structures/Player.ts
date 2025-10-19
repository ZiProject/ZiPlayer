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

import { VoiceChannel } from "discord.js";
import { Readable } from "stream";
import prism from "prism-media";
import { BaseExtension } from "../extensions";
import {
	Track,
	PlayerOptions,
	PlayerEvents,
	SourcePlugin,
	SearchResult,
	ProgressBarOptions,
	LoopMode,
	StreamInfo,
	SaveOptions,
	AudioFilter,
	PREDEFINED_FILTERS,
} from "../types";
import type {
	ExtensionContext,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
	ExtensionStreamRequest,
	ExtensionSearchRequest,
} from "../types";
import { Queue } from "./Queue";
import { PluginManager } from "../plugins";
import { withTimeout } from "../utils/timeout";
import type { PlayerManager } from "./PlayerManager";
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
	public userdata?: Record<string, any>;
	private manager: PlayerManager;
	private leaveTimeout: NodeJS.Timeout | null = null;
	private currentResource: AudioResource | null = null;
	private volumeInterval: NodeJS.Timeout | null = null;
	private skipLoop = false;
	private extensions: BaseExtension[] = [];
	private extensionContext!: ExtensionContext;
	// Audio filters
	private activeFilters: AudioFilter[] = [];
	private filterCache = new Map<string, Readable>();

	// Cache for search results to avoid duplicate calls
	private searchCache = new Map<string, SearchResult>();
	private readonly SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
	private searchCacheTimestamps = new Map<string, number>();
	// TTS support
	private ttsPlayer: DiscordAudioPlayer | null = null;
	/**
	 * Attach an extension to the player
	 *
	 * @param {BaseExtension} extension - The extension to attach
	 * @example
	 * player.attachExtension(new MyExtension());
	 */
	public attachExtension(extension: BaseExtension): void {
		if (this.extensions.includes(extension)) return;
		if (!extension.player) extension.player = this;
		this.extensions.push(extension);
		this.invokeExtensionLifecycle(extension, "onRegister");
	}

	/**
	 * Detach an extension from the player
	 *
	 * @param {BaseExtension} extension - The extension to detach
	 * @example
	 * player.detachExtension(new MyExtension());
	 */
	public detachExtension(extension: BaseExtension): void {
		const index = this.extensions.indexOf(extension);
		if (index === -1) return;
		this.extensions.splice(index, 1);
		this.invokeExtensionLifecycle(extension, "onDestroy");
		if (extension.player === this) {
			extension.player = null;
		}
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
		return this.extensions;
	}

	private invokeExtensionLifecycle(extension: BaseExtension, hook: "onRegister" | "onDestroy"): void {
		const fn = (extension as any)[hook];
		if (typeof fn !== "function") return;
		try {
			const result = fn.call(extension, this.extensionContext);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((err) => this.debug(`[Player] Extension ${extension.name} ${hook} error:`, err));
			}
		} catch (err) {
			this.debug(`[Player] Extension ${extension.name} ${hook} error:`, err);
		}
	}

	private async runBeforePlayHooks(
		initial: ExtensionPlayRequest,
	): Promise<{ request: ExtensionPlayRequest; response: ExtensionPlayResponse }> {
		const request: ExtensionPlayRequest = { ...initial };
		const response: ExtensionPlayResponse = {};
		for (const extension of this.extensions) {
			const hook = (extension as any).beforePlay;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (!result) continue;
				if (result.query !== undefined) {
					request.query = result.query;
					response.query = result.query;
				}
				if (result.requestedBy !== undefined) {
					request.requestedBy = result.requestedBy;
					response.requestedBy = result.requestedBy;
				}
				if (Array.isArray(result.tracks)) {
					response.tracks = result.tracks;
				}
				if (typeof result.isPlaylist === "boolean") {
					response.isPlaylist = result.isPlaylist;
				}
				if (typeof result.success === "boolean") {
					response.success = result.success;
				}
				if (result.error instanceof Error) {
					response.error = result.error;
				}
				if (typeof result.handled === "boolean") {
					response.handled = result.handled;
					if (result.handled) break;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} beforePlay error:`, err);
			}
		}
		return { request, response };
	}

	private async runAfterPlayHooks(payload: ExtensionAfterPlayPayload): Promise<void> {
		if (this.extensions.length === 0) return;
		const safeTracks = payload.tracks ? [...payload.tracks] : undefined;
		if (safeTracks) {
			Object.freeze(safeTracks);
		}
		const immutablePayload = Object.freeze({ ...payload, tracks: safeTracks });
		for (const extension of this.extensions) {
			const hook = (extension as any).afterPlay;
			if (typeof hook !== "function") continue;
			try {
				await Promise.resolve(hook.call(extension, this.extensionContext, immutablePayload));
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} afterPlay error:`, err);
			}
		}
	}

	private async extensionsProvideSearch(query: string, requestedBy: string): Promise<SearchResult | null> {
		const request: ExtensionSearchRequest = { query, requestedBy };
		for (const extension of this.extensions) {
			const hook = (extension as any).provideSearch;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (result && Array.isArray(result.tracks) && result.tracks.length > 0) {
					this.debug(`[Player] Extension ${extension.name} handled search for query: ${query}`);
					return result as SearchResult;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} provideSearch error:`, err);
			}
		}
		return null;
	}

	private async extensionsProvideStream(track: Track): Promise<StreamInfo | null> {
		const request: ExtensionStreamRequest = { track };
		for (const extension of this.extensions) {
			const hook = (extension as any).provideStream;
			if (typeof hook !== "function") continue;
			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (result && (result as StreamInfo).stream) {
					this.debug(`[Player] Extension ${extension.name} provided stream for track: ${track.title}`);
					return result as StreamInfo;
				}
			} catch (err) {
				this.debug(`[Player] Extension ${extension.name} provideStream error:`, err);
			}
		}
		return null;
	}

	async getStreamFromPlugin(track: Track): Promise<StreamInfo | null> {
		let streamInfo: StreamInfo | null = null;
		const plugin = this.pluginManager.get(track.source) || this.pluginManager.findPlugin(track.url);

		if (!plugin) {
			this.debug(`[Player] No plugin found for track: ${track.title}`);
			return null;
		}

		this.debug(`[Player] Getting stream for track: ${track.title}`);
		this.debug(`[Player] Using plugin: ${plugin.name}`);
		this.debug(`[Track] Track Info:`, track);
		const timeoutMs = this.options.extractorTimeout ?? 50000;
		try {
			streamInfo = await withTimeout(plugin.getStream(track), timeoutMs, "getStream timed out");
			if (!(streamInfo as any)?.stream) {
				throw new Error(`No stream returned from ${plugin.name}`);
			}
		} catch (streamError) {
			this.debug(`[Player] getStream failed, trying getFallback:`, streamError);
			const allplugs = this.pluginManager.getAll();
			for (const p of allplugs) {
				if (typeof (p as any).getFallback !== "function" && typeof (p as any).getStream !== "function") {
					continue;
				}
				try {
					streamInfo = await withTimeout((p as any).getStream(track), timeoutMs, `getStream timed out for plugin ${p.name}`);
					if ((streamInfo as any)?.stream) {
						this.debug(`[Player] getStream succeeded with plugin ${p.name} for track: ${track.title}`);
						break;
					}
					streamInfo = await withTimeout((p as any).getFallback(track), timeoutMs, `getFallback timed out for plugin ${p.name}`);
					if (!(streamInfo as any)?.stream) continue;
					break;
				} catch (fallbackError) {
					this.debug(`[Player] getFallback failed with plugin ${p.name}:`, fallbackError);
				}
			}
			if (!(streamInfo as any)?.stream) {
				throw new Error(`All getFallback attempts failed for track: ${track.title}`);
			}
		}

		return streamInfo as StreamInfo;
	}
	private async Audioresource(streamInfo: StreamInfo, track?: Track): Promise<AudioResource> {
		function mapToStreamType(type: string | undefined): StreamType {
			switch (type) {
				case "webm/opus":
					return StreamType.WebmOpus;
				case "ogg/opus":
					return StreamType.OggOpus;
				case "arbitrary":
				default:
					return StreamType.Arbitrary;
			}
		}

		let stream: Readable = (streamInfo as StreamInfo).stream;
		const inputType = mapToStreamType((streamInfo as StreamInfo).type);

		// Apply filters if any are active
		if (this.activeFilters.length > 0) {
			stream = await this.applyFiltersToStream(stream, track);
		}

		const resource = createAudioResource(stream, {
			metadata: track ?? {
				title: streamInfo.metadata?.title ?? "",
				duration: streamInfo.metadata?.duration ?? 0,
				source: streamInfo.metadata?.source ?? "",
				requestedBy: streamInfo.metadata?.requestedBy ?? "",
				thumbnail: streamInfo.metadata?.thumbnail ?? "",
				url: streamInfo.metadata?.url ?? "",
				id: streamInfo.metadata?.id ?? "",
			},
			inputType,
			inlineVolume: true,
		});

		return resource;
	}

	/**
	 * Apply active filters to an audio stream using @prismmedia/ffmpeg
	 *
	 * @param {Readable} stream - The original audio stream
	 * @param {Track} track - The track being processed (for caching)
	 * @returns {Promise<Readable>} The filtered audio stream
	 */
	private async applyFiltersToStream(stream: Readable, track?: Track): Promise<Readable> {
		const filterString = this.getFilterString();
		if (!filterString) {
			return stream;
		}

		// Create cache key for this track and filter combination
		const cacheKey = track ? `${track.id}-${filterString}` : `stream-${filterString}`;

		// Check if we have a cached filtered stream
		if (this.filterCache.has(cacheKey)) {
			this.debug(`[Player] Using cached filtered stream for: ${track?.title || "unknown"}`);
			return this.filterCache.get(cacheKey)!;
		}

		this.debug(`[Player] Applying filters to stream: ${filterString}`);

		try {
			let ffmpeg = new prism.FFmpeg({
				args: [
					"-analyzeduration",
					"0",
					"-loglevel",
					"0",
					// "-i",
					// "pipe:0",
					"-af",
					filterString,
					"-f",
					"mp3",
					"-ar",
					"48000",
					"-ac",
					"2",
					// "pipe:1",
				],
			});

			// Handle FFmpeg errors
			ffmpeg.on("error", (err: Error) => {
				this.debug(`[Player] FFmpeg error:`, err);
			});

			ffmpeg.on("close", () => {
				this.debug(`[Player] FFmpeg filter processing completed`);
			});

			ffmpeg = stream.pipe(ffmpeg);
			ffmpeg.on("data", (data: Buffer) => {
				this.debug(`[Player] FFmpeg data:`, data.length);
			});
			ffmpeg.on("error", () => ffmpeg.destroy());

			// const opus = new prism.opus.Encoder({
			// 	rate: 48000,
			// 	channels: 2,
			// 	frameSize: 960,
			// });
			// const opusStream = ffmpeg.pipe(opus);
			// opusStream.on("close", () => {
			// 	ffmpeg.destroy();
			// 	opus.destroy();
			// });
			// Cache the filtered stream
			this.filterCache.set(cacheKey, ffmpeg);

			// Clean up cache periodically to prevent memory leaks
			if (this.filterCache.size > 10) {
				const firstKey = this.filterCache.keys().next().value;
				if (firstKey) {
					this.filterCache.delete(firstKey);
				}
			}

			return ffmpeg;
		} catch (error) {
			this.debug(`[Player] Error creating FFmpeg instance:`, error);
			// Fallback to original stream if FFmpeg fails
			return stream;
		}
	}

	/**
	 * Start playing a specific track immediately, replacing the current resource.
	 */
	private async startTrack(track: Track): Promise<boolean> {
		try {
			let streamInfo: StreamInfo | null = await this.extensionsProvideStream(track);
			let plugin: SourcePlugin | undefined;

			if (!streamInfo) {
				streamInfo = await this.getStreamFromPlugin(track);
				if (!streamInfo) {
					throw new Error(`No stream available for track: ${track.title}`);
				}
			} else {
				this.debug(`[Player] Using extension-provided stream for track: ${track.title}`);
			}

			// Kiểm tra nếu có stream thực sự để tạo AudioResource
			if (streamInfo && (streamInfo as any).stream) {
				this.currentResource = await this.Audioresource(streamInfo, track);
				// Apply initial volume using the resource's VolumeTransformer
				if (this.volumeInterval) {
					clearInterval(this.volumeInterval);
					this.volumeInterval = null;
				}
				this.currentResource.volume?.setVolume(this.volume / 100);

				this.debug(`[Player] Playing resource for track: ${track.title}`);
				this.audioPlayer.play(this.currentResource);

				await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 5_000);
				return true;
			} else if (streamInfo && !(streamInfo as any).stream) {
				// Extension đang xử lý phát nhạc (như Lavalink) - chỉ đánh dấu đang phát
				this.debug(`[Player] Extension is handling playback for track: ${track.title}`);
				this.isPlaying = true;
				this.isPaused = false;
				this.emit("trackStart", track);
				return true;
			} else {
				throw new Error(`No stream available for track: ${track.title}`);
			}
		} catch (error) {
			this.debug(`[Player] startTrack error:`, error);
			this.emit("playerError", error as Error, track);
			return false;
		}
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

		this.pluginManager = new PluginManager();

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
				Max_Time_TTS: 60_000,
				...(options?.tts || {}),
			},
		};

		this.volume = this.options.volume || 100;
		this.userdata = this.options.userdata;
		this.setupEventListeners();
		this.extensionContext = Object.freeze({ player: this, manager });

		// Initialize filters from options
		if (this.options.filters && this.options.filters.length > 0) {
			this.debug(`[Player] Initializing ${this.options.filters.length} filters from options`);
			this.applyFilters(this.options.filters);
		}

		// Optionally pre-create the TTS AudioPlayer
		if (this.options?.tts?.createPlayer) {
			this.ensureTTSPlayer();
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
	}

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

	addPlugin(plugin: SourcePlugin): void {
		this.debug(`[Player] Adding plugin: ${plugin.name}`);
		this.pluginManager.register(plugin);
	}

	removePlugin(name: string): boolean {
		this.debug(`[Player] Removing plugin: ${name}`);
		return this.pluginManager.unregister(name);
	}

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

			connection.on(VoiceConnectionStatus.Disconnected, () => {
				this.debug(`[Player] VoiceConnectionStatus.Disconnected`);
				this.destroy();
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

		// Clear expired search cache periodically
		if (Math.random() < 0.1) {
			// 10% chance to clean cache
			this.clearExpiredSearchCache();
		}

		// Check cache first
		const cachedResult = this.getCachedSearchResult(query);
		if (cachedResult) {
			return cachedResult;
		}

		// Try extensions first
		const extensionResult = await this.extensionsProvideSearch(query, requestedBy);
		if (extensionResult && Array.isArray(extensionResult.tracks) && extensionResult.tracks.length > 0) {
			this.debug(`[Player] Extension handled search for query: ${query}`);
			this.cacheSearchResult(query, extensionResult);
			return extensionResult;
		}

		// Get plugins and filter out TTS for regular searches
		const allPlugins = this.pluginManager.getAll();
		const plugins = allPlugins.filter((p) => {
			// Skip TTS plugin for regular searches (unless query starts with "tts:")
			if (p.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")) {
				this.debug(`[Player] Skipping TTS plugin for regular search: ${query}`);
				return false;
			}
			return true;
		});

		this.debug(`[Player] Using ${plugins.length} plugins for search (filtered from ${allPlugins.length})`);

		let lastError: any = null;
		let searchAttempts = 0;

		for (const p of plugins) {
			searchAttempts++;
			try {
				this.debug(`[Player] Trying plugin for search: ${p.name} (attempt ${searchAttempts}/${plugins.length})`);
				const startTime = Date.now();
				const res = await withTimeout(
					p.search(query, requestedBy),
					this.options.extractorTimeout ?? 15000,
					`Search operation timed out for ${p.name}`,
				);
				const duration = Date.now() - startTime;

				if (res && Array.isArray(res.tracks) && res.tracks.length > 0) {
					this.debug(`[Player] Plugin '${p.name}' returned ${res.tracks.length} tracks in ${duration}ms`);
					this.cacheSearchResult(query, res);
					return res;
				}
				this.debug(`[Player] Plugin '${p.name}' returned no tracks in ${duration}ms`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.debug(`[Player] Search via plugin '${p.name}' failed: ${errorMessage}`);
				lastError = error;
				// Continue to next plugin
			}
		}

		this.debug(`[Player] No plugins returned results for query: ${query} (tried ${searchAttempts} plugins)`);
		if (lastError) this.emit("playerError", lastError as Error);
		throw new Error(`No plugin found to handle: ${query}`);
	}

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
			query === null
				? "null"
				: typeof query === "string"
				? query
				: "tracks" in query
				? `${query.tracks.length} tracks`
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
				const hookOutcome = await this.runBeforePlayHooks(effectiveRequest);
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
					await this.runAfterPlayHooks(handledPayload);
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
				await this.runAfterPlayHooks({
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

			await this.runAfterPlayHooks({
				success: started,
				query: effectiveRequest.query,
				requestedBy: effectiveRequest.requestedBy,
				tracks: tracksToAdd,
				isPlaylist,
			});

			return started;
		} catch (error) {
			await this.runAfterPlayHooks({
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

		try {
			if (!this.connection) throw new Error("No voice connection for TTS");
			const ttsPlayer = this.ensureTTSPlayer();

			// Build resource from plugin stream
			const streamInfo = await this.getStreamFromPlugin(track);
			if (!streamInfo) {
				throw new Error("No stream available for track: ${track.title}");
			}
			const resource = await this.Audioresource(streamInfo as StreamInfo, track);
			if (!resource) {
				throw new Error("No resource available for track: ${track.title}");
			}
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
				typeof md.duration === "number" ? md.duration : typeof track?.duration === "number" ? track.duration : undefined;
			const declaredMs = declared ? (declared > 1000 ? declared : declared * 1000) : undefined;
			const cap = this.options?.tts?.Max_Time_TTS ?? 60_000;
			const idleTimeout = declaredMs ? Math.min(cap, Math.max(1_000, declaredMs + 1_500)) : cap;
			await entersState(ttsPlayer, AudioPlayerStatus.Idle, idleTimeout).catch(() => null);

			// Swap back and resume if needed
			this.connection.subscribe(this.audioPlayer);
		} catch (err) {
			this.debug("[TTS] error while playing:", err);
			this.emit("playerError", err as Error);
		} finally {
			if (wasPlaying) {
				try {
					this.resume();
				} catch {}
			}
			this.emit("ttsEnd");
		}
	}

	/**
	 * Get cached search result or null if not found/expired
	 * @param query The search query
	 * @returns Cached search result or null
	 */
	private getCachedSearchResult(query: string): SearchResult | null {
		const cacheKey = query.toLowerCase().trim();
		const now = Date.now();

		const cachedTimestamp = this.searchCacheTimestamps.get(cacheKey);
		if (cachedTimestamp && now - cachedTimestamp < this.SEARCH_CACHE_TTL) {
			const cachedResult = this.searchCache.get(cacheKey);
			if (cachedResult) {
				this.debug(`[SearchCache] Using cached search result for: ${query}`);
				return cachedResult;
			}
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
		const now = Date.now();

		this.searchCache.set(cacheKey, result);
		this.searchCacheTimestamps.set(cacheKey, now);
		this.debug(`[SearchCache] Cached search result for: ${query} (${result.tracks.length} tracks)`);
	}

	/**
	 * Clear expired search cache entries
	 */
	private clearExpiredSearchCache(): void {
		const now = Date.now();
		for (const [key, timestamp] of this.searchCacheTimestamps.entries()) {
			if (now - timestamp >= this.SEARCH_CACHE_TTL) {
				this.searchCache.delete(key);
				this.searchCacheTimestamps.delete(key);
				this.debug(`[SearchCache] Cleared expired cache entry: ${key}`);
			}
		}
	}

	/**
	 * Clear all search cache entries
	 * @example
	 * player.clearSearchCache();
	 */
	public clearSearchCache(): void {
		const cacheSize = this.searchCache.size;
		this.searchCache.clear();
		this.searchCacheTimestamps.clear();
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
		const now = Date.now();
		const cachedTimestamp = this.searchCacheTimestamps.get(cacheKey);
		const isCached = cachedTimestamp && now - cachedTimestamp < this.SEARCH_CACHE_TTL;

		const allPlugins = this.pluginManager.getAll();
		const plugins = allPlugins.filter((p) => {
			if (p.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")) {
				return false;
			}
			return true;
		});

		return {
			isCached: !!isCached,
			cacheAge: cachedTimestamp ? now - cachedTimestamp : undefined,
			pluginCount: plugins.length,
			ttsFiltered: allPlugins.length > plugins.length,
		};
	}

	private async generateWillNext(): Promise<void> {
		const lastTrack = this.queue.previousTracks[this.queue.previousTracks.length - 1] ?? this.queue.currentTrack;
		if (!lastTrack) return;

		// Build list of candidate plugins: preferred first, then others with getRelatedTracks
		const preferred = this.pluginManager.findPlugin(lastTrack.url) || this.pluginManager.get(lastTrack.source);
		const all = this.pluginManager.getAll();
		const candidates = [...(preferred ? [preferred] : []), ...all.filter((p) => p !== preferred)].filter(
			(p) => typeof (p as any).getRelatedTracks === "function",
		);

		for (const p of candidates) {
			try {
				this.debug(`[Player] Trying related from plugin: ${p.name}`);
				const related = await withTimeout(
					(p as any).getRelatedTracks(lastTrack.url, {
						limit: 10,
						history: this.queue.previousTracks,
					}),
					this.options.extractorTimeout ?? 15000,
					`getRelatedTracks timed out for ${p.name}`,
				);

				if (Array.isArray(related) && related.length > 0) {
					const randomchoice = Math.floor(Math.random() * related.length);
					const nextTrack = this.queue.nextTrack ? this.queue.nextTrack : related[randomchoice];
					this.queue.willNextTrack(nextTrack);
					this.queue.relatedTracks(related);
					this.debug(`[Player] Will next track if autoplay: ${nextTrack?.title} (via ${p.name})`);
					this.emit("willPlay", nextTrack, related);
					return; // success
				}
				this.debug(`[Player] ${p.name} returned no related tracks`);
			} catch (err) {
				this.debug(`[Player] getRelatedTracks error from ${p.name}:`, err);
				// try next candidate
			}
		}
	}

	private async playNext(): Promise<boolean> {
		this.debug(`[Player] playNext called`);
		const track = this.queue.next(this.skipLoop);
		this.skipLoop = false;
		if (!track) {
			if (this.queue.autoPlay()) {
				const willnext = this.queue.willNextTrack();
				if (willnext) {
					this.debug(`[Player] Auto-playing next track: ${willnext.title}`);
					this.queue.addMultiple([willnext]);
					return this.playNext();
				}
			}

			this.debug(`[Player] No next track in queue`);
			this.isPlaying = false;
			this.emit("queueEnd");

			if (this.options.leaveOnEnd) {
				this.scheduleLeave();
			}
			return false;
		}

		this.generateWillNext();
		// A new track is about to play; ensure we don't leave mid-playback
		this.clearLeaveTimeout();

		try {
			return await this.startTrack(track);
		} catch (error) {
			this.debug(`[Player] playNext error:`, error);
			this.emit("playerError", error as Error, track);
			return this.playNext();
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
					this.emit("playerResume", track);
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
		this.queue.clear();
		const result = this.audioPlayer.stop();
		this.isPlaying = false;
		this.isPaused = false;
		this.emit("playerStop");
		return result;
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
				// Skip to specific index
				const targetTrack = this.queue.getTrack(index);
				if (!targetTrack) {
					this.debug(`[Player] No track found at index ${index}`);
					return false;
				}

				// Remove tracks from 0 to index-1
				for (let i = 0; i < index; i++) {
					this.queue.remove(0);
				}

				this.debug(`[Player] Skipped to track at index ${index}: ${targetTrack.title}`);
				if (this.isPlaying || this.isPaused) {
					this.skipLoop = true;
					return this.audioPlayer.stop();
				}
				return true;
			}

			if (this.isPlaying || this.isPaused) {
				this.skipLoop = true;
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
	 */
	getProgressBar(options: ProgressBarOptions = {}): string {
		const { size = 20, barChar = "▬", progressChar = "🔘" } = options;
		const track = this.queue.currentTrack;
		const resource = this.currentResource;
		if (!track || !resource) return "";

		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		if (!total) return this.formatTime(resource.playbackDuration);

		const current = resource.playbackDuration;
		const ratio = Math.min(current / total, 1);
		const progress = Math.round(ratio * size);
		const bar = barChar.repeat(progress) + progressChar + barChar.repeat(size - progress);

		return `${this.formatTime(current)} | ${bar} | ${this.formatTime(total)}`;
	}

	/**
	 * Get the time of the current track
	 *
	 * @returns {Object} The time of the current track
	 * @example
	 * const time = player.getTime();
	 * console.log(`Time: ${time.current}`);
	 */
	getTime() {
		const resource = this.currentResource;
		const track = this.queue.currentTrack;
		if (!track || !resource)
			return {
				current: 0,
				total: 0,
				format: "00:00",
			};

		const total = track.duration > 1000 ? track.duration : track.duration * 1000;

		return {
			current: resource?.playbackDuration,
			total: total,
			format: this.formatTime(resource.playbackDuration),
		};
	}

	/**
	 * Format the time in the format of HH:MM:SS
	 *
	 * @param {number} ms - The time in milliseconds
	 * @returns {string} The formatted time
	 * @example
	 * const formattedTime = player.formatTime(1000);
	 * console.log(`Formatted time: ${formattedTime}`);
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

	private scheduleLeave(): void {
		this.debug(`[Player] scheduleLeave called`);
		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
		}

		if (this.options.leaveOnEmpty && this.options.leaveTimeout) {
			this.leaveTimeout = setTimeout(() => {
				this.debug(`[Player] Leaving voice channel after timeoutMs`);
				this.destroy();
			}, this.options.leaveTimeout);
		}
	}

	/**
	 * Apply an audio filter to the player
	 *
	 * @param {string | AudioFilter} filter - Filter name or AudioFilter object
	 * @returns {boolean} True if filter was applied successfully
	 * @example
	 * // Apply predefined filter
	 * player.applyFilter("bassboost");
	 *
	 * // Apply custom filter
	 * player.applyFilter({
	 *   name: "custom",
	 *   ffmpegFilter: "volume=1.5,treble=g=5",
	 *   description: "Tăng âm lượng và âm cao"
	 * });
	 */
	applyFilter(filter: string | AudioFilter): boolean {
		this.debug(`[Player] applyFilter called with: ${typeof filter === "string" ? filter : filter.name}`);

		let audioFilter: AudioFilter;

		if (typeof filter === "string") {
			const predefinedFilter = PREDEFINED_FILTERS[filter];
			if (!predefinedFilter) {
				this.debug(`[Player] Predefined filter not found: ${filter}`);
				return false;
			}
			audioFilter = predefinedFilter;
		} else {
			audioFilter = filter;
		}

		// Check if filter is already applied
		if (this.activeFilters.some((f) => f.name === audioFilter.name)) {
			this.debug(`[Player] Filter already applied: ${audioFilter.name}`);
			return false;
		}

		this.activeFilters.push(audioFilter);
		this.debug(`[Player] Applied filter: ${audioFilter.name} - ${audioFilter.description}`);
		this.emit("filterApplied", audioFilter);

		return true;
	}

	/**
	 * Remove an audio filter from the player
	 *
	 * @param {string} filterName - Name of the filter to remove
	 * @returns {boolean} True if filter was removed successfully
	 * @example
	 * player.removeFilter("bassboost");
	 */
	removeFilter(filterName: string): boolean {
		this.debug(`[Player] removeFilter called with: ${filterName}`);

		const filterIndex = this.activeFilters.findIndex((f) => f.name === filterName);
		if (filterIndex === -1) {
			this.debug(`[Player] Filter not found: ${filterName}`);
			return false;
		}

		const removedFilter = this.activeFilters.splice(filterIndex, 1)[0];
		this.debug(`[Player] Removed filter: ${removedFilter.name}`);
		this.emit("filterRemoved", removedFilter);

		return true;
	}

	/**
	 * Clear all audio filters from the player
	 *
	 * @returns {void}
	 * @example
	 * player.clearFilters();
	 */
	clearFilters(): void {
		this.debug(`[Player] clearFilters called`);
		const filterCount = this.activeFilters.length;
		this.activeFilters = [];
		this.filterCache.clear();
		this.debug(`[Player] Cleared ${filterCount} filters`);
		this.emit("filtersCleared");
	}

	/**
	 * Get all currently applied filters
	 *
	 * @returns {AudioFilter[]} Array of active filters
	 * @example
	 * const filters = player.getActiveFilters();
	 * console.log(`Active filters: ${filters.map(f => f.name).join(', ')}`);
	 */
	getActiveFilters(): AudioFilter[] {
		return [...this.activeFilters];
	}

	/**
	 * Check if a specific filter is currently applied
	 *
	 * @param {string} filterName - Name of the filter to check
	 * @returns {boolean} True if filter is applied
	 * @example
	 * const hasBassBoost = player.hasFilter("bassboost");
	 * console.log(`Has bass boost: ${hasBassBoost}`);
	 */
	hasFilter(filterName: string): boolean {
		return this.activeFilters.some((f) => f.name === filterName);
	}

	/**
	 * Get available predefined filters
	 *
	 * @returns {AudioFilter[]} Array of all predefined filters
	 * @example
	 * const availableFilters = player.getAvailableFilters();
	 * console.log(`Available filters: ${availableFilters.length}`);
	 */
	getAvailableFilters(): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS);
	}

	/**
	 * Get filters by category
	 *
	 * @param {string} category - Category to filter by
	 * @returns {AudioFilter[]} Array of filters in the category
	 * @example
	 * const eqFilters = player.getFiltersByCategory("eq");
	 * console.log(`EQ filters: ${eqFilters.map(f => f.name).join(', ')}`);
	 */
	getFiltersByCategory(category: string): AudioFilter[] {
		return Object.values(PREDEFINED_FILTERS).filter((f) => f.category === category);
	}

	/**
	 * Apply multiple filters at once
	 *
	 * @param {(string | AudioFilter)[]} filters - Array of filter names or AudioFilter objects
	 * @returns {boolean} True if all filters were applied successfully
	 * @example
	 * player.applyFilters(["bassboost", "trebleboost"]);
	 */
	applyFilters(filters: (string | AudioFilter)[]): boolean {
		this.debug(`[Player] applyFilters called with ${filters.length} filters`);

		let allApplied = true;
		for (const filter of filters) {
			if (!this.applyFilter(filter)) {
				allApplied = false;
			}
		}

		return allApplied;
	}

	/**
	 * Get the combined FFmpeg filter string for all active filters
	 *
	 * @returns {string} Combined FFmpeg filter string
	 * @example
	 * const filterString = player.getFilterString();
	 * console.log(`Filter string: ${filterString}`);
	 */
	getFilterString(): string {
		if (this.activeFilters.length === 0) {
			return "";
		}

		return this.activeFilters.map((f) => f.ffmpegFilter).join(",");
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

		this.audioPlayer.stop(true);

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
		this.clearFilters();
		for (const extension of [...this.extensions]) {
			this.invokeExtensionLifecycle(extension, "onDestroy");
			if (extension.player === this) {
				extension.player = null;
			}
		}
		this.extensions = [];
		this.isPlaying = false;
		this.isPaused = false;
		this.emit("playerDestroy");
		this.removeAllListeners();
	}

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

		// Use timeout from options or fallback to player's extractorTimeout
		const timeout = saveOptions.timeout ?? this.options.extractorTimeout ?? 15000;

		try {
			// Try extensions first
			let streamInfo: StreamInfo | null = await this.extensionsProvideStream(track);
			let plugin: SourcePlugin | undefined;

			if (!streamInfo) {
				plugin = this.pluginManager.findPlugin(track.url) || this.pluginManager.get(track.source);

				if (!plugin) {
					this.debug(`[Player] No plugin found for track: ${track.title}`);
					throw new Error(`No plugin found for track: ${track.title}`);
				}

				this.debug(`[Player] Getting save stream for track: ${track.title}`);
				this.debug(`[Player] Using save plugin: ${plugin.name}`);

				try {
					streamInfo = await withTimeout(plugin.getStream(track), timeout, "getSaveStream timed out");
				} catch (streamError) {
					this.debug(`[Player] getSaveStream failed, trying getFallback:`, streamError);
					const allplugs = this.pluginManager.getAll();
					for (const p of allplugs) {
						if (typeof (p as any).getFallback !== "function" && typeof (p as any).getStream !== "function") {
							continue;
						}
						try {
							streamInfo = await withTimeout(
								(p as any).getStream(track),
								timeout,
								`getSaveStream timed out for plugin ${p.name}`,
							);
							if ((streamInfo as any)?.stream) {
								this.debug(`[Player] getSaveStream succeeded with plugin ${p.name} for track: ${track.title}`);
								break;
							}
							streamInfo = await withTimeout(
								(p as any).getFallback(track),
								timeout,
								`getSaveFallback timed out for plugin ${p.name}`,
							);
							if (!(streamInfo as any)?.stream) continue;
							break;
						} catch (fallbackError) {
							this.debug(`[Player] getSaveFallback failed with plugin ${p.name}:`, fallbackError);
						}
					}
					if (!(streamInfo as any)?.stream) {
						throw new Error(`All getSaveFallback attempts failed for track: ${track.title}`);
					}
				}
			} else {
				this.debug(`[Player] Using extension-provided save stream for track: ${track.title}`);
			}

			if (!streamInfo || !streamInfo.stream) {
				throw new Error(`No save stream available for track: ${track.title}`);
			}

			this.debug(`[Player] Save stream obtained for track: ${track.title}`);
			if (saveOptions.filename) {
				this.debug(`[Player] Save options - filename: ${saveOptions.filename}, quality: ${saveOptions.quality || "default"}`);
			}

			// Apply filters if any are active
			let finalStream = streamInfo.stream;
			if (this.activeFilters.length > 0) {
				this.debug(`[Player] Applying filters to save stream: ${this.getFilterString()}`);
				finalStream = await this.applyFiltersToStream(streamInfo.stream, track);
			}

			// Return the stream directly - caller can pipe it to fs.createWriteStream()
			return finalStream;
		} catch (error) {
			this.debug(`[Player] save error:`, error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
}
