import { BaseExtension, Player, PlayerManager, Track, SearchResult } from "ziplayer";
import axios from "axios";

import type {
	ExtensionContext,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionSearchRequest,
	ExtensionStreamRequest,
	StreamInfo,
} from "ziplayer";

import type { Client } from "discord.js";
import type {
	InternalNode,
	LavalinkNodeOptions,
	LavalinkExtOptions,
	LavalinkPlayerState,
	LavalinkWebSocketMessage,
	LavalinkReadyMessage,
	LavalinkStatsMessage,
	LavalinkPlayerUpdateMessage,
	LavalinkEventMessage,
	LavalinkRawTrack,
	LavalinkPlaylistData,
	VoiceServerRawEvent,
} from "./types/lavalink";

import WebSocket from "ws";

export class WebSocketHandler {
	private debug: (message: string, ...optional: any[]) => void;
	private eventCallbacks: Map<string, ((node: InternalNode, data: any) => void)[]> = new Map();

	constructor(debug: boolean) {
		this.debug = (message: string, ...optional: any[]) => {
			if (!debug) return;
			const formatted = `[WebSocketHandler] ${message}`;
			console.log(formatted, ...optional);
		};
	}

	async connectWebSocket(node: InternalNode, userId: string, clientName: string): Promise<void> {
		if (!userId) {
			throw new Error("User ID is required for WebSocket connection");
		}

		const secure = node.secure ?? true;
		const port = node.port ?? (secure ? 443 : 2333);
		const wsProtocol = secure ? "wss" : "ws";
		const wsURL = `${wsProtocol}://${node.host}:${port}/v4/websocket`;

		const headers = {
			Authorization: node.password,
			"User-Id": userId,
			"Client-Name": clientName,
			...(node.sessionId && { "Session-Id": node.sessionId }),
		};

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(wsURL, { headers });
			node.ws = ws;

			ws.on("open", () => {
				this.debug(`WebSocket connected to ${node.identifier}`);
				node.wsConnected = true;
				node.wsReconnectAttempts = 0;
			});

			ws.on("message", (data: Buffer) => {
				try {
					const message = JSON.parse(data.toString()) as LavalinkWebSocketMessage;
					this.handleWebSocketMessage(node, message);
				} catch (error) {
					this.debug(`Failed to parse WebSocket message from ${node.identifier}`, error);
				}
			});

			ws.on("close", (code: number, reason: Buffer) => {
				this.debug(`WebSocket closed for ${node.identifier}: ${code} ${reason.toString()}`);
				node.wsConnected = false;
				node.ws = undefined;

				// Auto-reconnect if not manually closed
				if (code !== 1000 && node.wsReconnectAttempts < node.maxReconnectAttempts) {
					node.wsReconnectAttempts++;
					this.debug(
						`Attempting to reconnect WebSocket for ${node.identifier} (${node.wsReconnectAttempts}/${node.maxReconnectAttempts})`,
					);
					setTimeout(() => {
						this.connectWebSocket(node, userId, clientName).catch((error) =>
							this.debug(`WebSocket reconnection failed for ${node.identifier}`, error),
						);
					}, 5000 * node.wsReconnectAttempts);
				}
			});

			ws.on("error", (error: Error) => {
				this.debug(`WebSocket error for ${node.identifier}`, error);
				node.wsConnected = false;
				reject(error);
			});

			// Resolve after ready event is received
			const originalHandleMessage = this.handleWebSocketMessage.bind(this);
			this.handleWebSocketMessage = (node: InternalNode, message: LavalinkWebSocketMessage) => {
				if (message.op === "ready") {
					resolve();
				}
				originalHandleMessage(node, message);
			};
		});
	}

	private handleWebSocketMessage(node: InternalNode, message: LavalinkWebSocketMessage): void {
		switch (message.op) {
			case "ready": {
				const readyMsg = message as LavalinkReadyMessage;
				node.sessionId = readyMsg.sessionId;
				this.debug(`Node ${node.identifier} session ready: ${readyMsg.sessionId} (resumed: ${readyMsg.resumed})`);
				break;
			}
			case "stats": {
				const statsMsg = message as LavalinkStatsMessage;
				node.stats = {
					players: statsMsg.players,
					playingPlayers: statsMsg.playingPlayers,
					uptime: statsMsg.uptime,
					memory: statsMsg.memory,
					cpu: statsMsg.cpu,
					frameStats: statsMsg.frameStats,
				};
				this.debug(`Node ${node.identifier} stats updated`, node.stats);
				break;
			}
			case "playerUpdate": {
				const playerUpdateMsg = message as LavalinkPlayerUpdateMessage;
				this.handlePlayerUpdate(node, playerUpdateMsg);
				break;
			}
			case "event": {
				const eventMsg = message as LavalinkEventMessage;
				this.handleLavalinkEvent(node, eventMsg);
				break;
			}
			default:
				this.debug(`Unknown WebSocket message type: ${message.op}`);
		}
	}

	private handlePlayerUpdate(node: InternalNode, message: LavalinkPlayerUpdateMessage): void {
		this.debug(`Player update for guild ${message.guildId} on node ${node.identifier}`);
		this.emit("playerUpdate", node, message);
	}

	private handleLavalinkEvent(node: InternalNode, message: LavalinkEventMessage): void {
		this.debug(`Lavalink event ${message.type} for guild ${message.guildId} on node ${node.identifier}`);
		this.emit("event", node, message);
		this.emit(message.type, node, message);
	}

	closeWebSocket(node: InternalNode): void {
		if (node.ws) {
			// Close with a different code to indicate graceful shutdown
			node.ws.close(1001, "Extension destroyed");
			node.ws = undefined;
			node.wsConnected = false;
		}
	}

	closeAllWebSockets(nodes: InternalNode[]): void {
		for (const node of nodes) {
			this.closeWebSocket(node);
		}
	}

	// Event callback system
	on(event: string, callback: (node: InternalNode, data: any) => void): void {
		if (!this.eventCallbacks.has(event)) {
			this.eventCallbacks.set(event, []);
		}
		this.eventCallbacks.get(event)!.push(callback);
	}

	off(event: string, callback: (node: InternalNode, data: any) => void): void {
		const callbacks = this.eventCallbacks.get(event);
		if (callbacks) {
			const index = callbacks.indexOf(callback);
			if (index > -1) {
				callbacks.splice(index, 1);
			}
		}
	}

	private emit(event: string, node: InternalNode, data: any): void {
		const callbacks = this.eventCallbacks.get(event);
		if (callbacks) {
			for (const callback of callbacks) {
				try {
					callback(node, data);
				} catch (error) {
					this.debug(`Error in event callback for ${event}`, error);
				}
			}
		}
	}
}

