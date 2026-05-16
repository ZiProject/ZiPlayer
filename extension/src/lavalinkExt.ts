import { BaseExtension, Player, PlayerManager, Track, SearchResult } from "ziplayer";
import type {
	ExtensionContext,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionSearchRequest,
	ExtensionStreamRequest,
	StreamInfo,
} from "ziplayer";
import type { Client } from "discord.js";

// Import modules
import { NodeManager } from "./managers/NodeManager";
import { PlayerStateManager } from "./managers/PlayerStateManager";
import { TrackResolver } from "./resolvers/TrackResolver";
import { VoiceHandler } from "./handlers/VoiceHandler";
import { getEncoded, isTrack, createDebugLogger } from "./utils/helpers";
import type { LavalinkExtOptions, LavalinkPlayerState } from "./types/lavalink";

/**
 * Lavalink extension for ZiPlayer that provides high-performance audio streaming.
 *
 * This extension integrates with Lavalink nodes to provide:
 * - High-quality audio streaming with low latency
 * - Advanced audio processing and effects
 * - Load balancing across multiple Lavalink nodes
 * - WebSocket-based real-time player updates
 * - Automatic failover and reconnection
 * - Voice connection management
 *
 * @example
 * const lavalinkExt = new lavalinkExt(null, {
 *   nodes: [
 *     { host: "localhost", port: 2333, password: "youshallnotpass" }
 *   ],
 *   clientName: "MyBot",
 *   userId: "123456789"
 * });
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   extensions: [lavalinkExt]
 * });
 *
 * @since 1.0.0
 */
export class lavalinkExt extends BaseExtension {
	name = "lavalinkExt";
	version = "1.0.0";
	player: Player | null = null;

	// Core managers
	private nodeManager: NodeManager;
	private playerStateManager: PlayerStateManager;
	private trackResolver: TrackResolver;
	private voiceHandler: VoiceHandler;

	// Legacy properties for compatibility
	private manager?: PlayerManager;
	private client?: Client;
	private readonly options: LavalinkExtOptions;
	private userId?: string;
	private readonly originalMethods = new WeakMap<
		Player,
		{
			play: Player["play"];
			skip: Player["skip"];
			stop: Player["stop"];
			pause: Player["pause"];
			resume: Player["resume"];
			setVolume: Player["setVolume"];
			connect: Player["connect"];
		}
	>();
	private isReady = false;
	private updateTimer?: NodeJS.Timeout;
	private debug: (message: string, ...optional: any[]) => void;

	/**
	 * Creates a new Lavalink extension instance.
	 *
	 * @param player - The player instance to attach to (optional, can be set later)
	 * @param opts - Configuration options for the Lavalink extension
	 * @param opts.nodes - Array of Lavalink node configurations
	 * @param opts.clientName - Name to identify this client to Lavalink nodes
	 * @param opts.userId - Discord user ID of the bot
	 * @param opts.client - Discord.js client instance
	 * @param opts.searchPrefix - Prefix for search queries (default: "scsearch")
	 * @param opts.nodeSort - Node selection strategy (default: "players")
	 * @param opts.requestTimeoutMs - Request timeout in milliseconds (default: 10000)
	 * @param opts.updateInterval - Player update interval in milliseconds (default: 5000)
	 * @param opts.debug - Enable debug logging (default: false)
	 * @param opts.sendGatewayPayload - Function to send gateway payloads (optional)
	 *
	 * @throws {Error} If no nodes are provided or nodes array is empty
	 *
	 * @example
	 * const lavalinkExt = new lavalinkExt(null, {
	 *   nodes: [
	 *     { host: "localhost", port: 2333, password: "youshallnotpass" },
	 *     { host: "backup.example.com", port: 443, password: "backup", secure: true }
	 *   ],
	 *   clientName: "MyMusicBot",
	 *   userId: "123456789012345678",
	 *   debug: true
	 * });
	 */
	constructor(player: Player | null = null, opts: LavalinkExtOptions) {
		super();
		if (!opts || !Array.isArray(opts.nodes) || opts.nodes.length === 0) {
			throw new Error("lavalinkExt requires at least one Lavalink node configuration");
		}

		this.player = player;
		this.options = {
			searchPrefix: "scsearch",
			nodeSort: "players",
			requestTimeoutMs: 10_000,
			updateInterval: 5_000,
			...opts,
		};

		// Initialize debug logger
		this.debug = createDebugLogger(this.options.debug ?? false, "lavalinkExt");

		// Initialize managers
		this.nodeManager = new NodeManager(this.options);
		this.playerStateManager = new PlayerStateManager(this.options.debug ?? false);
		this.trackResolver = new TrackResolver(this.options.debug ?? false);
		this.voiceHandler = new VoiceHandler(this.options.debug ?? false);

		// Setup WebSocket event handlers
		this.setupWebSocketEventHandlers();

		this.client = opts.client;
		this.userId = opts.userId;

		if (this.client) {
			this.bindClient(this.client);
		}
	}

