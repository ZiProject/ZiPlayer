export declare const WEB_AUDIO_PROTOCOL_VERSION: 1;
export declare const WEB_AUDIO_SAMPLE_RATE_HZ: 48000;
export declare const WEB_AUDIO_CHANNELS: 2;
export declare const WEB_AUDIO_SAMPLE_BYTES: 2;
export declare const WEB_AUDIO_FRAME_HEADER_BYTES: 16;
export declare const WEB_AUDIO_MAX_MESSAGE_BYTES: 1048576;

export interface WebAudioConfig {
	v: 1;
	type: "audio:config";
	sessionId: string;
	protocolVersion: 1;
	sampleRateHz: 48000;
	channels: 2;
	sampleFormat: "s16";
	endianness: "little";
	channelLayout: "interleaved";
}

export interface DecodedPcmFrame {
	sequence: number;
	timestampMs: number;
	samples: Float32Array;
	peak: number;
	payload: Uint8Array;
	sequenceGap: boolean;
}

export declare function parseAudioConfig(message: string | unknown, expectedSessionId?: string): WebAudioConfig;
export declare function decodePcmFrame(
	data: ArrayBuffer,
	config: WebAudioConfig,
	expectedSequence?: number | null,
): DecodedPcmFrame;

export interface WebAudioClientOptions {
	audioContextFactory?: (options: AudioContextOptions) => AudioContext;
	webSocketFactory?: (url: URL) => WebSocket;
	startupBufferMs?: number;
	maxBufferSeconds?: number;
	connectTimeoutMs?: number;
}

export interface WebAudioConnectOptions {
	gatewayUrl: string;
	token?: string;
	sessionId?: string;
	nextPublisher?: boolean;
}

export type WebAudioClientState = "disconnected" | "connecting" | "connected" | "waiting" | "playing" | "paused";

export interface WebAudioClientEventMap {
	connected: CustomEvent<{ sessionId: string | null; nextPublisher: boolean }>;
	config: CustomEvent<WebAudioConfig>;
	pcm: CustomEvent<DecodedPcmFrame>;
	statechange: CustomEvent<{ state: WebAudioClientState; previousState: WebAudioClientState }>;
	sequencegap: CustomEvent<{ expectedSequence: number; receivedSequence: number }>;
	control: CustomEvent<Record<string, unknown>>;
	error: CustomEvent<{ error: Error }>;
	close: CustomEvent<{ code: number; reason: string }>;
}

export declare class WebAudioClient extends EventTarget {
	constructor(options?: WebAudioClientOptions);
	readonly sessionId: string | null;
	readonly config: WebAudioConfig | null;
	readonly state: WebAudioClientState;
	connect(options: WebAudioConnectOptions): Promise<this>;
	disconnect(): Promise<void>;
	addEventListener<K extends keyof WebAudioClientEventMap>(
		type: K,
		callback: (this: WebAudioClient, event: WebAudioClientEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
	removeEventListener<K extends keyof WebAudioClientEventMap>(
		type: K,
		callback: (this: WebAudioClient, event: WebAudioClientEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions,
	): void;
}