/**
 * Manages player states and voice connection handling for Lavalink players.
 *
 * This class handles:
 * - Player state tracking and synchronization
 * - Voice connection state management
 * - Voice server and state update handling
 * - Player-to-node mapping and assignment
 * - Voice connection timeout and error handling
 *
 * @example
 * ```typescript
 * const stateManager = new PlayerStateManager(true); // debug enabled
 *
 * // Attach a player
 * stateManager.attachPlayer(player);
 *
 * // Handle voice updates
 * stateManager.handleVoiceServerUpdate(guildId, voiceServerData);
 * stateManager.handleVoiceStateUpdate(guildId, voiceStateData, userId);
 *
 * // Wait for voice connection
 * await stateManager.waitForVoice(player, 15000);
 * ```
 *
 * @since 1.0.0
 */
export class PlayerStateManager {
	private playerStates = new WeakMap<Player, LavalinkPlayerState>();
	private guildMap = new Map<string, Player>();
	private voiceWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private debug: (message: string, ...optional: any[]) => void;

	/**
	 * Creates a new PlayerStateManager instance.
	 *
	 * @param debug - Whether to enable debug logging
	 *
	 * @example
	 * ```typescript
	 * const stateManager = new PlayerStateManager(true);
	 * ```
	 */
	constructor(debug: boolean) {
		this.debug = (message: string, ...optional: any[]) => {
			if (!debug) return;
			const formatted = `[PlayerStateManager] ${message}`;
			console.log(formatted, ...optional);
		};
	}

	/**
	 * Attaches a player to the state manager.
	 *
	 * This method initializes the player state and sets up tracking:
	 * - Creates a new state object for the player
	 * - Maps the guild ID to the player for quick lookup
	 * - Initializes default state values
	 *
	 * @param player - The player instance to attach
	 *
	 * @example
	 * ```typescript
	 * stateManager.attachPlayer(player);
	 * ```
	 */
	attachPlayer(player: Player): void {
		if (!player) return;
		this.guildMap.set(player.guildId, player);

		if (!this.playerStates.has(player)) {
			this.playerStates.set(player, {
				playing: false,
				paused: false,
				volume: player.volume ?? 100,
				skipNext: false,
				awaitingNode: false,
				awaitingTrack: false,
				voiceTimeout: null,
				lastPosition: 0,
				autoPlayChecked: false,
				voiceUpdateSent: false,
			});
		}
	}

	/**
	 * Detaches a player from the state manager.
	 *
	 * This method cleans up the player state and removes tracking:
	 * - Removes the player from the guild mapping
	 * - Cleans up voice waiters for the guild
	 * - Removes the player state from tracking
	 * - Removes the player from the assigned node
	 *
	 * @param player - The player instance to detach
	 *
	 * @example
	 * ```typescript
	 * stateManager.detachPlayer(player);
	 * ```
	 */
	detachPlayer(player: Player): void {
		const state = this.playerStates.get(player);
		if (state?.node) {
			state.node.players.delete(player.guildId);
		}
		if (player.guildId) {
			this.voiceWaiters.get(player.guildId)?.reject(new Error("Player detached"));
			this.voiceWaiters.delete(player.guildId);
		}
		this.playerStates.delete(player);
		this.guildMap.delete(player.guildId);
	}

	getState(player: Player): LavalinkPlayerState | undefined {
		return this.playerStates.get(player);
	}

	setState(player: Player, state: Partial<LavalinkPlayerState>): void {
		const currentState = this.playerStates.get(player);
		if (currentState) {
			Object.assign(currentState, state);
		}
	}

	getPlayerByGuildId(guildId: string): Player | undefined {
		return this.guildMap.get(guildId);
	}