	/**
	 * Activates the extension with the provided context.
	 *
	 * This method is called when the extension is activated and handles:
	 * - Setting up the player manager reference
	 * - Binding the Discord client for voice events
	 * - Attaching to the player instance
	 * - Initializing Lavalink node connections
	 *
	 * @param alas - Context object containing manager, client, and player references
	 * @returns `true` if activation was successful, `false` otherwise
	 *
	 * @example
	 * const success = await lavalinkExt.active({
	 *   manager: playerManager,
	 *   client: discordClient,
	 *   player: playerInstance
	 * });
	 */
	async active(alas: any): Promise<boolean> {
		if (alas?.manager && !this.manager) {
			this.manager = alas.manager as PlayerManager;
		}
		const providedClient = alas?.client as Client | undefined;
		if (providedClient && !this.client) {
			this.client = providedClient;
			this.bindClient(providedClient);
		}
		const player = (alas?.player as Player | undefined) || this.player;
		if (player) {
			this.attachToPlayer(player);
		}
		await this.initializeNodes();
		return true;
	}

	/**
	 * Called when the extension is registered with a player.
	 *
	 * This method handles the initial setup when the extension is registered:
	 * - Attaches to the player instance
	 * - Starts the player update loop for monitoring
	 *
	 * @param context - Extension context containing the player instance
	 * @returns void
	 * @example
	 * lavalinkExt.onRegister({
	 *   player: playerInstance
	 * });
	 */
	onRegister(context: ExtensionContext): void {
		this.attachToPlayer(context.player);
		this.startUpdateLoop();
	}

	/**
	 * Called when the extension is being destroyed.
	 *
	 * This method handles cleanup when the extension is destroyed:
	 * - Stops the update loop
	 * - Gracefully destroys all Lavalink players
	 * - Detaches from the current player
	 * - Closes all node connections
	 *
	 * @param context - Extension context containing the player instance
	 *
	 * @example
	 * await lavalinkExt.onDestroy({
	 *   player: playerInstance
	 * });
	 */
	async onDestroy(context: ExtensionContext): Promise<void> {
		this.debug(`Extension destroying for guild ${context.player.guildId}`);

		// Stop update loop first
		this.stopUpdateLoop();

		// Clean up all players gracefully before closing connections
		const allStates = this.playerStateManager.getAllStates();
		const cleanupPromises = Array.from(allStates.entries()).map(async ([player, state]: [Player, any]) => {
			if (state.node) {
				try {
					await this.destroyLavalinkPlayer(player);
				} catch (error) {
					this.debug(`Error cleaning up player for guild ${player.guildId}`, error);
				}
			}
		});

		// Wait for all cleanup to complete
		await Promise.allSettled(cleanupPromises);

		// Detach from current player
		this.detachFromPlayer(context.player);

		// Close all connections last
		this.nodeManager.closeAllConnections();
	}

	private bindClient(client: Client): void {
		if (this.client && this.client !== client) return;
		this.client = client;
		if (!this.userId && client.user?.id) {
			this.userId = client.user.id;
		}
		client.on("raw", (packet) =>
			this.voiceHandler.handleRawEvent(packet, this.userId!, this.playerStateManager, this.nodeManager),
		);
	}

