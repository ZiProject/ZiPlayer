import audio from "audio";
import { Readable } from "stream";
import type { Track } from "../types";
import type { AudioFrameFormat } from "../output/AudioOutputBackend";

export type AudioProcessingFormat = "encoded" | "pcm16le" | "pcmFloat32";

export interface AudioProcessingOptions {
	enabled?: boolean;
	inputFormat?: AudioProcessingFormat;
	outputFormat?: AudioProcessingFormat;
	sampleRate?: number;
	channels?: number;
	gainDb?: number;
	gainLinear?: number;
	highpassHz?: number;
	lowpassHz?: number;
	normalize?: boolean | "streaming" | "podcast" | "broadcast" | number;
	resampleRate?: number;
	maxBufferBytes?: number;
}

export interface AudioProcessingContext {
	playerId?: string;
	track?: Track | null;
	signal?: AbortSignal;
	debug?: (...args: any[]) => void;
}

export interface AudioProcessingPipeline {
	readonly outputFormat: AudioFrameFormat;
	process(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable, signal?: AbortSignal): AsyncIterable<Uint8Array>;
	dispose(): Promise<void>;
}

export interface AudioProcessingEngine {
	createPipeline(options: AudioProcessingOptions, context?: AudioProcessingContext): Promise<AudioProcessingPipeline>;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function normalizeAsyncInput(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable): AsyncIterable<Uint8Array> {
	if (input == null) throw new TypeError("Audio processing input is required");
	if (input instanceof Readable) {
		return Readable.toWeb(input) as unknown as AsyncIterable<Uint8Array>;
	}
	if (typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
		return (async function* () {
			yield* input as AsyncIterable<Uint8Array>;
		})();
	}
	if (typeof (input as Iterable<Uint8Array>)[Symbol.iterator] === "function") {
		return (async function* () {
			for (const chunk of input as Iterable<Uint8Array>) {
				yield chunk;
			}
		})();
	}
	throw new TypeError("Audio processing input must be an async iterable, iterable, or readable stream");
}

function validateOptions(options: AudioProcessingOptions): AudioProcessingOptions {
	const resolved: AudioProcessingOptions = {
		inputFormat: options.inputFormat ?? "encoded",
		outputFormat: options.outputFormat ?? "pcm16le",
		enabled: options.enabled ?? true,
		sampleRate: options.sampleRate ?? 48000,
		channels: options.channels ?? 2,
		maxBufferBytes: options.maxBufferBytes ?? 64 * 1024,
		...options,
	};

	if (resolved.outputFormat !== "encoded" && resolved.outputFormat !== "pcm16le" && resolved.outputFormat !== "pcmFloat32") {
		throw new TypeError(`Invalid audio processing output format: ${String(resolved.outputFormat)}`);
	}
	if (resolved.outputFormat === "encoded") {
		throw new TypeError("The current audio processing engine can only emit PCM output, not encoded audio");
	}

	if (resolved.inputFormat !== "encoded" && resolved.inputFormat !== "pcm16le" && resolved.inputFormat !== "pcmFloat32") {
		throw new TypeError(`Invalid audio processing input format: ${String(resolved.inputFormat)}`);
	}
	if (resolved.inputFormat !== "encoded") {
		throw new TypeError(
			`Audio processing inputFormat=${String(resolved.inputFormat)} is not supported by the current runtime; use encoded input and let the library decode it before DSP processing.`,
		);
	}

	if (!isFiniteNumber(resolved.sampleRate) || resolved.sampleRate <= 0) {
		throw new TypeError("Audio processing sampleRate must be a positive finite number");
	}
	if (!isFiniteNumber(resolved.channels) || resolved.channels <= 0 || !Number.isInteger(resolved.channels)) {
		throw new TypeError("Audio processing channels must be a positive integer");
	}
	if (resolved.gainDb != null && !isFiniteNumber(resolved.gainDb)) {
		throw new TypeError("Audio processing gainDb must be a finite number");
	}
	if (resolved.gainLinear != null && !isFiniteNumber(resolved.gainLinear)) {
		throw new TypeError("Audio processing gainLinear must be a finite number");
	}
	if (resolved.gainDb != null && resolved.gainLinear != null) {
		throw new TypeError("Audio processing gainDb and gainLinear cannot both be configured");
	}
	if (resolved.highpassHz != null && (!isFiniteNumber(resolved.highpassHz) || resolved.highpassHz <= 0)) {
		throw new TypeError("Audio processing highpassHz must be a positive finite number");
	}
	if (resolved.lowpassHz != null && (!isFiniteNumber(resolved.lowpassHz) || resolved.lowpassHz <= 0)) {
		throw new TypeError("Audio processing lowpassHz must be a positive finite number");
	}
	if (resolved.resampleRate != null && (!isFiniteNumber(resolved.resampleRate) || resolved.resampleRate <= 0)) {
		throw new TypeError("Audio processing resampleRate must be a positive finite number");
	}
	if (resolved.maxBufferBytes != null && (!isFiniteNumber(resolved.maxBufferBytes) || resolved.maxBufferBytes <= 0)) {
		throw new TypeError("Audio processing maxBufferBytes must be a positive finite number");
	}
	if (
		resolved.normalize !== false &&
		resolved.normalize != null &&
		typeof resolved.normalize !== "boolean" &&
		typeof resolved.normalize !== "number" &&
		typeof resolved.normalize !== "string"
	) {
		throw new TypeError("Audio processing normalize must be boolean, number, or preset string");
	}
	if (typeof resolved.normalize === "string" && !["streaming", "podcast", "broadcast"].includes(resolved.normalize)) {
		throw new TypeError("Audio processing normalize preset must be one of: streaming, podcast, broadcast");
	}
	return resolved;
}

function toFloat32Channels(
	block: Float32Array | Float32Array[] | number[] | number[][] | Uint8Array | ArrayLike<number>,
): Float32Array[] {
	if (Array.isArray(block)) {
		if (block.length === 0) return [new Float32Array(0)];
		if (typeof block[0] === "number") {
			return [Float32Array.from(block as ArrayLike<number>)];
		}
		const channels = Array.from(block as ArrayLike<Float32Array | number[] | Uint8Array>).map((channel) => {
			if (channel instanceof Uint8Array) return Float32Array.from(channel);
			return Float32Array.from(channel as ArrayLike<number>);
		});
		const sampleCount = Math.max(0, ...channels.map((channel: Float32Array) => channel.length));
		return channels.map((channel: Float32Array) => {
			if (channel.length === sampleCount) return channel;
			const aligned = new Float32Array(sampleCount);
			aligned.set(channel);
			return aligned;
		});
	}
	if (block instanceof Uint8Array) return [Float32Array.from(block)];
	return [Float32Array.from(block as ArrayLike<number>)];
}

function encodePcm16le(channels: Float32Array[]): Uint8Array {
	if (channels.length === 0) return new Uint8Array(0);
	const sampleCount = Math.max(0, ...channels.map((channel) => channel.length));
	if (sampleCount === 0) return new Uint8Array(0);
	const channelCount = channels.length;
	const buffer = Buffer.allocUnsafe(sampleCount * channelCount * 2);
	let offset = 0;
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const channel = channels[channelIndex] ?? channels[0];
			const rawValue = channel[sampleIndex] ?? 0;
			const value = Number.isFinite(rawValue) ? Math.max(-1, Math.min(1, rawValue)) : 0;
			buffer.writeInt16LE(Math.round(value * 32767), offset);
			offset += 2;
		}
	}
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function encodePcmFloat32(channels: Float32Array[]): Uint8Array {
	if (channels.length === 0) return new Uint8Array(0);
	const sampleCount = Math.max(0, ...channels.map((channel) => channel.length));
	if (sampleCount === 0) return new Uint8Array(0);
	const channelCount = channels.length;
	const output = new Float32Array(sampleCount * channelCount);
	let offset = 0;
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const channel = channels[channelIndex] ?? channels[0];
			const rawValue = channel[sampleIndex] ?? 0;
			output[offset++] = Number.isFinite(rawValue) ? Math.max(-1, Math.min(1, rawValue)) : 0;
		}
	}
	return new Uint8Array(output.buffer);
}