	/**
	 * Handles voice server update events from Discord.
	 *
	 * This method processes voice server updates that contain:
	 * - Voice server token for authentication
	 * - Voice server endpoint for connection
	 * - Guild ID for identification
	 *
	 * @param guildId - Discord guild ID
	 * @param data - Voice server update data from Discord
	 *
	 * @example
	 * ```typescript
	 * stateManager.handleVoiceServerUpdate("123456789", {
	 *   token: "voice_token",
	 *   endpoint: "voice.example.com",
	 *   guild_id: "123456789"
	 * });
	 * ```
	 */
	handleVoiceServerUpdate(guildId: string, data: any): void {
		const player = this.guildMap.get(guildId);
		if (!player) return;

		const state = this.playerStates.get(player);
		if (!state) return;

		const token: string | undefined = data?.token;
		if (!token) return;
		const endpoint: string | null = typeof data?.endpoint === "string" ? data.endpoint : null;
		const resolvedGuildId = String(data?.guild_id ?? data?.guildId ?? guildId);
		const rawEvent: VoiceServerRawEvent = {
			...(typeof data === "object" && data !== null ? data : {}),
			token,
			endpoint,
			guild_id: resolvedGuildId,
		};
		if ("guildId" in rawEvent) {
			delete rawEvent.guildId;
		}
		state.voiceServer = {
			token,
			endpoint,
			guildId: resolvedGuildId,
			rawEvent,
		};
		console.log({
			sessionId: state.voiceState?.sessionId,
			token: !!state.voiceServer?.token,
			endpoint: state.voiceServer?.endpoint,
		});
		this.debug(`VOICE_SERVER_UPDATE for guild ${guildId}`);
	}

	/**
	 * Handles voice state update events from Discord.
	 *
	 * This method processes voice state updates that contain:
	 * - Session ID for voice connection
	 * - Channel ID for voice channel
	 * - User ID for verification
	 *
	 * @param guildId - Discord guild ID
	 * @param data - Voice state update data from Discord
	 * @param userId - Discord user ID to verify against
	 *
	 * @example
	 * ```typescript
	 * stateManager.handleVoiceStateUpdate("123456789", {
	 *   session_id: "session_123",
	 *   channel_id: "456789012",
	 *   user_id: "789012345"
	 * }, "789012345");
	 * ```
	 */
	handleVoiceStateUpdate(guildId: string, data: any, userId: string): void {
		const player = this.guildMap.get(guildId);
		if (!player) return;

		const state = this.playerStates.get(player);
		if (!state) return;

		const userIdFromData = data?.user_id ?? data?.userId;
		if (userId && userIdFromData !== userId) return;

		state.voiceState = {
			sessionId: data?.session_id ?? null,
			channelId: data?.channel_id ?? null,
		};
		state.channelId = data?.channel_id ?? null;
		this.debug(`VOICE_STATE_UPDATE for guild ${guildId} (channel ${state.channelId ?? "null"})`);

		if (!state.channelId) {
			state.playing = false;
			state.paused = false;
			state.track = null;
			state.awaitingTrack = false;
		}
	}

	/**
	 * Waits for voice connection to be established for a player.
	 *
	 * This method waits until both voice server and voice state updates
	 * have been received, indicating the voice connection is ready.
	 *
	 * @param player - The player to wait for voice connection
	 * @param timeoutMs - Timeout in milliseconds (default: 15000)
	 * @returns Promise that resolves when voice is ready or rejects on timeout
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   await stateManager.waitForVoice(player, 10000);
	 *   console.log("Voice connection ready!");
	 * } catch (error) {
	 *   console.log("Voice connection timed out");
	 * }
	 * ```
	 */
	waitForVoice(player: Player, timeoutMs: number = 15000): Promise<void> {
		const state = this.playerStates.get(player);
		if (!state) return Promise.resolve();
		if (state.voiceState?.sessionId && state.voiceServer?.token && state.voiceServer?.endpoint) {
			return Promise.resolve();
		}

		const guildId = player.guildId;
		if (this.voiceWaiters.has(guildId)) {
			return new Promise((resolve, reject) => {
				const existing = this.voiceWaiters.get(guildId)!;
				const originalResolve = existing.resolve;
				const originalReject = existing.reject;
				existing.resolve = () => {
					originalResolve();
					resolve();
				};
				existing.reject = (error: Error) => {
					originalReject(error);
					reject(error);
				};
			});
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.voiceWaiters.delete(guildId);
				reject(new Error("Voice connection timed out"));
			}, timeoutMs);
			this.voiceWaiters.set(guildId, {
				resolve: () => {
					clearTimeout(timer);
					this.voiceWaiters.delete(guildId);
					resolve();
				},
				reject: (error: Error) => {
					clearTimeout(timer);
					this.voiceWaiters.delete(guildId);
					reject(error);
				},
				timer,
			});
		});
	}

	resolveVoiceWaiter(guildId: string): void {
		this.voiceWaiters.get(guildId)?.resolve();
		this.voiceWaiters.delete(guildId);
	}

	rejectVoiceWaiter(guildId: string, error: Error): void {
		this.voiceWaiters.get(guildId)?.reject(error);
		this.voiceWaiters.delete(guildId);
	}

	getAllPlayers(): Player[] {
		return Array.from(this.guildMap.values());
	}

	getAllStates(): Map<Player, LavalinkPlayerState> {
		const states = new Map<Player, LavalinkPlayerState>();
		for (const player of this.guildMap.values()) {
			const state = this.playerStates.get(player);
			if (state) {
				states.set(player, state);
			}
		}
		return states;
	}

	updatePlayerPosition(player: Player, position: number): void {
		const state = this.playerStates.get(player);
		if (state) {
			state.lastPosition = position;
		}
	}

	setPlayerNode(player: Player, node: InternalNode): void {
		const state = this.playerStates.get(player);
		if (state) {
			// Reset voice update sent flag when node changes
			state.voiceUpdateSent = false;
			state.node = node;
			node.players.add(player.guildId);
		}
	}

	clearPlayerNode(player: Player): void {
		const state = this.playerStates.get(player);
		if (state?.node) {
			state.node.players.delete(player.guildId);
			state.node = undefined;
		}
	}

	destroy(): void {
		// Clear all voice waiters
		for (const [guildId, waiter] of this.voiceWaiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("PlayerStateManager destroyed"));
		}
		this.voiceWaiters.clear();
		this.playerStates = new WeakMap();
		this.guildMap.clear();
	}
}

