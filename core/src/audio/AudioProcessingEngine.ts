import type { Readable } from "stream";
import type { Track } from "../types";
import type { AudioFrameFormat } from "../output/AudioOutputBackend";
import { FFmpegAudioProcessingEngine } from "./FFmpegAudioProcessingEngine";

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
	/**
	 * Single-pass loudness normalization (FFmpeg `loudnorm`): `true`/`"streaming"` = -14 LUFS,
	 * `"podcast"` = -16 LUFS, `"broadcast"` = -23 LUFS. Numeric RMS/peak targets are not supported.
	 */
	normalize?: boolean | "streaming" | "podcast" | "broadcast";
	resampleRate?: number;
	/** Upper bound for a single emitted PCM chunk. Larger FFmpeg reads are split on frame boundaries. */
	maxBufferBytes?: number;
	/** Explicit FFmpeg executable. Falls back to `FFMPEG_PATH`, `ffmpeg-static`, then `ffmpeg` on PATH. */
	ffmpegPath?: string | null;
	/**
	 * FFmpeg demuxers allowed for encoded input. Defaults to common audio containers so that unrecognised bytes
	 * fail loudly instead of being guessed as a weak-probe format (FFmpeg decodes raw PCM as loud ADPCM noise).
	 * Pass `null` to disable the whitelist.
	 */
	ffmpegInputFormats?: readonly string[] | null;
}

export interface AudioProcessingContext {
	playerId?: string;
	track?: Track | null;
	signal?: AbortSignal;
	debug?: (...args: any[]) => void;
	/**
	 * Describes the stream passed to `process()`. PCM streams cannot be probed by FFmpeg, so their layout must be
	 * declared here; omit it (or use `kind: "encoded"`) for containers FFmpeg can detect itself.
	 */
	inputFormat?: AudioFrameFormat;
}

export interface AudioProcessingPipeline {
	readonly outputFormat: AudioFrameFormat;
	process(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable, signal?: AbortSignal): AsyncIterable<Uint8Array>;
	dispose(): Promise<void>;
}

export interface AudioProcessingEngine {
	createPipeline(options: AudioProcessingOptions, context?: AudioProcessingContext): Promise<AudioProcessingPipeline>;
}

export { FFmpegAudioProcessingEngine };

export function createAudioProcessingEngine(defaults: AudioProcessingOptions = {}): AudioProcessingEngine {
	return new FFmpegAudioProcessingEngine(defaults);
}

export const defaultAudioProcessingEngine = createAudioProcessingEngine();