	private setupWebSocketEventHandlers(): void {
		// Handle player updates from WebSocket instead of polling
		this.nodeManager.onWebSocketEvent("playerUpdate", (node, message) => {
			this.handleWebSocketPlayerUpdate(node, message);
		});

		// Handle Lavalink events
		this.nodeManager.onWebSocketEvent("TrackStartEvent", (node, message) => {
			this.handleWebSocketTrackStart(node, message);
		});

		this.nodeManager.onWebSocketEvent("TrackEndEvent", (node, message) => {
			this.handleWebSocketTrackEnd(node, message);
		});

		this.nodeManager.onWebSocketEvent("TrackExceptionEvent", (node, message) => {
			this.handleWebSocketTrackException(node, message);
		});

		this.nodeManager.onWebSocketEvent("TrackStuckEvent", (node, message) => {
			this.handleWebSocketTrackStuck(node, message);
		});

		this.nodeManager.onWebSocketEvent("WebSocketClosedEvent", (node, message) => {
			this.handleWebSocketClosed(node, message);
		});
	}

	private async initializeNodes(): Promise<void> {
		this.debug("Initializing nodes");
		if (this.isReady) return;
		if (!this.userId && !this.client?.user?.id) return;
		if (!this.userId && this.client?.user?.id) {
			this.userId = this.client.user.id;
		}
		if (!this.userId) return;
		this.isReady = true;

		await this.nodeManager.initializeConnections(this.userId, this.options.clientName ?? `ziplayer-extension/${this.version}`);
	}

	private startUpdateLoop(): void {
		if (this.updateTimer) return;
		// Increase interval since WebSocket handles most updates in real-time
		const interval = this.options.updateInterval ?? 30_000; // 30 seconds instead of 5
		this.updateTimer = setInterval(() => {
			this.updateAllPlayers().catch((error) => this.debug("Update loop error", error));
		}, interval);
	}

	private stopUpdateLoop(): void {
		if (this.updateTimer) {
			clearInterval(this.updateTimer);
			this.updateTimer = undefined;
		}
	}

	// WebSocket event handlers
	private handleWebSocketPlayerUpdate(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		// Update position from WebSocket data
		state.lastPosition = message.state.position ?? 0;
		this.debug(
			`WebSocket player update for guild ${message.guildId}: position=${message.state.position}, connected=${message.state.connected}`,
		);
	}

	private handleWebSocketTrackStart(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		const track = this.trackResolver.resolveTrackFromLavalink(player, message.track);
		if (track) {
			state.track = track;
			state.playing = true;
			state.paused = false;
			player.emit("trackStart", track);
			this.debug(`WebSocket track start for guild ${message.guildId}: ${track.title}`);
		}
	}

	private handleWebSocketTrackEnd(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		const track = state.track;
		if (track) {
			player.emit("trackEnd", track);
			this.debug(`WebSocket track end for guild ${message.guildId}: ${track.title}, reason=${message.reason}`);
		}

		// Handle track end based on reason
		if (message.reason === "finished" || message.reason === "loadFailed" || message.reason === "stopped") {
			state.track = null;
			state.playing = false;

			// Luôn chuyển sang track tiếp theo khi track kết thúc
			this.debug(`Track ended (${message.reason}), starting next track for guild ${player.guildId}`);
			this.startNextOnLavalink(player).catch((error) => {
				this.debug(`Failed to start next track for ${player.guildId}`, error);
				// Nếu Lavalink không thể xử lý track tiếp theo, giao cho Player
				this.debug(`Delegating to Player for next track after Lavalink failure`);
				const original = this.originalMethods.get(player)?.skip;
				if (original) {
					original();
				}
			});
		} else if (message.reason === "replaced" || message.reason === "cleanup") {
			state.track = null;
			state.playing = false;
		}
	}

	private handleWebSocketTrackException(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		const error = new Error(message.exception?.message || "Track exception occurred");
		player.emit("playerError", error, state.track);
		this.debug(`WebSocket track exception for guild ${message.guildId}:`, message.exception);
	}

	private handleWebSocketTrackStuck(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		player.emit("playerError", new Error(`Track stuck: threshold exceeded ${message.thresholdMs}ms`), state.track);
		this.debug(`WebSocket track stuck for guild ${message.guildId}: threshold=${message.thresholdMs}ms`);
	}