/**
 * Manages Lavalink node connections and operations.
 *
 * This class handles:
 * - Connection management to multiple Lavalink nodes
 * - Load balancing and node selection strategies
 * - REST API operations for track loading and player management
 * - WebSocket event handling for real-time updates
 * - Automatic failover and reconnection
 *
 * @example
 * ```typescript
 * const nodeManager = new NodeManager({
 *   nodes: [
 *     { host: "localhost", port: 2333, password: "youshallnotpass" },
 *     { host: "backup.example.com", port: 443, password: "backup", secure: true }
 *   ],
 *   debug: true
 * });
 *
 * // Initialize connections
 * await nodeManager.initializeConnections("botUserId", "MyBot");
 *
 * // Select best node
 * const node = nodeManager.selectNode("players");
 * ```
 *
 * @since 1.0.0
 */
export class NodeManager {
	private nodes: InternalNode[] = [];
	private wsHandler: WebSocketHandler;
	private debug: (message: string, ...optional: any[]) => void;

	/**
	 * Creates a new NodeManager instance.
	 *
	 * @param options - Lavalink extension options containing node configurations
	 * @param options.nodes - Array of Lavalink node configurations
	 * @param options.debug - Enable debug logging (optional)
	 * @param options.clientName - Client name for identification (optional)
	 * @param options.requestTimeoutMs - Request timeout in milliseconds (optional)
	 *
	 * @example
	 * ```typescript
	 * const nodeManager = new NodeManager({
	 *   nodes: [
	 *     { host: "localhost", port: 2333, password: "youshallnotpass" }
	 *   ],
	 *   debug: true,
	 *   clientName: "MyBot",
	 *   requestTimeoutMs: 10000
	 * });
	 * ```
	 */
	constructor(options: LavalinkExtOptions) {
		this.debug = (message: string, ...optional: any[]) => {
			if (!options.debug) return;
			const formatted = `[NodeManager] ${message}`;
			console.log(formatted, ...optional);
		};
		this.wsHandler = new WebSocketHandler(options.debug ?? false);
		this.initializeNodes(options);
	}

	private initializeNodes(options: LavalinkExtOptions): void {
		for (const config of options.nodes) {
			this.nodes.push(this.createNode(config, options));
		}
	}

	private createNode(config: LavalinkNodeOptions, options: LavalinkExtOptions): InternalNode {
		const secure = config.secure ?? true;
		const port = config.port ?? (secure ? 443 : 2333);
		const identifier = config.identifier ?? `${config.host}:${port}`;
		const protocol = secure ? "https" : "http";
		const baseURL = `${protocol}://${config.host}:${port}`;
		const headers: Record<string, string> = {
			Authorization: config.password,
			"Client-Name": options.clientName ?? `ziplayer-extension/3.0.0`,
			// "User-Agent": "Lavalink-Client/4.0.0", // Changed from browser UA
			Accept: "application/json", // Explicitly ask for JSON
			"Content-Type": "application/json",
		};
		const rest = axios.create({
			baseURL,
			timeout: options.requestTimeoutMs ?? 10_000,
			headers,
			maxRedirects: 0, // Don't follow redirects
			validateStatus: () => true,
		});

		rest.interceptors.response.use(
			(response) => {
				// Check if response is HTML instead of JSON
				const contentType = response.headers["content-type"];
				const isHtmlResponse =
					typeof contentType === "string" ? contentType.includes("text/html")
					: Array.isArray(contentType) ? contentType.some((value) => value.includes("text/html"))
					: false;
				if (isHtmlResponse) {
					throw new Error(`Lavalink node returned HTML instead of JSON. The node may be misconfigured or blocked.`);
				}
				return response;
			},
			(error) => Promise.reject(error),
		);

		return {
			...config,
			identifier,
			port,
			secure,
			rest,
			connected: false,
			wsConnected: false,
			lastPing: undefined,
			players: new Set<string>(),
			wsReconnectAttempts: 0,
			maxReconnectAttempts: 5,
		};
	}

	/**
	 * Initializes connections to all configured Lavalink nodes.
	 *
	 * This method tests connections to all nodes and establishes WebSocket
	 * connections for real-time event handling. It runs in parallel for
	 * all nodes to minimize initialization time.
	 *
	 * @param userId - Discord user ID of the bot
	 * @param clientName - Name to identify this client to Lavalink nodes
	 *
	 * @example
	 * ```typescript
	 * await nodeManager.initializeConnections("123456789012345678", "MyMusicBot");
	 * ```
	 */
	async initializeConnections(userId: string, clientName: string): Promise<void> {
		this.debug("Initializing node connections");

		await Promise.all(
			this.nodes.map((node) =>
				this.testNodeConnection(node, userId, clientName).catch((error) =>
					this.debug(`Failed to test node ${node.identifier}`, error),
				),
			),
		);
	}

	private async testNodeConnection(node: InternalNode, userId: string, clientName: string): Promise<void> {
		try {
			const response = await node.rest.get("/version");
			node.connected = true;
			this.debug(`Node ${node.identifier} connected successfully`);
			// Connect WebSocket to get sessionId
			await this.wsHandler.connectWebSocket(node, userId, clientName);
		} catch (error) {
			node.connected = false;
			this.debug(`Node ${node.identifier} connection failed`, error);
		}
	}

