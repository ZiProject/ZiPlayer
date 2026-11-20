export type LavalinkLoadType = "track" | "playlist" | "search" | "empty" | "error";

export interface LavalinkRawTrack {
	encoded: string;
	info: {
		identifier: string;
		isSeekable?: boolean;
		author?: string;
		length?: number;
		isStream?: boolean;
		position?: number;
		title: string;
		uri?: string | null;
		artworkUrl?: string | null;
		sourceName?: string;
	};
	pluginInfo?: Record<string, any>;
	userData?: Record<string, any>;
}

export interface LavalinkPlaylistData {
	info: {
		name: string;
		selectedTrack: number;
		url?: string | null;
		artworkUrl?: string | null;
	};
	pluginInfo?: Record<string, any>;
	tracks: LavalinkRawTrack[];
}

export interface LavalinkLoadResponse {
	loadType: LavalinkLoadType;
	data: LavalinkRawTrack[] | LavalinkPlaylistData | { message?: string; severity?: string; cause?: string } | null;
}

export interface LavalinkStats {
	players: number;
	playingPlayers: number;
	uptime: number;
	cpu?: {
		cores: number;
		systemLoad: number;
		lavalinkLoad: number;
	};
	memory?: {
		free: number;
		used: number;
		allocated: number;
		reservable: number;
	};
	frameStats?: {
		sent: number;
		nulled: number;
		deficit: number;
	};
}

export interface LavalinkPlayerInfo {
	guildId: string;
	track?: LavalinkRawTrack | null;
	volume: number;
	paused: boolean;
	voice: {
		token: string;
		endpoint: string;
		sessionId: string;
	};
	filters?: Record<string, any>;
	state?: {
		time: number;
		position: number;
		connected: boolean;
		ping: number;
	};
}

export interface LavalinkNodeOptions {
	identifier?: string;
	host: string;
	port?: number;
	password: string;
	secure?: boolean;
	sessionId?: string;
	url?: string;
}

export interface LavalinkExtOptions {
	nodes: LavalinkNodeOptions[];
	client?: any; // Client from discord.js
	userId?: string;
	sendGatewayPayload?: (guildId: string, payload: any) => Promise<void> | void;
	searchPrefix?: string;
	nodeSort?: "players" | "cpu" | "memory" | "random";
	requestTimeoutMs?: number;
	clientName?: string;
	updateInterval?: number;
	debug?: boolean;
}

export interface InternalNode extends LavalinkNodeOptions {
	identifier: string;
	rest: any; // AxiosInstance
	ws?: any; // WebSocket
	connected: boolean;
	stats?: LavalinkStats;
	players: Set<string>;
	lastPing?: number;
	sessionId?: string;
	wsConnected: boolean;
	wsReconnectAttempts: number;
	maxReconnectAttempts: number;
}

export interface VoiceServerRawEvent {
	token: string;
	endpoint: string | null;
	guild_id: string;
	[key: string]: any;
}

export interface VoiceServerState {
	token: string;
	endpoint: string | null;
	guildId: string;
	rawEvent: VoiceServerRawEvent;
}

export interface LavalinkPlayerState {
	node?: InternalNode;
	channelId?: string | null;
	voiceState?: { sessionId?: string | null; channelId?: string | null };
	voiceServer?: VoiceServerState;
	track?: any; // Track
	playing: boolean;
	paused: boolean;
	volume: number;
	skipNext: boolean;
	awaitingNode?: boolean;
	awaitingTrack?: boolean;
	voiceTimeout?: NodeJS.Timeout | null;
	lastPosition?: number;
	autoPlayChecked?: boolean;
	updateInterval?: NodeJS.Timeout;
	voiceUpdateSent?: boolean; // Track if voice update has been sent to current node
}

export interface VoiceWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

// WebSocket OP Types
export interface LavalinkWebSocketMessage {
	op: string;
	[key: string]: any;
}

export interface LavalinkReadyMessage extends LavalinkWebSocketMessage {
	op: "ready";
	resumed: boolean;
	sessionId: string;
}

export interface LavalinkStatsMessage extends LavalinkWebSocketMessage {
	op: "stats";
	players: number;
	playingPlayers: number;
	uptime: number;
	memory?: {
		free: number;
		used: number;
		allocated: number;
		reservable: number;
	};
	cpu?: {
		cores: number;
		systemLoad: number;
		lavalinkLoad: number;
	};
	frameStats?: {
		sent: number;
		nulled: number;
		deficit: number;
	};
}

export interface LavalinkPlayerUpdateMessage extends LavalinkWebSocketMessage {
	op: "playerUpdate";
	guildId: string;
	state: {
		time: number;
		position: number;
		connected: boolean;
		ping: number;
	};
}

export interface LavalinkEventMessage extends LavalinkWebSocketMessage {
	op: "event";
	type: "TrackStartEvent" | "TrackEndEvent" | "TrackExceptionEvent" | "TrackStuckEvent" | "WebSocketClosedEvent";
	guildId: string;
	[key: string]: any;
}