	private handleWebSocketClosed(node: any, message: any): void {
		const player = this.playerStateManager.getPlayerByGuildId(message.guildId);
		if (!player) return;

		const state = this.playerStateManager.getState(player);
		if (!state || state.node !== node) return;

		player.emit("playerError", new Error(`WebSocket closed: ${message.code} ${message.reason}`), state.track);
		this.debug(`WebSocket closed for guild ${message.guildId}: ${message.code} ${message.reason}`);
	}

	private async updateAllPlayers(): Promise<void> {
		for (const player of this.playerStateManager.getAllPlayers()) {
			const state = this.playerStateManager.getState(player);
			if (!state?.node?.connected || !state?.node?.wsConnected) continue;

			try {
				await this.updatePlayerState(player, state);
			} catch (error) {
				this.debug(`Failed to update player ${player.guildId}`, error);
			}
		}
	}

	private async updatePlayerState(player: Player, state: LavalinkPlayerState): Promise<void> {
		if (!state.node || !state.node.wsConnected) return;
		const node = state.node;

		// With WebSocket events handling most updates, we only need to do minimal REST polling
		// This is now mainly for cleanup and fallback scenarios
		try {
			// Only check if player exists on Lavalink (lightweight check)
			const playerInfo = await this.nodeManager.getPlayerInfo(node, player.guildId);

			if (!playerInfo) {
				// Player doesn't exist on Lavalink, clean up
				state.playing = false;
				state.paused = false;
				state.track = null;

				return;
			}

			// Only update pause state if it differs (WebSocket doesn't always send pause updates)
			if (state.playing && playerInfo.paused !== state.paused) {
				state.paused = playerInfo.paused;
				if (state.track) {
					if (playerInfo.paused) {
						player.emit("playerPause", state.track);
					} else {
						player.emit("playerResume", state.track);
					}
				}
			}

			// Update volume if it changed
			if (playerInfo.volume !== undefined && playerInfo.volume !== state.volume) {
				state.volume = playerInfo.volume;
				player.volume = playerInfo.volume;
			}
		} catch (error) {
			// Player might not exist on this node, try to find another node
			if (error instanceof Error && error.message.includes("404")) {
				state.node.players.delete(player.guildId);
				state.node = undefined;
			}
			throw error;
		}
	}

	private attachToPlayer(player: Player): void {
		if (!player) return;
		this.player = this.player ?? player;

		// Use PlayerStateManager
		this.playerStateManager.attachPlayer(player);

		if (!this.manager) {
			const maybeManager = (player as any).pluginManager?.manager ?? (player as any)?.manager;
			if (maybeManager) this.manager = maybeManager as PlayerManager;
		}

		if (!this.originalMethods.has(player)) {
			this.originalMethods.set(player, {
				play: player.play.bind(player),
				skip: player.skip.bind(player),
				stop: player.stop.bind(player),
				pause: player.pause.bind(player),
				resume: player.resume.bind(player),
				setVolume: player.setVolume.bind(player),
				connect: player.connect.bind(player),
			});

			// Override methods với fallback logic
			(player as any).skip = () => this.skipWithFallback(player);
			(player as any).stop = () => this.stopWithFallback(player);
			(player as any).pause = () => this.pauseWithFallback(player);
			(player as any).resume = () => this.resumeWithFallback(player);
			(player as any).setVolume = (volume: number) => this.setVolumeWithFallback(player, volume);
			(player as any).connect = async (channel: any) => this.connect(player, channel);
		}

		const onDestroy = () => {
			this.destroyLavalinkPlayer(player).catch((error) =>
				this.debug(`Failed to destroy Lavalink player for guild ${player.guildId}`, error),
			);
			this.detachFromPlayer(player);
		};
		player.once("playerDestroy", onDestroy);
	}

	private detachFromPlayer(player: Player): void {
		const original = this.originalMethods.get(player);
		if (original) {
			(player as any).skip = original.skip;
			(player as any).stop = original.stop;
			(player as any).pause = original.pause;
			(player as any).resume = original.resume;
			(player as any).setVolume = original.setVolume;
			(player as any).connect = original.connect;
			this.originalMethods.delete(player);
		}

		const state = this.playerStateManager.getState(player);
		if (state) {
			this.destroyLavalinkPlayer(player).catch((error) =>
				this.debug(`Failed to destroy Lavalink player during detach for ${player.guildId}`, error),
			);
		}

		// Use PlayerStateManager
		this.playerStateManager.detachPlayer(player);
	}