	/**
	 * Selects the best available node based on the specified strategy.
	 *
	 * This method chooses the optimal node for new players based on:
	 * - Current player count (default strategy)
	 * - CPU usage (lowest first)
	 * - Memory usage (lowest first)
	 * - Random selection
	 *
	 * @param nodeSort - Node selection strategy (default: "players")
	 * @returns The best available node, or null if no nodes are connected
	 *
	 * @example
	 * ```typescript
	 * // Select node with fewest players
	 * const node = nodeManager.selectNode("players");
	 *
	 * // Select node with lowest CPU usage
	 * const cpuNode = nodeManager.selectNode("cpu");
	 *
	 * // Select random available node
	 * const randomNode = nodeManager.selectNode("random");
	 * ```
	 */
	selectNode(nodeSort: "players" | "cpu" | "memory" | "random" = "players"): InternalNode | null {
		const connected = this.nodes.filter((node) => node.connected && node.wsConnected && node.sessionId);
		if (connected.length === 0) return null;

		switch (nodeSort) {
			case "cpu":
				connected.sort((a, b) => {
					const aLoad = a.stats?.cpu?.systemLoad ?? Number.POSITIVE_INFINITY;
					const bLoad = b.stats?.cpu?.systemLoad ?? Number.POSITIVE_INFINITY;
					return aLoad - bLoad;
				});
				break;
			case "memory":
				connected.sort((a, b) => {
					const aMem = a.stats?.memory?.used ?? Number.POSITIVE_INFINITY;
					const bMem = b.stats?.memory?.used ?? Number.POSITIVE_INFINITY;
					return aMem - bMem;
				});
				break;
			case "random":
				return connected[Math.floor(Math.random() * connected.length)];
			case "players":
			default:
				connected.sort((a, b) => a.players.size - b.players.size);
		}
		return connected[0] ?? null;
	}

	getNode(identifier: string): InternalNode | undefined {
		return this.nodes.find((node) => node.identifier === identifier);
	}

	getAllNodes(): InternalNode[] {
		return [...this.nodes];
	}

	/**
	 * Loads tracks from a Lavalink node using the specified identifier.
	 *
	 * This method queries a Lavalink node for tracks using various identifiers:
	 * - Direct URLs (YouTube, SoundCloud, etc.)
	 * - Search queries with prefixes (e.g., "ytsearch:", "scsearch:")
	 * - Track identifiers
	 *
	 * @param node - The Lavalink node to query
	 * @param identifier - Track identifier or search query
	 * @returns Track loading result from Lavalink
	 * @throws {Error} If the request fails
	 *
	 * @example
	 * ```typescript
	 * const result = await nodeManager.loadTracks(node, "ytsearch:Never Gonna Give You Up");
	 * console.log(`Found ${result.tracks.length} tracks`);
	 * ```
	 */
	async loadTracks(node: InternalNode, identifier: string): Promise<any> {
		this.debug(`Loading tracks from node ${node.identifier} identifier=${identifier}`);
		const res = await node.rest.get(`/v4/loadtracks`, { params: { identifier } }).catch((error: any) => {
			this.debug(`loadTracks request failed for ${node.identifier} id=${identifier}`, error);
			throw error;
		});
		this.debug(`loadTracks response for ${node.identifier} id=${identifier} loadType=${res.data?.loadType}`);
		console.log(res.data);
		return res.data;
	}

	/**
	 * Updates a player on a Lavalink node.
	 *
	 * This method sends player updates to Lavalink including:
	 * - Track changes
	 * - Volume adjustments
	 * - Pause/resume states
	 * - Position updates
	 *
	 * @param node - The Lavalink node to update the player on
	 * @param guildId - Discord guild ID of the player
	 * @param payload - Player update payload
	 *
	 * @example
	 * ```typescript
	 * await nodeManager.updatePlayer(node, "123456789", {
	 *   track: { encoded: "trackData" },
	 *   volume: 50,
	 *   paused: false
	 * });
	 * ```
	 */
	async updatePlayer(node: InternalNode, guildId: string, payload: Record<string, any>): Promise<void> {
		try {
			const payl = await node.rest.patch(`/v4/sessions/${node.sessionId}/players/${guildId}`, payload);
			console.log(payl);
		} catch (error: any) {
			// Don't throw if the connection is already closed, player doesn't exist, or bad request
			if (
				error.response?.status === 404 ||
				error.response?.status === 400 ||
				error.code === "ECONNRESET" ||
				error.code === "ECONNREFUSED"
			) {
				this.debug(`Player ${guildId} not found, bad request, or connection closed, skipping update`);
				return;
			}
			throw error;
		}
	}

	async destroyPlayer(node: InternalNode, guildId: string): Promise<void> {
		try {
			await node.rest.delete(`/v4/sessions/${node.sessionId}/players/${guildId}`);
		} catch (error: any) {
			// Don't log as error if the player doesn't exist or connection is closed
			if (error.response?.status === 404 || error.code === "ECONNRESET" || error.code === "ECONNREFUSED") {
				this.debug(`Player ${guildId} already destroyed or connection closed`);
			} else {
				this.debug(`Failed to destroy Lavalink player for ${guildId}`, error);
			}
		} finally {
			node.players.delete(guildId);
		}
	}

	async getPlayerInfo(node: InternalNode, guildId: string): Promise<any> {
		const response = await node.rest.get(`/v4/sessions/${node.sessionId}/players/${guildId}`);
		return response.data;
	}

