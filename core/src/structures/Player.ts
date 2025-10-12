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

	// Cache for plugin matching to improve performance
	private pluginCache = new Map<string, SourcePlugin>();
	private readonly PLUGIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private pluginCacheTimestamps = new Map<string, number>();

	// Cache for search results to avoid duplicate calls
	private searchCache = new Map<string, SearchResult>();
	private readonly SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
	private searchCacheTimestamps = new Map<string, number>();

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

	/**
	 * Start playing a specific track immediately, replacing the current resource.
	 */
	private async startTrack(track: Track): Promise<boolean> {
		try {
			let streamInfo: StreamInfo | null = await this.extensionsProvideStream(track);
			let plugin: SourcePlugin | undefined;

			if (!streamInfo) {
				plugin = this.pluginManager.findPlugin(track.url) || this.pluginManager.get(track.source);

				if (!plugin) {
					this.debug(`[Player] No plugin found for track: ${track.title}`);
					throw new Error(`No plugin found for track: ${track.title}`);
				}

				this.debug(`[Player] Getting stream for track: ${track.title}`);
				this.debug(`[Player] Using plugin: ${plugin.name}`);
				this.debug(`[Track] Track Info:`, track);
				try {
					streamInfo = await withTimeout(plugin.getStream(track), this.options.extractorTimeout ?? 15000, "getStream timed out");
				} catch (streamError) {
					this.debug(`[Player] getStream failed, trying getFallback:`, streamError);
					const allplugs = this.pluginManager.getAll();
					for (const p of allplugs) {
						if (typeof (p as any).getFallback !== "function" && typeof (p as any).getStream !== "function") {
							continue;
						}
						try {
							streamInfo = await withTimeout(
								(p as any).getStream(track),
								this.options.extractorTimeout ?? 15000,
								`getStream timed out for plugin ${p.name}`,
							);
							if ((streamInfo as any)?.stream) {
								this.debug(`[Player] getStream succeeded with plugin ${p.name} for track: ${track.title}`);
								break;
							}
							streamInfo = await withTimeout(
								(p as any).getFallback(track),
								this.options.extractorTimeout ?? 15000,
								`getFallback timed out for plugin ${p.name}`,
							);
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
				this.debug(streamInfo);
			} else {
				this.debug(`[Player] Using extension-provided stream for track: ${track.title}`);
			}

			// Kiểm tra nếu có stream thực sự để tạo AudioResource
			if (streamInfo && (streamInfo as any).stream) {
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

				const stream: Readable = (streamInfo as StreamInfo).stream;
				const inputType = mapToStreamType((streamInfo as StreamInfo).type);

				this.currentResource = createAudioResource(stream, {
					metadata: track,
					inputType,
					inlineVolume: true,
				});

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

	// TTS support
	private ttsPlayer: DiscordAudioPlayer | null = null;
	private ttsQueue: Array<Track> = [];
	private ttsActive = false;
	private clearLeaveTimeout(): void {
		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
			this.leaveTimeout = null;
			this.debug(`[Player] Cleared leave timeout`);
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
		this.ttsQueue.push(track);
		if (!this.ttsActive) {
			void this.playNextTTS();
		}
	}

	/**
	 * Play queued TTS items sequentially
	 *
	 * @returns {Promise<void>}
	 * @example
	 * await player.playNextTTS();
	 */
	private async playNextTTS(): Promise<void> {
		const next = this.ttsQueue.shift();
		if (!next) return;
		this.ttsActive = true;

		try {
			if (!this.connection) throw new Error("No voice connection for TTS");
			const ttsPlayer = this.ensureTTSPlayer();

			// Build resource from plugin stream
			const resource = await this.resourceFromTrack(next);
			if (resource.volume) {
				resource.volume.setVolume((this.options?.tts?.volume ?? this?.volume ?? 100) / 100);
			}

			const wasPlaying =
				this.audioPlayer.state.status === AudioPlayerStatus.Playing ||
				this.audioPlayer.state.status === AudioPlayerStatus.Buffering;

			// Pause current music if any
			try {
				this.audioPlayer.pause(true);
			} catch {}

			// Swap subscription and play TTS
			this.connection.subscribe(ttsPlayer);
			this.emit("ttsStart", { track: next });
			ttsPlayer.play(resource);

			// Wait until TTS starts then finishes
			await entersState(ttsPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => null);
			// Derive timeout from resource/track duration when available, with a sensible cap
			const md: any = (resource as any)?.metadata ?? {};
			const declared =
				typeof md.duration === "number" ? md.duration : typeof next?.duration === "number" ? next.duration : undefined;
			const declaredMs = declared ? (declared > 1000 ? declared : declared * 1000) : undefined;
			const cap = this.options?.tts?.Max_Time_TTS ?? 60_000;
			const idleTimeout = declaredMs ? Math.min(cap, Math.max(1_000, declaredMs + 1_500)) : cap;
			await entersState(ttsPlayer, AudioPlayerStatus.Idle, idleTimeout).catch(() => null);

			// Swap back and resume if needed
			this.connection.subscribe(this.audioPlayer);
			if (wasPlaying) {
				try {
					this.audioPlayer.unpause();
				} catch {}
			}
			this.emit("ttsEnd");
		} catch (err) {
			this.debug("[TTS] error while playing:", err);
			this.emit("playerError", err as Error);
		} finally {
			this.ttsActive = false;
			if (this.ttsQueue.length > 0) {
				await this.playNextTTS();
			}
		}
	}

	/**
	 * Get cached plugin or find and cache a new one
	 * @param track The track to find plugin for
	 * @returns The matching plugin or null if not found
	 */
	private getCachedPlugin(track: Track): SourcePlugin | null {
		const cacheKey = `${track.source}:${track.url}`;
		const now = Date.now();

		// Check if cache is still valid
		const cachedTimestamp = this.pluginCacheTimestamps.get(cacheKey);
		if (cachedTimestamp && now - cachedTimestamp < this.PLUGIN_CACHE_TTL) {
			const cachedPlugin = this.pluginCache.get(cacheKey);
			if (cachedPlugin) {
				this.debug(`[PluginCache] Using cached plugin for ${track.source}: ${cachedPlugin.name}`);
				return cachedPlugin;
			}
		}

		// Find new plugin and cache it
		this.debug(`[PluginCache] Finding plugin for track: ${track.title} (${track.source})`);
		const plugin = this.pluginManager.findPlugin(track.url) || this.pluginManager.get(track.source);

		if (plugin) {
			this.pluginCache.set(cacheKey, plugin);
			this.pluginCacheTimestamps.set(cacheKey, now);
			this.debug(`[PluginCache] Cached plugin: ${plugin.name} for ${track.source}`);
			return plugin;
		}

		return null;
	}

	/**
	 * Clear expired cache entries
	 */
	private clearExpiredCache(): void {
		const now = Date.now();
		for (const [key, timestamp] of this.pluginCacheTimestamps.entries()) {
			if (now - timestamp >= this.PLUGIN_CACHE_TTL) {
				this.pluginCache.delete(key);
				this.pluginCacheTimestamps.delete(key);
				this.debug(`[PluginCache] Cleared expired cache entry: ${key}`);
			}
		}
	}

	/**
	 * Clear all plugin cache entries
	 * @example
	 * player.clearPluginCache();
	 */
	public clearPluginCache(): void {
		const cacheSize = this.pluginCache.size;
		this.pluginCache.clear();
		this.pluginCacheTimestamps.clear();
		this.debug(`[PluginCache] Cleared all ${cacheSize} cache entries`);
	}

	/**
	 * Get plugin cache statistics
	 * @returns Cache statistics
	 * @example
	 * const stats = player.getPluginCacheStats();
	 * console.log(`Cache size: ${stats.size}, Hit rate: ${stats.hitRate}%`);
	 */
	public getPluginCacheStats(): { size: number; hitRate: number; expiredEntries: number } {
		const now = Date.now();
		let expiredEntries = 0;

		for (const timestamp of this.pluginCacheTimestamps.values()) {
			if (now - timestamp >= this.PLUGIN_CACHE_TTL) {
				expiredEntries++;
			}
		}

		return {
			size: this.pluginCache.size,
			hitRate: 0, // Would need to track hits/misses to calculate this
			expiredEntries,
		};
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
	 * Get search cache statistics
	 * @returns Search cache statistics
	 * @example
	 * const stats = player.getSearchCacheStats();
	 * console.log(`Search cache size: ${stats.size}, Expired: ${stats.expiredEntries}`);
	 */
	public getSearchCacheStats(): { size: number; expiredEntries: number; queries: string[] } {
		const now = Date.now();
		let expiredEntries = 0;
		const queries: string[] = [];

		for (const [key, timestamp] of this.searchCacheTimestamps.entries()) {
			if (now - timestamp >= this.SEARCH_CACHE_TTL) {
				expiredEntries++;
			} else {
				queries.push(key);
			}
		}

		return {
			size: this.searchCache.size,
			expiredEntries,
			queries,
		};
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

	/** Build AudioResource for a given track using the plugin pipeline */
	private async resourceFromTrack(track: Track): Promise<AudioResource> {
		this.debug(`[ResourceFromTrack] Starting resource creation for track: ${track.title} (${track.source})`);

		// Clear expired cache entries periodically
		if (Math.random() < 0.1) {
			// 10% chance to clean cache
			this.clearExpiredCache();
		}

		// Resolve plugin using cache
		const plugin = this.getCachedPlugin(track);
		if (!plugin) {
			this.debug(`[ResourceFromTrack] No plugin found for track: ${track.title} (${track.source})`);
			throw new Error(`No plugin found for track: ${track.title}`);
		}

		this.debug(`[ResourceFromTrack] Using plugin: ${plugin.name} for track: ${track.title}`);

		let streamInfo: StreamInfo | null = null;
		const timeoutMs = this.options.extractorTimeout ?? 15000;

		try {
			this.debug(`[ResourceFromTrack] Attempting getStream with ${plugin.name}, timeout: ${timeoutMs}ms`);
			const startTime = Date.now();
			streamInfo = await withTimeout(plugin.getStream(track), timeoutMs, "getStream timed out");
			const duration = Date.now() - startTime;
			this.debug(`[ResourceFromTrack] getStream successful with ${plugin.name} in ${duration}ms`);

			if (!streamInfo?.stream) {
				this.debug(`[ResourceFromTrack] getStream returned no stream from ${plugin.name}`);
				throw new Error(`No stream returned from ${plugin.name}`);
			}
		} catch (streamError) {
			const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
			this.debug(`[ResourceFromTrack] getStream failed with ${plugin.name}: ${errorMessage}`);

			// Log more details for debugging
			if (streamError instanceof Error && streamError.stack) {
				this.debug(`[ResourceFromTrack] getStream error stack:`, streamError.stack);
			}

			// try fallbacks
			this.debug(`[ResourceFromTrack] Attempting fallback plugins for track: ${track.title}`);
			const allplugs = this.pluginManager.getAll();
			let fallbackAttempts = 0;

			for (const p of allplugs) {
				if (typeof (p as any).getFallback !== "function" && typeof (p as any).getStream !== "function") {
					this.debug(`[ResourceFromTrack] Skipping plugin ${(p as any).name} - no getFallback or getStream method`);
					continue;
				}

				fallbackAttempts++;
				this.debug(`[ResourceFromTrack] Trying fallback plugin ${(p as any).name} (attempt ${fallbackAttempts})`);

				try {
					// Try getStream first
					const startTime = Date.now();
					streamInfo = await withTimeout(p.getStream(track), timeoutMs, "getStream timed out");
					const duration = Date.now() - startTime;

					if (streamInfo?.stream) {
						this.debug(`[ResourceFromTrack] Fallback getStream successful with ${(p as any).name} in ${duration}ms`);
						break;
					}

					// Try getFallback if getStream didn't work
					this.debug(`[ResourceFromTrack] Trying getFallback with ${(p as any).name}`);
					const fallbackStartTime = Date.now();
					streamInfo = await withTimeout(
						(p as any).getFallback(track),
						timeoutMs,
						`getFallback timed out for plugin ${(p as any).name}`,
					);
					const fallbackDuration = Date.now() - fallbackStartTime;

					if (streamInfo?.stream) {
						this.debug(`[ResourceFromTrack] Fallback getFallback successful with ${(p as any).name} in ${fallbackDuration}ms`);
						break;
					}

					this.debug(`[ResourceFromTrack] Fallback plugin ${(p as any).name} returned no stream`);
				} catch (fallbackError) {
					const errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
					this.debug(`[ResourceFromTrack] Fallback plugin ${(p as any).name} failed: ${errorMessage}`);

					// Log more details for debugging
					if (fallbackError instanceof Error && fallbackError.stack) {
						this.debug(`[ResourceFromTrack] Fallback error stack:`, fallbackError.stack);
					}
				}
			}

			if (!streamInfo?.stream) {
				this.debug(`[ResourceFromTrack] All ${fallbackAttempts} fallback attempts failed for track: ${track.title}`);
				throw new Error(`All getFallback attempts failed for track: ${track.title}`);
			}
		}

		this.debug(
			`[ResourceFromTrack] Stream obtained, type: ${streamInfo.type}, metadata keys: ${Object.keys(
				streamInfo.metadata || {},
			).join(", ")}`,
		);

		const mapToStreamType = (type: string): StreamType => {
			switch (type) {
				case "webm/opus":
					return StreamType.WebmOpus;
				case "ogg/opus":
					return StreamType.OggOpus;
				case "arbitrary":
				default:
					return StreamType.Arbitrary;
			}
		};

		const inputType = mapToStreamType(streamInfo.type);
		this.debug(`[ResourceFromTrack] Creating AudioResource with inputType: ${inputType}`);

		// Merge metadata safely
		const mergedMetadata = {
			...track,
			...(streamInfo.metadata || {}),
		};

		const audioResource = createAudioResource(streamInfo.stream, {
			// Prefer plugin-provided metadata (e.g., precise duration), fallback to track fields
			metadata: mergedMetadata,
			inputType,
			inlineVolume: true,
		});

		this.debug(`[ResourceFromTrack] AudioResource created successfully for track: ${track.title}`);
		return audioResource;
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
				this.debug(`[Player] Leaving voice channel after timeout`);
				this.destroy();
			}, this.options.leaveTimeout);
		}
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
}