	/**
	 * Handles play requests before they are processed by the player.
	 *
	 * This method intercepts play requests and attempts to handle them with Lavalink:
	 * - Resolves tracks using the track resolver
	 * - Adds tracks to the player's queue
	 * - Attempts to start playback on Lavalink if possible
	 * - Falls back to plugin handling if Lavalink cannot process the track
	 *
	 * @param context - Extension context containing the player instance
	 * @param payload - Play request payload containing query and metadata
	 * @returns Response indicating whether the request was handled and if it was successful
	 *
	 * @example
	 * const response = await lavalinkExt.beforePlay(context, {
	 *   query: "Never Gonna Give You Up",
	 *   requestedBy: "user123"
	 * });
	 *
	 * if (response.handled && response.success) {
	 *   console.log("Track started successfully on Lavalink");
	 * }
	 */
	async beforePlay(context: ExtensionContext, payload: ExtensionPlayRequest): Promise<ExtensionPlayResponse> {
		const player = context.player;
		this.attachToPlayer(player);
		await this.initializeNodes();

		const requestedBy = payload.requestedBy ?? "Unknown";
		try {
			const { tracks, isPlaylist } = await this.trackResolver.resolvePlayRequest(
				player,
				payload.query,
				requestedBy,
				this.nodeManager,
				this.options.searchPrefix,
			);
			if (tracks.length === 0) {
				return {
					handled: false,
					success: false,
					error: new Error("No tracks found"),
				};
			}

			if (isPlaylist) {
				player.queue.addMultiple(tracks);
				player.emit("queueAddList", tracks);
			} else {
				player.queue.add(tracks[0]);
				player.emit("queueAdd", tracks[0]);
			}

			const state = this.playerStateManager.getState(player);
			const shouldStart = !(state?.playing ?? false) && !(player.isPlaying ?? false);
			let success = true;

			if (shouldStart) {
				const lavalinkSuccess = await this.startNextOnLavalink(player);
				if (!lavalinkSuccess) {
					this.debug(`Lavalink cannot handle track, letting Player handle with plugin`);
					success = false;
				} else {
					success = lavalinkSuccess;
				}
			}

			// Nếu Lavalink không thể xử lý track, không handle để Player xử lý với plugin
			if (!success && shouldStart) {
				return {
					handled: false,
					success: false,
					error: new Error("Track not supported by Lavalink"),
				};
			}

			return {
				handled: true,
				success,
				isPlaylist,
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debug(`beforePlay error: ${err.message}`);
			return {
				handled: false,
				success: false,
				error: err,
			};
		}
	}

	/**
	 * Provides search functionality for Lavalink-compatible sources.
	 *
	 * This method handles search requests by querying Lavalink nodes:
	 * - Uses the track resolver to search Lavalink sources
	 * - Supports various search prefixes and query types
	 * - Returns search results with track information
	 *
	 * @param _context - Extension context (unused in this implementation)
	 * @param payload - Search request payload containing query and metadata
	 * @returns Search result with tracks, or null if search failed
	 *
	 * @example
	 * const result = await lavalinkExt.provideSearch(context, {
	 *   query: "scsearch:Never Gonna Give You Up",
	 *   requestedBy: "user123"
	 * });
	 *
	 * if (result) {
	 *   console.log(`Found ${result.tracks.length} tracks`);
	 * }
	 */
	async provideSearch(_context: ExtensionContext, payload: ExtensionSearchRequest): Promise<SearchResult | null> {
		try {
			return await this.trackResolver.searchLavalink(
				payload.query,
				payload.requestedBy,
				this.nodeManager,
				this.options.searchPrefix,
			);
		} catch (error) {
			this.debug(`provideSearch error: ${(error as Error).message}`);
			return null;
		}
	}

	/**
	 * Provides stream information for Lavalink tracks.
	 *
	 * This method handles stream requests for tracks that are being played on Lavalink:
	 * - Checks if the track is currently playing on Lavalink
	 * - Verifies the track matches the requested track
	 * - Ensures the node connection is active
	 * - Returns stream metadata for Lavalink playback
	 *
	 * @param _context - Extension context containing the player instance
	 * @param payload - Stream request payload containing the track
	 * @returns Stream info for Lavalink playback, or null if not applicable
	 *
	 * @example
	 * const streamInfo = await lavalinkExt.provideStream(context, {
	 *   track: trackInstance
	 * });
	 *
	 * if (streamInfo) {
	 *   console.log("Stream provided by Lavalink");
	 * }
	 */
	async provideStream(_context: ExtensionContext, payload: ExtensionStreamRequest): Promise<StreamInfo | null> {
		try {
			const track = payload.track;
			const state = this.playerStateManager.getState(_context.player);

			// Chỉ cung cấp stream nếu có node Lavalink và đang phát
			if (!state?.node || !state.playing || !state.track) {
				this.debug(`provideStream: No Lavalink node or not playing, letting plugin handle`);
				return null;
			}

			const currentTrack = state.track;
			if (getEncoded(currentTrack) !== getEncoded(track)) {
				this.debug(`provideStream: Track mismatch, letting plugin handle`);
				return null;
			}

			// Kiểm tra node có kết nối không
			if (!state.node.connected || !state.node.wsConnected) {
				this.debug(`provideStream: Node not connected, letting plugin handle`);
				return null;
			}

			return {
				stream: null as any,
				type: "arbitrary",
				metadata: {
					lavalink: true,
					node: state.node.identifier,
					encoded: getEncoded(track),
				},
			};
		} catch (error) {
			this.debug(`provideStream error: ${(error as Error).message}`);
			return null;
		}
	}

	private async ensureNodeForPlayer(player: Player): Promise<any> {
		let state = this.playerStateManager.getState(player);
		if (!state) {
			this.attachToPlayer(player);
			state = this.playerStateManager.getState(player);
		}
		if (!state) throw new Error("Missing player state");

		let node = state.node;
		const needsNewNode = !node || !node.connected || !node.wsConnected || !node.sessionId;

		if (needsNewNode) {
			const picked = this.nodeManager.selectNode(this.options.nodeSort);
			if (!picked) throw new Error("No Lavalink nodes available");
			node = picked;
			this.playerStateManager.setPlayerNode(player, node);
			this.debug(`Assigned node ${node.identifier} to guild ${player.guildId}`);
		}

		// Only send voice update if we got a new node or if voice state is complete but not yet sent
		const shouldSendVoiceUpdate =
			needsNewNode &&
			state.voiceState?.sessionId &&
			state.voiceServer?.token &&
			state.voiceServer?.endpoint &&
			!state.voiceUpdateSent;

		if (shouldSendVoiceUpdate && node) {
			await this.voiceHandler.sendVoiceUpdate(node, player.guildId, state);
			state.voiceUpdateSent = true;
		}

		return node;
	}

	private async connect(player: Player, channel: any): Promise<any> {
		const original = this.originalMethods.get(player)?.connect;
		const channelId: string | null = channel?.id ?? channel ?? null;
		if (!channelId) throw new Error("Invalid channel provided to connect");
		const guildId = player.guildId;
		const state = this.playerStateManager.getState(player);
		if (state) {
			state.channelId = channelId;
		}

		if (this.options.sendGatewayPayload) {
			await this.voiceHandler.connect(player, channel, this.options.sendGatewayPayload);
			await this.playerStateManager.waitForVoice(player, this.options.requestTimeoutMs);
			return null;
		}

		if (!original) throw new Error("Player connect method missing");
		const connection = await original(channel);
		await this.playerStateManager
			.waitForVoice(player, this.options.requestTimeoutMs)
			.catch((error) => this.debug(`Voice wait failed: ${error.message}`));
		return connection;
	}

	private async startNextOnLavalink(player: Player, ignoreLoop = false): Promise<boolean> {
		const node = await this.ensureNodeForPlayer(player);
		const state = this.playerStateManager.getState(player);
		if (!state) throw new Error("Missing state for player");

		const track = player.queue.next(ignoreLoop || state.skipNext);
		state.skipNext = false;
		if (!track) {
			if (player.queue.autoPlay()) {
				const nextAuto = player.queue.willNextTrack();
				if (nextAuto) {
					player.queue.addMultiple([nextAuto]);
					return this.startNextOnLavalink(player, true);
				}
			}
			state.playing = false;
			state.paused = false;
			state.track = null;

			player.emit("queueEnd");
			(player as any).scheduleLeave?.();
			return false;
		}

		(player as any).clearLeaveTimeout?.();
		await (player as any).generateWillNext?.();
		try {
			await this.playerStateManager.waitForVoice(player, this.options.requestTimeoutMs);
		} catch (error) {
			this.debug(`Voice readiness failed for ${player.guildId}`, error);
		}

		try {
			const isLavalinkTrack = track.source === "lavalink" || getEncoded(track);

			if (isLavalinkTrack) {
				// Track từ Lavalink, cố gắng encode
				await this.trackResolver.ensureTrackEncoded(player, track, track.requestedBy ?? "Unknown", this.nodeManager);
				const encoded = getEncoded(track);
				if (!encoded) throw new Error("Track has no Lavalink payload");
				track.metadata = {
					...(track.metadata ?? {}),
					lavalink: {
						...((track.metadata ?? {}).lavalink ?? {}),
						encoded,
						node: node.identifier,
					},
				};
				this.playerStateManager.setPlayerNode(player, node);
				state.track = track;
				state.playing = true;
				state.paused = false;

				await this.nodeManager.updatePlayer(node, player.guildId, {
					track: {
						encoded: encoded,
					},
					volume: player.volume ?? state.volume ?? 100,
				});
				return true;
			} else {
				// Track không phải từ Lavalink, để plugin xử lý
				this.debug(`Track ${track.title} is not from Lavalink, letting plugin handle`);
				return false;
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debug(`Failed to start track on Lavalink: ${err.message}`);

			// Nếu lỗi là "Track not found on Lavalink", để plugin xử lý
			if (err.message.includes("Track not found on Lavalink")) {
				this.debug(`Track not found on Lavalink, letting plugin handle: ${track.title}`);
				return false;
			}

			player.emit("playerError", err, track);
			return this.startNextOnLavalink(player, true);
		}
	}

	private async destroyLavalinkPlayer(player: Player): Promise<void> {
		const state = this.playerStateManager.getState(player);
		if (!state?.node) return;

		try {
			// First try to stop the player gracefully
			await this.nodeManager.updatePlayer(state.node, player.guildId, {
				track: null,
				paused: false,
			});

			// Small delay to ensure the update is processed
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Then destroy the player
			await this.nodeManager.destroyPlayer(state.node, player.guildId);
		} catch (error) {
			this.debug(`Failed to destroy Lavalink player for ${player.guildId}`, error);
		} finally {
			// Always clean up local state
			state.track = null;
			state.playing = false;
			state.paused = false;
		}
	}

	private pause(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (!state?.node || !state.playing || state.paused) return false;

		// Kiểm tra xem player có tồn tại trên Lavalink không
		if (!state.node.connected || !state.node.wsConnected || !state.node.sessionId) {
			this.debug(`Node not connected, cannot pause on Lavalink`);
			return false;
		}

		state.paused = true;
		const track = state.track ?? player.queue.currentTrack ?? undefined;
		if (track) player.emit("playerPause", track);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { paused: true })
			.catch((error) => this.debug(`Pause failed:`, error.message));
		return true;
	}

	private resume(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (!state?.node || !state.paused) return false;

		// Kiểm tra xem player có tồn tại trên Lavalink không
		if (!state.node.connected || !state.node.wsConnected || !state.node.sessionId) {
			this.debug(`Node not connected, cannot resume on Lavalink`);
			return false;
		}

		state.paused = false;
		const track = state.track ?? player.queue.currentTrack ?? undefined;
		if (track) player.emit("playerResume", track);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { paused: false })
			.catch((error) => this.debug(`Resume failed:`, error.message));
		return true;
	}