	closeAllConnections(): void {
		this.wsHandler.closeAllWebSockets(this.nodes);
	}

	// Expose WebSocket event handling
	onWebSocketEvent(event: string, callback: (node: InternalNode, data: any) => void): void {
		this.wsHandler.on(event, callback);
	}

	offWebSocketEvent(event: string, callback: (node: InternalNode, data: any) => void): void {
		this.wsHandler.off(event, callback);
	}

	destroy(): void {
		this.closeAllConnections();
		this.nodes = [];
	}
}

export class TrackResolver {
	private debug: (message: string, ...optional: any[]) => void;

	constructor(debug: boolean) {
		this.debug = (message: string, ...optional: any[]) => {
			if (!debug) return;
			const formatted = `[TrackResolver] ${message}`;
			console.log(formatted, ...optional);
		};
	}

	mapToTrack(raw: LavalinkRawTrack, requestedBy: string): Track {
		const track: Track = {
			id: raw.info.identifier,
			title: raw.info.title,
			url: raw.info.uri ?? raw.info.identifier,
			duration: raw.info.length ?? 0,
			thumbnail: raw.info.artworkUrl ?? undefined,
			requestedBy,
			source: raw.info.sourceName ?? "lavalink",
			metadata: {
				lavalink: {
					encoded: raw.encoded,
					info: raw.info,
					pluginInfo: raw.pluginInfo ?? {},
					node: null,
				},
			},
		};
		return track;
	}

	resolveTrackFromLavalink(player: any, raw: LavalinkRawTrack): Track | null {
		if (!raw) return null;
		const current = player.queue.currentTrack;
		if (current && getEncoded(current) === raw.encoded) return current;
		const upcoming = player.queue.getTracks();
		for (const track of [current, ...upcoming]) {
			if (track && getEncoded(track) === raw.encoded) return track;
		}
		return {
			id: raw.info.identifier,
			title: raw.info.title,
			url: raw.info.uri ?? raw.info.identifier,
			duration: raw.info.length ?? 0,
			thumbnail: raw.info.artworkUrl ?? undefined,
			requestedBy: current?.requestedBy ?? "Unknown",
			source: raw.info.sourceName ?? "lavalink",
			metadata: {
				...(current?.metadata ?? {}),
				lavalink: {
					encoded: raw.encoded,
					info: raw.info,
					pluginInfo: raw.pluginInfo,
					node: current?.metadata?.lavalink?.node ?? null,
				},
			},
		};
	}

	async ensureTrackEncoded(player: any, track: Track, requestedBy: string, nodeManager: any): Promise<void> {
		if (getEncoded(track)) return;
		const node = nodeManager.selectNode();
		if (!node) throw new Error("No Lavalink nodes available");

		// Nếu track.url là URL thì sử dụng trực tiếp, không thêm search prefix
		const identifier = track.url && isUrl(track.url) ? track.url : track.id || track.title;
		if (!identifier) throw new Error("Cannot resolve track identifier for Lavalink");

		this.debug(`Ensuring track encoded with identifier: ${identifier} (isUrl: ${isUrl(identifier)})`);

		const response = await nodeManager.loadTracks(node, identifier);

		// Kiểm tra response type
		if (response.loadType === "error") {
			const errorData = response.data as { message?: string; severity?: string } | null;
			throw new Error(errorData?.message ?? "Lavalink error");
		}

		if (response.loadType === "empty") {
			throw new Error("Track not found on Lavalink");
		}

		// FIX: Handle both 'track' and 'search' loadTypes
		let raw: LavalinkRawTrack | null = null;

		if (response.loadType === "track") {
			// For 'track' type, data is a single object
			raw = response.data as LavalinkRawTrack;
		} else if (response.loadType === "search" || response.loadType === "playlist") {
			// For 'search' or 'playlist' type, get first track from array
			const tracks =
				Array.isArray(response.data) ?
					(response.data as LavalinkRawTrack[])
				:	((response.data as LavalinkPlaylistData)?.tracks ?? []);
			raw = tracks[0];
		}

		if (!raw) throw new Error("Track not found on Lavalink");

		const mapped = this.mapToTrack(raw, requestedBy);
		track.metadata = mapped.metadata;
	}

	async resolvePlayRequest(
		player: any,
		query: string | Track,
		requestedBy: string,
		nodeManager: any,
		searchPrefix: string = "ytsearch",
	): Promise<{ tracks: Track[]; isPlaylist: boolean }> {
		if (typeof query === "string") {
			const result = await this.searchLavalink(query, requestedBy, nodeManager, searchPrefix);
			const mapped = result.tracks.map((track) => ({
				...track,
				requestedBy,
			}));
			return { tracks: mapped, isPlaylist: !!result.playlist };
		}

		// Handle Track object
		if (query && typeof query === "object" && typeof query.title === "string") {
			const clone: Track = {
				...query,
				requestedBy: query.requestedBy ?? requestedBy,
				metadata: { ...(query.metadata ?? {}) },
			};
			await this.ensureTrackEncoded(player, clone, requestedBy, nodeManager);
			return { tracks: [clone], isPlaylist: false };
		}

		throw new Error("Invalid play request");
	}

