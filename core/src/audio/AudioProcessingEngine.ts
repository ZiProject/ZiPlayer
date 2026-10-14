import type { Readable } from "stream";
import type { Track } from "../types";
import type { AudioFrameFormat } from "../output/AudioOutputBackend";
import { FFmpegAudioProcessingEngine } from "./FFmpegAudioProcessingEngine";
export {
	FFmpegAudioProcessingEngine,
	resolveAudioProcessingOptions,
	buildFilterChain,
	describeOutputFormat,
	DEFAULT_FFMPEG_INPUT_FORMATS,
} from "./FFmpegAudioProcessingEngine";

/** Audio processing accepts encoded media containers. */
export type AudioProcessingInputFormat = "encoded";
export type AudioProcessingOutputFormat = "encoded";
/** @deprecated Use `AudioProcessingOutputFormat`. Player input is always `"encoded"`. */
export type AudioProcessingFormat = AudioProcessingOutputFormat;

export type EncodedOpusApplication = "voip" | "audio" | "lowdelay";

export const AUDIO_PROCESSING_HINT = Symbol.for("ziplayer.audioProcessingHint");

export interface AudioProcessingHint {
	filterString?: string;
	seekMs?: number;
	inputUrl?: string;
	/** When true, ignore piped bytes and load `inputUrl` through the SSRF-checked Node HTTP stream. */
	useInputUrl?: boolean;
}

export interface AudioProcessingOptions {
	enabled?: boolean;
	/** Audio processing always emits Opus in an Ogg container. */
	inputFormat?: AudioProcessingInputFormat;
	/** Only `"encoded"` is supported; processing emits Opus in an Ogg container. */
	outputFormat?: AudioProcessingOutputFormat;
	sampleRate?: number;
	channels?: number;
	gainDb?: number;
	gainLinear?: number;
	highpassHz?: number;
	lowpassHz?: number;
	/**
	 * Single-pass loudness normalization (FFmpeg `loudnorm`): `true`/`"streaming"` = -14 LUFS,
	 * `"podcast"` = -16 LUFS, `"broadcast"` = -23 LUFS. Numeric RMS/peak targets are not supported.
	 * Mutually exclusive with a `loudnorm` filter in `AudioProcessingContext.filterString`.
	 */
	normalize?: boolean | "streaming" | "podcast" | "broadcast";
	resampleRate?: number;
	/** Upper bound for a single emitted chunk. */
	maxBufferBytes?: number;
	/** Explicit FFmpeg executable. Falls back to `FFMPEG_PATH`, `ffmpeg-static`, then `ffmpeg` on PATH. */
	ffmpegPath?: string | null;
	/** FFmpeg demuxers allowed for encoded input. Pass `null` to disable the whitelist. */
	ffmpegInputFormats?: readonly string[] | null;
	/** libopus bitrate for `outputFormat: "encoded"` (default `"128k"`). */
	encodedBitrate?: string | number;
	/** libopus `-application` for encoded output (default `"audio"`). */
	encodedApplication?: EncodedOpusApplication;
	/** Kill FFmpeg after this many input bytes. `null` disables. Default 1 GiB. */
	maxInputBytes?: number | null;
	/** Cap output with FFmpeg `-t`. `null` disables. Default disabled (live tracks). */
	maxDurationMs?: number | null;
	/** Kill FFmpeg when stdin and stdout are idle this long. `null` disables. Default 30s. */
	stallTimeoutMs?: number | null;
	/** FFmpeg `-threads` (default 1). */
	ffmpegThreads?: number;
	/** Per-engine cap on concurrent FFmpeg children. Default is based on a memory budget; a process-wide safety gate also applies. */
	maxConcurrentProcesses?: number;
	/**
	 * Deprecated and unsupported. Setting true throws because FFmpeg's own redirect handling cannot
	 * guarantee redirect-by-redirect SSRF validation. Use `useInputUrl` with the guarded Node stream.
	 */
	allowFfmpegUrlInput?: boolean;
}

export interface AudioProcessingContext {
	playerId?: string;
	track?: Track | null;
	signal?: AbortSignal;
	debug?: (...args: any[]) => void;
	/** Extra FFmpeg `-af` fragment from `player.filter` (already allowlisted). Combined into one graph. */
	filterString?: string;
	/** Output-side seek in milliseconds (`-ss` after `-i`). */
	seekMs?: number;
	/** Optional http(s) source. Used only when `useInputUrl` is true; redirects are individually validated. */
	inputUrl?: string;
	useInputUrl?: boolean;
	/** Extra linear volume (player volume) baked into the FFmpeg graph for encoded Discord output. */
	playbackVolumeLinear?: number;
}

export interface AudioProcessingPipeline {
	readonly outputFormat: AudioFrameFormat;
	process(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable, signal?: AbortSignal): AsyncIterable<Uint8Array>;
	dispose(): Promise<void>;
}

export interface AudioProcessingEngine {
	createPipeline(options: AudioProcessingOptions, context?: AudioProcessingContext): Promise<AudioProcessingPipeline>;
}

export { isSafeCustomFilter, parseFilterNames, ALLOWED_FFMPEG_AUDIO_FILTERS } from "./filterAllowlist";
export { getFfmpegProcessStats, configureFfmpegConcurrency, sanitizeFfmpegLog } from "./ffmpegLimits";
export { assertSafeMediaUrl, openSafeHttpStream, UnsafeMediaUrlError, isBlockedIpAddress } from "./urlSafety";

export function createAudioProcessingEngine(defaults: AudioProcessingOptions = {}): AudioProcessingEngine {
	return new FFmpegAudioProcessingEngine(defaults);
}

export const defaultAudioProcessingEngine = createAudioProcessingEngine();

export function readAudioProcessingHint(stream: object | null | undefined): AudioProcessingHint | undefined {
	if (!stream) return undefined;
	return (stream as Record<symbol, AudioProcessingHint | undefined>)[AUDIO_PROCESSING_HINT];
}

export function writeAudioProcessingHint(stream: object, hint: AudioProcessingHint): void {
	(stream as Record<symbol, AudioProcessingHint>)[AUDIO_PROCESSING_HINT] = hint;
}
