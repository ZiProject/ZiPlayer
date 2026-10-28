export declare const WEB_AUDIO_PROTOCOL_VERSION: 1;
export declare const WEB_AUDIO_SAMPLE_RATE_HZ: 48000;
export declare const WEB_AUDIO_CHANNELS: 2;
export declare const WEB_AUDIO_FRAME_HEADER_BYTES: 16;
export declare const WEB_AUDIO_MAX_MESSAGE_BYTES: 1048576;

export interface WebAudioOpusConfig {
	v: 1;
	type: "audio:config";
	sessionId: string;
	protocolVersion?: number;
	codec: "opus";
	sampleRateHz?: number;
	channels?: number;
}

export type WebAudioConfig = WebAudioOpusConfig;

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

export interface DecodedPcmFrame {
	sequence: number;
	timestampMs: number;
	timestampUs?: bigint;
	samples: Float32Array;
	peak: number;
	payload: Uint8Array;
	sequenceGap: boolean;
	codec: "opus";
}

export declare function parseAudioConfig(message: string | unknown, expectedSessionId?: string): WebAudioConfig;
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

export interface WebAudioAnalyserOptions {
	fftSize?: number;
	maxDecibels?: number;
	minDecibels?: number;
	smoothingTimeConstant?: number;
}

export interface FrequencyBandOptions {
	/**
	 * Number of output frequency bands / bars.
	 * @default 32
	 */
	bands?: number;

	/**
	 * Minimum audible frequency in Hz to include in the lowest band.
	 * Frequencies below this (e.g. DC offset and sub-audible rumble) are filtered out.
	 * @default 28
	 */
	minHz?: number;

	/**
	 * Maximum frequency in Hz to include in the highest band.
	 * Frequencies above this (e.g. ultrasonic and lossy codec roll-off) are filtered out.
	 * @default 16000
	 */
	maxHz?: number;

	/**
	 * Audio sample rate in Hz. Required when passing raw Uint8Array instead of AnalyserNode.
	 * @default 48000
	 */
	sampleRate?: number;

	/**
	 * Apply musical frequency energy weighting (equal-loudness compensation curve)
	 * to prevent dense mid-range frequencies from clipping while keeping bass and highs lively.
	 * Set to false to disable weighting.
	 * @default true
	 */
	weighting?: boolean;

	/**
	 * Soft-knee compression exponent for visual appeal.
	 * @default 0.7
	 */
	softKnee?: number;

	/**
	 * Pre-allocated Float32Array of length >= bands to write results into without allocation.
	 */
	outputBuffer?: Float32Array;

	/**
	 * Pre-allocated Uint8Array to receive frequency data from AnalyserNode.
	 */
	frequencyData?: Uint8Array;
}

export interface BassEnergyOptions {
	/**
	 * Minimum kick/sub-bass frequency in Hz.
	 * @default 45
	 */
	minHz?: number;

	/**
	 * Maximum kick/bass frequency in Hz.
	 * @default 120
	 */
	maxHz?: number;

	/**
	 * Audio sample rate in Hz. Required when passing raw Uint8Array instead of AnalyserNode.
	 * @default 48000
	 */
	sampleRate?: number;

	/**
	 * Pre-allocated Uint8Array to receive frequency data from AnalyserNode.
	 */
	frequencyData?: Uint8Array;
}

export declare function getFrequencyBands(source: AnalyserNode | Uint8Array, options?: FrequencyBandOptions): Float32Array;

export declare function getBassEnergy(source: AnalyserNode | Uint8Array, options?: BassEnergyOptions): number;

export interface WebAudioClientOptions {
	audioContextFactory?: (options: AudioContextOptions) => AudioContext;
	webSocketFactory?: (url: URL) => WebSocket;
	opusDecoderFactory?: (options: { sampleRate: number; channels: number }) => OpusDecoderAdapter | Promise<OpusDecoderAdapter>;
	startupBufferMs?: number;
	maxBufferSeconds?: number;
	connectTimeoutMs?: number;
	analyserOptions?: WebAudioAnalyserOptions | false;
	/**
	 * Custom URL for the AudioWorklet script processor.
	 * Useful in Electron / Tauri environments with strict CSP where blob: URLs are disallowed.
	 */
	workletUrl?: string | null;
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
	suspended: CustomEvent<{ reason: string; error: unknown }>;
}

export declare class WebAudioClient extends EventTarget {
	constructor(options?: WebAudioClientOptions);
	readonly sessionId: string | null;
	readonly config: WebAudioConfig | null;
	readonly state: WebAudioClientState;
	readonly audioContext: AudioContext | null;
	readonly analyser: AnalyserNode | null;
	getAudioContext(): AudioContext | null;
	getAnalyser(): AnalyserNode | null;
	getFrequencyBands(options?: FrequencyBandOptions): Float32Array | null;
	getBassEnergy(options?: BassEnergyOptions): number;
	connect(options: WebAudioConnectOptions): Promise<this>;
	disconnect(): Promise<void>;
	resume(): Promise<this>;
	unlockAudio(): Promise<this>;
	addEventListener<K extends keyof WebAudioClientEventMap>(
		type: K,
		callback: (this: WebAudioClient, event: WebAudioClientEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	removeEventListener<K extends keyof WebAudioClientEventMap>(
		type: K,
		callback: (this: WebAudioClient, event: WebAudioClientEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
}