	async searchLavalink(
		query: string,
		requestedBy: string,
		nodeManager: any,
		searchPrefix: string = "ytsearch",
	): Promise<SearchResult> {
		const node = nodeManager.selectNode();
		if (!node) throw new Error("No Lavalink nodes connected");

		// Nếu query là URL thì sử dụng trực tiếp, không thêm search prefix
		const identifier = isUrl(query) ? query : `${searchPrefix}:${query}`;
		this.debug(`Searching with identifier: ${identifier} (isUrl: ${isUrl(query)})`);

		const response = await nodeManager.loadTracks(node, identifier);

		if (!response) throw new Error("Invalid response from Lavalink");

		switch (response.loadType) {
			case "error": {
				const data = response.data as { message?: string; severity?: string } | null;
				throw new Error(data?.message ?? "Lavalink error");
			}
			case "empty":
				throw new Error("No tracks found");
			case "playlist": {
				const playlist = response.data as LavalinkPlaylistData;
				const tracks = playlist.tracks.map((raw) => this.mapToTrack(raw, requestedBy));
				return {
					tracks,
					playlist: {
						name: playlist.info?.name ?? "Playlist",
						url: playlist.info?.url ?? identifier,
						thumbnail: playlist.info?.artworkUrl ?? undefined,
					},
				};
			}
			case "track": {
				// FIX: For 'track' loadType, response.data is a single track object, not an array
				const raw = response.data as LavalinkRawTrack;
				if (!raw) throw new Error("No track data received");
				return { tracks: [this.mapToTrack(raw, requestedBy)] };
			}
			case "search":
			default: {
				// For 'search' loadType, response.data is an array of tracks
				const list = Array.isArray(response.data) ? (response.data as LavalinkRawTrack[]) : [];
				const tracks = list.map((raw) => this.mapToTrack(raw, requestedBy));
				return { tracks };
			}
		}
	}
}

export class VoiceHandler {
	private debug: (message: string, ...optional: any[]) => void;

	constructor(debug: boolean) {
		this.debug = (message: string, ...optional: any[]) => {
			if (!debug) return;
			const formatted = `[VoiceHandler] ${message}`;
			console.log(formatted, ...optional);
		};
	}

	async sendVoiceUpdate(node: InternalNode, guildId: string, state: LavalinkPlayerState): Promise<void> {
		if (!state.voiceState?.sessionId || !state.voiceServer) return;

		const payload = {
			voice: {
				token: state.voiceServer.token,
				endpoint: state.voiceServer.endpoint,
				sessionId: state.voiceState.sessionId,
			},
		};
		await node.rest.patch(`/v4/sessions/${node.sessionId}/players/${guildId}`, payload);
	}

	async connect(
		player: Player,
		channel: any,
		sendGatewayPayload?: (guildId: string, payload: any) => Promise<void> | void,
	): Promise<any> {
		const channelId: string | null = channel?.id ?? channel ?? null;
		if (!channelId) throw new Error("Invalid channel provided to connect");
		const guildId = player.guildId;

		if (sendGatewayPayload) {
			await sendGatewayPayload(guildId, {
				op: 4,
				d: {
					guild_id: guildId,
					channel_id: channelId,
					self_deaf: player.options.selfDeaf ?? true,
					self_mute: player.options.selfMute ?? false,
				},
			});
			return null;
		}

		// Fallback to original connect method if no sendGatewayPayload provided
		throw new Error("sendGatewayPayload is required for voice connection");
	}

	handleRawEvent(packet: any, userId: string, playerStateManager: any, nodeManager: any): void {
		if (!packet || typeof packet !== "object") return;
		const t = packet.t as string | undefined;
		if (!t || (t !== "VOICE_STATE_UPDATE" && t !== "VOICE_SERVER_UPDATE")) return;

		const data: any = packet.d;
		const guildId: string | undefined = data?.guild_id ?? data?.guildId;
		if (!guildId) return;

		const player = playerStateManager.getPlayerByGuildId(guildId);
		if (!player) return;

		const state = playerStateManager.getState(player);
		if (!state) return;

		// Store previous voice state to check if update is needed
		const prevVoiceState = { ...state.voiceState };
		const prevVoiceServer = { ...state.voiceServer };
		console.log(t);
		if (t === "VOICE_SERVER_UPDATE") {
			playerStateManager.handleVoiceServerUpdate(guildId, data);
		} else if (t === "VOICE_STATE_UPDATE") {
			playerStateManager.handleVoiceStateUpdate(guildId, data, userId);
		}

		// Only send voice update if voice state actually changed and we have a node assigned
		const voiceStateChanged =
			prevVoiceState?.sessionId !== state.voiceState?.sessionId ||
			prevVoiceServer?.token !== state.voiceServer?.token ||
			prevVoiceServer?.endpoint !== state.voiceServer?.endpoint;

		if (
			voiceStateChanged &&
			state.voiceState?.sessionId &&
			state.voiceServer?.token &&
			state.voiceServer?.endpoint &&
			state.node
		) {
			playerStateManager.resolveVoiceWaiter(guildId);
			// Only send to the assigned node, not all nodes
			this.sendVoiceUpdate(state.node, guildId, state).catch((error) =>
				this.debug(`Failed to send voiceUpdate for ${guildId} to ${state.node.identifier}`, error),
			);
			// Mark voice update as sent
			state.voiceUpdateSent = true;
		}
	}
}

export const isTrack = (value: any): value is Track => value && typeof value === "object" && typeof value.title === "string";