	private stop(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (!state?.node) return false;

		// Clear local state first
		player.queue.clear();
		state.track = null;
		state.playing = false;
		state.paused = false;
		player.emit("playerStop");

		// Destroy player on Lavalink first, then update (if needed)
		this.destroyLavalinkPlayer(player).catch((error) =>
			this.debug(`Failed to destroy Lavalink player during stop for ${player.guildId}`, error),
		);

		return true;
	}

	private async skip(player: Player): Promise<boolean> {
		const state = this.playerStateManager.getState(player);
		if (!state?.node) return false;

		// Kiểm tra xem player có tồn tại trên Lavalink không
		if (!state.node.connected || !state.node.wsConnected || !state.node.sessionId) {
			this.debug(`Node not connected, cannot skip on Lavalink`);
			return false;
		}

		// Kiểm tra xem có track đang phát không
		if (!state.playing || !state.track) {
			this.debug(`No track playing, cannot skip on Lavalink`);
			return false;
		}

		// Gửi request skip trực tiếp đến Lavalink
		await this.nodeManager.updatePlayer(state.node, player.guildId, {
			track: null,
			paused: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		return true;
	}

	private setVolume(player: Player, volume: number): boolean {
		if (volume < 0 || volume > 200) return false;
		const state = this.playerStateManager.getState(player);
		if (!state?.node) {
			const original = this.originalMethods.get(player)?.setVolume;
			return original ? original(volume) : false;
		}

		// Kiểm tra xem player có tồn tại trên Lavalink không
		if (!state.node.connected || !state.node.wsConnected || !state.node.sessionId) {
			this.debug(`Node not connected, cannot set volume on Lavalink`);
			// Vẫn cập nhật local volume
			const old = player.volume ?? 100;
			player.volume = volume;
			state.volume = volume;
			player.emit("volumeChange", old, volume);
			return true;
		}

		const old = player.volume ?? 100;
		player.volume = volume;
		state.volume = volume;
		player.emit("volumeChange", old, volume);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { volume })
			.catch((error) => this.debug(`Failed to set volume:`, error.message));
		return true;
	}

	// Fallback methods - kiểm tra xem có thể xử lý bằng Lavalink không, nếu không thì fallback về plugin
	private async skipWithFallback(player: Player): Promise<boolean> {
		const state = this.playerStateManager.getState(player);

		// Nếu không có Lavalink node hoặc không đang phát track Lavalink, giao cho Player
		if (!state?.node || !state.playing || !state.track) {
			this.debug(`No Lavalink node or not playing Lavalink track, delegating to Player`);
			const original = this.originalMethods.get(player)?.skip;
			return original ? original() : false;
		}

		// Kiểm tra xem node có kết nối không
		if (!state.node.connected || !state.node.wsConnected || !state.node.sessionId) {
			this.debug(`Lavalink node not connected, delegating to Player`);
			const original = this.originalMethods.get(player)?.skip;
			return original ? original() : false;
		}

		// Thử skip trên Lavalink
		try {
			const lavalinkResult = await this.skip(player);
			if (lavalinkResult) {
				this.debug(`Skip handled by Lavalink for guild ${player.guildId}`);
			} else {
				this.debug(`Skip failed, delegating to Player for guild ${player.guildId}`);
			}
		} catch (error) {
			this.debug(`Lavalink skip failed, delegating to Player:`, error);
		}

		// Fallback về Player method
		this.debug(`Delegating skip to Player for guild ${player.guildId}`);
		const original = this.originalMethods.get(player)?.skip;
		return original ? original() : false;
	}

	private stopWithFallback(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (state?.node) {
			return this.stop(player);
		}
		// Fallback về plugin method
		const original = this.originalMethods.get(player)?.stop;
		return original ? original() : false;
	}

	private pauseWithFallback(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (state?.node && state.playing && state.track) {
			return this.pause(player);
		}
		// Fallback về plugin method
		const original = this.originalMethods.get(player)?.pause;
		return original ? original() : false;
	}

	private resumeWithFallback(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (state?.node && state.paused && state.track) {
			return this.resume(player);
		}
		// Fallback về plugin method
		const original = this.originalMethods.get(player)?.resume;
		return original ? original() : false;
	}

	private setVolumeWithFallback(player: Player, volume: number): boolean {
		const state = this.playerStateManager.getState(player);
		if (state?.node) {
			return this.setVolume(player, volume);
		}
		// Fallback về plugin method
		const original = this.originalMethods.get(player)?.setVolume;
		return original ? original(volume) : false;
	}
}
