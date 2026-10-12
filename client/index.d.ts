export declare const WEB_AUDIO_PROTOCOL_VERSION: 1;
export declare const WEB_AUDIO_SAMPLE_RATE_HZ: 48000;
export declare const WEB_AUDIO_CHANNELS: 2;
export declare const WEB_AUDIO_SAMPLE_BYTES: 2;
export declare const WEB_AUDIO_FRAME_HEADER_BYTES: 16;
export declare const WEB_AUDIO_MAX_MESSAGE_BYTES: 1048576;

export interface WebAudioPcmConfig {
	v: 1;
	type: "audio:config";
	sessionId: string;
	protocolVersion?: number;
	codec?: "pcm";
	sampleRateHz: 48000;
	channels: 2;
	sampleFormat: "s16";
	endianness: "little";
	channelLayout: "interleaved";
}

export interface WebAudioOpusConfig {
	v: 1;
	type: "audio:config";
	sessionId: string;
	protocolVersion?: number;
	codec: "opus";
	sampleRateHz?: number;
	channels?: number;
}

export type WebAudioConfig = WebAudioPcmConfig | WebAudioOpusConfig;

export interface DecodedPcmFrame {
	sequence: number;
	timestampMs: number;
	timestampUs?: bigint;
	samples: Float32Array;
	peak: number;
	payload: Uint8Array;
	sequenceGap: boolean;
}

export interface DecodedOpusFrame {
	sequence: number;
	timestampMs: number;
	timestampUs?: bigint;
	frameDurationMs: number;
	payload: Uint8Array;
	samples?: Float32Array;
	peak?: number;
	sequenceGap: boolean;
}

export declare function parseAudioConfig(message: string | unknown, expectedSessionId?: string): WebAudioConfig;
export declare function decodePcmFrame(
	data: ArrayBuffer,
	config: WebAudioConfig,
	expectedSequence?: number | null,
): DecodedPcmFrame;
export declare function decodeOpusFrame(
	data: ArrayBuffer,
	config: WebAudioConfig,
	expectedSequence?: number | null,
): DecodedOpusFrame;

export declare class OpusDecoderAdapter {
	constructor(options?: { sampleRate?: number; channels?: number; decoder?: unknown });
	readonly sampleRate: number;
	readonly channels: number;
	initialize(): Promise<void>;
	decode(opusPacketUint8Array: Uint8Array): { samples: Float32Array; samplesDecoded: number; peak: number };
	reset(): void;
	free(): void;
}

export interface WebAudioClientOptions {
	audioContextFactory?: (options: AudioContextOptions) => AudioContext;
	webSocketFactory?: (url: URL) => WebSocket;
	opusDecoderFactory?: (options: { sampleRate: number; channels: number }) => OpusDecoderAdapter;
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
	opus: CustomEvent<DecodedOpusFrame>;
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