export const isUrl = (value: string): boolean => {
	// Kiểm tra URL cơ bản
	if (!/^(https?:\/\/|wss?:\/\/)/i.test(value)) return false;

	try {
		// Kiểm tra các domain phổ biến cho music
		const musicDomains = [
			"youtube.com",
			"youtu.be",
			"m.youtube.com",
			"soundcloud.com",
			"m.soundcloud.com",
			"spotify.com",
			"open.spotify.com",
			"bandcamp.com",
			"music.apple.com",
			"twitch.tv",
			"vimeo.com",
		];

		const url = new URL(value);
		return musicDomains.some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain));
	} catch {
		// Nếu không parse được URL thì không phải URL hợp lệ
		return false;
	}
};

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getEncoded = (track: Track | null | undefined): string | null => {
	if (!track) return null;
	const encoded = (track as any)?.metadata?.lavalink?.encoded;
	return typeof encoded === "string" ? encoded : null;
};

export const createDebugLogger = (debug: boolean, prefix: string) => {
	return (message: string, ...optional: any[]) => {
		if (!debug) return;
		const formatted = `[${prefix}] ${message}`;
		console.log(formatted, ...optional);
	};
};

//#religon Main
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

	onRegister(context: ExtensionContext): void {
		this.attachToPlayer(context.player);
		this.startUpdateLoop();
	}

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
		if (message.reason === "finished" || message.reason === "loadFailed") {
			state.track = null;
			state.playing = false;

			if (!state.skipNext) {
				this.startNextOnLavalink(player).catch((error) => this.debug(`Failed to start next track for ${player.guildId}`, error));
			}
			state.skipNext = false;
		} else if (message.reason === "stopped" || message.reason === "replaced" || message.reason === "cleanup") {
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
				await this.updateNodePlayerState(player, state);
			} catch (error) {
				this.debug(`Failed to update player ${player.guildId}`, error);
			}
		}
	}

	private async updateNodePlayerState(player: Player, state: LavalinkPlayerState): Promise<void> {
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
			// throw error;
			return;
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

			(player as any).skip = () => this.skip(player);
			(player as any).stop = () => this.stop(player);
			(player as any).pause = () => this.pause(player);
			(player as any).resume = () => this.resume(player);
			(player as any).setVolume = (volume: number) => this.setVolume(player, volume);
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
			const success = shouldStart ? await this.startNextOnLavalink(player) : true;

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

	async provideStream(_context: ExtensionContext, payload: ExtensionStreamRequest): Promise<StreamInfo | null> {
		try {
			const track = payload.track;
			const state = this.playerStateManager.getState(_context.player);

			if (!state?.node || !state.playing || !state.track) {
				return null;
			}

			const currentTrack = state.track;
			if (getEncoded(currentTrack) !== getEncoded(track)) {
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

		// if (shouldSendVoiceUpdate && node) {
		// 	await this.voiceHandler.sendVoiceUpdate(node, player.guildId, state);
		// 	state.voiceUpdateSent = true;
		// }

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
			// ensure voice before play
			if (state.voiceState?.sessionId && state.voiceServer?.token && state.voiceServer?.endpoint) {
				await this.voiceHandler.sendVoiceUpdate(node, player.guildId, state);
				state.voiceUpdateSent = true;
			}

			// await this.nodeManager.updatePlayer(node, player.guildId, {
			// 	track: {
			// 		encoded: encoded,
			// 	},
			// 	volume: player.volume ?? state.volume ?? 100,
			// });
			const updatePayload: Record<string, any> = {};

			if (state.voiceState?.sessionId && state.voiceServer?.token && state.voiceServer?.endpoint) {
				const rawEndpoint = state.voiceServer.endpoint;
				const endpoint = rawEndpoint; //?.replace(/:\d+$/, "");

				updatePayload.voice = {
					token: state.voiceServer.token,
					endpoint,
					sessionId: state.voiceState.sessionId,
					channelId: state.channelId ?? state.voiceState.channelId,
				};
				state.voiceUpdateSent = true;

				await this.nodeManager.updatePlayer(node, player.guildId, updatePayload);
				await new Promise((r) => setTimeout(r, 300));
			}

			await this.nodeManager.updatePlayer(node, player.guildId, {
				track: { encoded: encoded },
				paused: false,
				volume: player.volume ?? state.volume ?? 100,
			});
			return true;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.debug(`Failed to start track on Lavalink: ${err.message}`);
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
				track: { encoded: null },
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
		state.paused = true;
		const track = state.track ?? player.queue.currentTrack ?? undefined;
		if (track) player.emit("playerPause", track);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { paused: true })
			.catch((error) => this.debug(`Pause failed`, error));
		return true;
	}

	private resume(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (!state?.node || !state.paused) return false;
		state.paused = false;
		const track = state.track ?? player.queue.currentTrack ?? undefined;
		if (track) player.emit("playerResume", track);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { paused: false })
			.catch((error) => this.debug(`Resume failed`, error));
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

	private skip(player: Player): boolean {
		const state = this.playerStateManager.getState(player);
		if (!state?.node) return false;
		state.skipNext = true;
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { track: { encoded: null } })
			.catch((error) => this.debug(`Skip failed`, error));
		return true;
	}

	private setVolume(player: Player, volume: number): boolean {
		if (volume < 0 || volume > 200) return false;
		const state = this.playerStateManager.getState(player);
		if (!state?.node) {
			const original = this.originalMethods.get(player)?.setVolume;
			return original ? original(volume) : false;
		}
		const old = player.volume ?? 100;
		player.volume = volume;
		state.volume = volume;
		player.emit("volumeChange", old, volume);
		this.nodeManager
			.updatePlayer(state.node, player.guildId, { volume })
			.catch((error) => this.debug(`Failed to set volume`, error));
		return true;
	}
}