class AudioJsAudioProcessingPipeline implements AudioProcessingPipeline {
	private disposed = false;
	private activeInstance: any | null = null;
	private readonly options: AudioProcessingOptions;
	private readonly context: AudioProcessingContext;
	public readonly outputFormat: AudioFrameFormat;

	public constructor(options: AudioProcessingOptions, context: AudioProcessingContext = {}) {
		this.options = validateOptions(options);
		this.context = context;
		this.outputFormat = {
			kind: "pcm",
			sampleFormat: this.options.outputFormat === "pcmFloat32" ? "f32" : "s16",
			endianness: "little",
			sampleRateHz: this.options.resampleRate ?? this.options.sampleRate ?? 48_000,
			channels: this.options.channels ?? 2,
			channelLayout: "interleaved",
			chunkAlignmentBytes: (this.options.channels ?? 2) * (this.options.outputFormat === "pcmFloat32" ? 4 : 2),
		};
	}

	public process(
		input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable,
		signal?: AbortSignal,
	): AsyncIterable<Uint8Array> {
		if (this.disposed) throw new Error("Audio processing pipeline is disposed");
		const normalizedSignal = signal ?? this.context.signal ?? new AbortController().signal;
		const source = normalizeAsyncInput(input);
		const instance = audio(source as any);
		this.activeInstance = instance;
		const pipeline = this;
		const pipelineOptions = this.options;
		const maxOutputBytes = pipelineOptions.maxBufferBytes ?? Number.MAX_SAFE_INTEGER;

		const applyPipeline = async function* (): AsyncGenerator<Uint8Array> {
			const iterator = (instance as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
			try {
				if (normalizedSignal.aborted) return;
				if (instance != null) {
					if (typeof instance.gain === "function") {
						if (pipelineOptions.gainDb != null) instance.gain(pipelineOptions.gainDb, { unit: "db" });
						else if (pipelineOptions.gainLinear != null) instance.gain(pipelineOptions.gainLinear, { unit: "linear" });
					}
					if (pipelineOptions.highpassHz != null && typeof instance.highpass === "function")
						instance.highpass(pipelineOptions.highpassHz);
					if (pipelineOptions.lowpassHz != null && typeof instance.lowpass === "function")
						instance.lowpass(pipelineOptions.lowpassHz);
					if (
						pipelineOptions.normalize !== false &&
						pipelineOptions.normalize != null &&
						typeof instance.normalize === "function"
					) {
						if (typeof pipelineOptions.normalize === "number") instance.normalize(pipelineOptions.normalize, "rms");
						else instance.normalize(pipelineOptions.normalize === true ? "streaming" : pipelineOptions.normalize);
					}
					const outputSampleRate = pipelineOptions.resampleRate ?? pipelineOptions.sampleRate ?? 48_000;
					if (typeof instance.resample !== "function") throw new Error("Audio processing runtime does not support resampling");
					instance.resample(outputSampleRate, { type: "sinc" });
					const outputChannels = pipelineOptions.channels ?? 2;
					if (typeof instance.remix !== "function") throw new Error("Audio processing runtime does not support channel remixing");
					instance.remix(outputChannels);
				}
				while (true) {
					const { value, done } = await iterator.next();
					if (done || normalizedSignal.aborted) break;
					const block = value as Uint8Array;
					const channels =
						Array.isArray(block) ?
							toFloat32Channels(block as Float32Array[] | number[][])
							: block instanceof Uint8Array ?
								toFloat32Channels(block)
							: toFloat32Channels([block as Float32Array]);
					const encoded = pipelineOptions.outputFormat === "pcmFloat32" ? encodePcmFloat32(channels) : encodePcm16le(channels);
					if (encoded.length > maxOutputBytes) {
						throw new Error(
							`Audio processing output block exceeded maxBufferBytes (${maxOutputBytes} bytes); the engine cannot buffer a larger output chunk without dropping data.`,
						);
					}
					if (encoded.length > 0) yield encoded;
				}
			} finally {
				if (typeof iterator.return === "function") {
					await iterator.return();
				}
				pipeline.activeInstance?.dispose?.();
				pipeline.activeInstance = null;
			}
		};

		return applyPipeline();
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.activeInstance?.dispose?.();
		this.activeInstance = null;
	}
}

export class AudioJsAudioProcessingEngine implements AudioProcessingEngine {
	private readonly defaults: AudioProcessingOptions;

	public constructor(defaults: AudioProcessingOptions = {}) {
		this.defaults = validateOptions({ enabled: true, outputFormat: "pcm16le", inputFormat: "encoded", ...defaults });
	}

	public async createPipeline(
		options: AudioProcessingOptions,
		context: AudioProcessingContext = {},
	): Promise<AudioProcessingPipeline> {
		return new AudioJsAudioProcessingPipeline({ ...this.defaults, ...options }, context);
	}
}

export function createAudioProcessingEngine(defaults: AudioProcessingOptions = {}): AudioProcessingEngine {
	return new AudioJsAudioProcessingEngine(defaults);
}

export const defaultAudioProcessingEngine = createAudioProcessingEngine();
