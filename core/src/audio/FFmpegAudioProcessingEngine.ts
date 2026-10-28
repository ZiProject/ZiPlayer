import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { AudioFrameFormat } from "./AudioFrameFormat";
import type {
	AudioProcessingContext,
	AudioProcessingEngine,
	AudioProcessingOptions,
	AudioProcessingPipeline,
} from "./AudioProcessingEngine";
import { filterGraphContainsLoudnorm } from "./filterAllowlist";
import {
	ALLOWED_SAMPLE_RATES,
	CHANNELS_MAX,
	CHANNELS_MIN,
	DEFAULT_FFMPEG_THREADS,
	DEFAULT_MAX_BUFFER_BYTES,
	DEFAULT_MAX_INPUT_BYTES,
	DEFAULT_STALL_TIMEOUT_MS,
	GAIN_DB_MAX,
	GAIN_DB_MIN,
	GAIN_LINEAR_MAX,
	GAIN_LINEAR_MIN,
	KILL_GRACE_MS,
	MAX_BUFFER_BYTES_CAP,
	acquireFfmpegSlot,
	FfmpegProcessGate,
	defaultFfmpegConcurrency,
	resolveFfmpegExecutable,
	sanitizeFfmpegLog,
} from "./ffmpegLimits";
import { openSafeHttpStream } from "./urlSafety";
import ffmpegStaticPath from "ffmpeg-static";

type Source = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable;

type ResolvedOptions = AudioProcessingOptions &
	Required<Pick<AudioProcessingOptions, "inputFormat" | "outputFormat" | "sampleRate" | "channels" | "maxBufferBytes">>;

const LOUDNORM_TARGET: Record<string, number> = { streaming: -14, podcast: -16, broadcast: -23 };
/** Demuxers accepted for encoded input; anything else is rejected instead of being guessed. */
export const DEFAULT_FFMPEG_INPUT_FORMATS: readonly string[] = [
	"matroska,webm",
	"ogg",
	"mp3",
	"aac",
	"mov,mp4,m4a,3gp,3g2,mj2",
	"wav",
	"flac",
	"mpegts",
	"asf",
	"aiff",
	"ac3",
	"eac3",
	"caf",
	"w64",
	"wv",
	"ape",
	"mpeg",
	"amr",
	"dts",
	"tta",
];

const PIPE_PROTOCOLS = "pipe,crypto";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isAllowedSampleRate(value: number): boolean {
	return (ALLOWED_SAMPLE_RATES as readonly number[]).includes(value);
}

/**
 * Merges defaults (ignoring `undefined` overrides) and validates the result. Throws `TypeError`
 * for anything the FFmpeg engine cannot honour instead of silently degrading the audio.
 */
export function resolveAudioProcessingOptions(...layers: AudioProcessingOptions[]): ResolvedOptions {
	const merged: AudioProcessingOptions = {};
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer ?? {})) {
			if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
		}
	}
	const resolved = {
		enabled: true,
		inputFormat: "encoded",
		outputFormat: "encoded",
		sampleRate: 48_000,
		channels: 2,
		maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
		...merged,
	} as ResolvedOptions;

	if (resolved.inputFormat !== "encoded") {
		throw new TypeError(`Unsupported audio processing inputFormat: ${String(resolved.inputFormat)} (expected "encoded")`);
	}
	if (resolved.outputFormat !== "encoded") {
		throw new TypeError(`Unsupported audio processing outputFormat: ${String(resolved.outputFormat)} (expected "encoded")`);
	}
	if (!isFiniteNumber(resolved.sampleRate) || !isAllowedSampleRate(resolved.sampleRate)) {
		throw new TypeError(`Audio processing sampleRate must be one of: ${ALLOWED_SAMPLE_RATES.join(", ")}`);
	}
	if (
		!isFiniteNumber(resolved.channels) ||
		!Number.isInteger(resolved.channels) ||
		resolved.channels < CHANNELS_MIN ||
		resolved.channels > CHANNELS_MAX
	) {
		throw new TypeError(`Audio processing channels must be an integer from ${CHANNELS_MIN} to ${CHANNELS_MAX}`);
	}
	if (resolved.gainDb != null) {
		if (!isFiniteNumber(resolved.gainDb) || resolved.gainDb < GAIN_DB_MIN || resolved.gainDb > GAIN_DB_MAX) {
			throw new TypeError(`Audio processing gainDb must be between ${GAIN_DB_MIN} and ${GAIN_DB_MAX}`);
		}
	}
	if (resolved.gainLinear != null) {
		if (!isFiniteNumber(resolved.gainLinear) || resolved.gainLinear < GAIN_LINEAR_MIN || resolved.gainLinear > GAIN_LINEAR_MAX) {
			throw new TypeError(`Audio processing gainLinear must be between ${GAIN_LINEAR_MIN} and ${GAIN_LINEAR_MAX}`);
		}
	}
	if (resolved.gainDb != null && resolved.gainLinear != null) {
		throw new TypeError("Audio processing gainDb and gainLinear cannot both be configured");
	}
	const nyquist = (resolved.resampleRate ?? resolved.sampleRate) / 2;
	if (
		resolved.highpassHz != null &&
		(!isFiniteNumber(resolved.highpassHz) || resolved.highpassHz <= 0 || resolved.highpassHz > nyquist)
	) {
		throw new TypeError("Audio processing highpassHz must be a positive finite number no greater than Nyquist");
	}
	if (
		resolved.lowpassHz != null &&
		(!isFiniteNumber(resolved.lowpassHz) || resolved.lowpassHz <= 0 || resolved.lowpassHz > nyquist)
	) {
		throw new TypeError("Audio processing lowpassHz must be a positive finite number no greater than Nyquist");
	}
	if (resolved.resampleRate != null && (!isFiniteNumber(resolved.resampleRate) || !isAllowedSampleRate(resolved.resampleRate))) {
		throw new TypeError(`Audio processing resampleRate must be one of: ${ALLOWED_SAMPLE_RATES.join(", ")}`);
	}
	if (
		!isFiniteNumber(resolved.maxBufferBytes) ||
		resolved.maxBufferBytes <= 0 ||
		resolved.maxBufferBytes > MAX_BUFFER_BYTES_CAP
	) {
		throw new TypeError(`Audio processing maxBufferBytes must be a positive number up to ${MAX_BUFFER_BYTES_CAP}`);
	}
	const normalize = resolved.normalize as unknown;
	if (typeof normalize === "number") {
		throw new TypeError(
			"Audio processing normalize does not support numeric targets; use true or a preset (streaming, podcast, broadcast)",
		);
	}
	if (normalize != null && typeof normalize !== "boolean" && typeof normalize !== "string") {
		throw new TypeError("Audio processing normalize must be boolean or preset string");
	}
	if (typeof normalize === "string" && !Object.prototype.hasOwnProperty.call(LOUDNORM_TARGET, normalize)) {
		throw new TypeError("Audio processing normalize preset must be one of: streaming, podcast, broadcast");
	}
	if (resolved.encodedApplication != null && !["voip", "audio", "lowdelay"].includes(resolved.encodedApplication)) {
		throw new TypeError('Audio processing encodedApplication must be "voip", "audio", or "lowdelay"');
	}
	if (resolved.encodedBitrate != null) {
		const bitrate = resolved.encodedBitrate;
		if (typeof bitrate === "number") {
			if (!Number.isFinite(bitrate) || bitrate <= 0)
				throw new TypeError("Audio processing encodedBitrate must be a positive number");
		} else if (typeof bitrate !== "string" || !/^\d+k?$/i.test(bitrate)) {
			throw new TypeError('Audio processing encodedBitrate must be a positive bitrate such as 128000 or "128k"');
		}
	}
	if (resolved.maxInputBytes != null && (!isFiniteNumber(resolved.maxInputBytes) || resolved.maxInputBytes <= 0)) {
		throw new TypeError("Audio processing maxInputBytes must be a positive finite number or null");
	}
	if (resolved.maxDurationMs != null && (!isFiniteNumber(resolved.maxDurationMs) || resolved.maxDurationMs <= 0)) {
		throw new TypeError("Audio processing maxDurationMs must be a positive finite number or null");
	}
	if (resolved.stallTimeoutMs != null && (!isFiniteNumber(resolved.stallTimeoutMs) || resolved.stallTimeoutMs <= 0)) {
		throw new TypeError("Audio processing stallTimeoutMs must be a positive finite number or null");
	}
	if (
		resolved.ffmpegThreads != null &&
		(!Number.isInteger(resolved.ffmpegThreads) || resolved.ffmpegThreads < 1 || resolved.ffmpegThreads > 8)
	) {
		throw new TypeError("Audio processing ffmpegThreads must be an integer from 1 to 8");
	}
	if (
		resolved.maxConcurrentProcesses != null &&
		(!Number.isInteger(resolved.maxConcurrentProcesses) || resolved.maxConcurrentProcesses <= 0)
	) {
		throw new TypeError("maxConcurrentProcesses must be a positive integer");
	}
	if (resolved.allowFfmpegUrlInput) {
		throw new TypeError(
			"allowFfmpegUrlInput is disabled: FFmpeg cannot safely enforce redirect-by-redirect URL validation; use safe Node HTTP input instead",
		);
	}
	return resolved;
}

function buildInputArgs(options: ResolvedOptions): string[] {
	const formats = options.ffmpegInputFormats === undefined ? DEFAULT_FFMPEG_INPUT_FORMATS : options.ffmpegInputFormats;
	return formats && formats.length > 0 ? ["-format_whitelist", formats.join(",")] : [];
}

/**
 * Filtergraph order: player filters → gainDb/gainLinear → playbackVolumeLinear → highpass → lowpass → normalize.
 */
export function buildFilterChain(options: ResolvedOptions, context: AudioProcessingContext = {}): string {
	if (options.normalize && filterGraphContainsLoudnorm(context.filterString)) {
		throw new TypeError("audioProcessing.normalize cannot be combined with a loudnorm player filter");
	}
	const filters: string[] = [];
	if (context.filterString?.trim()) filters.push(context.filterString.trim());
	if (options.gainDb != null) filters.push(`volume=${options.gainDb}dB`);
	else if (options.gainLinear != null) filters.push(`volume=${options.gainLinear}`);
	if (context.playbackVolumeLinear != null && context.playbackVolumeLinear !== 1) {
		filters.push(`volume=${context.playbackVolumeLinear}`);
	}
	if (options.highpassHz != null) filters.push(`highpass=f=${options.highpassHz}`);
	if (options.lowpassHz != null) filters.push(`lowpass=f=${options.lowpassHz}`);
	if (options.normalize) {
		const target = options.normalize === true ? LOUDNORM_TARGET.streaming : LOUDNORM_TARGET[options.normalize];
		filters.push(`loudnorm=I=${target}:TP=-1:LRA=11`);
	}
	return filters.join(",");
}

export function describeOutputFormat(options: ResolvedOptions): AudioFrameFormat {
	void options;
	return { kind: "encoded", codec: "opus", container: "ogg" };
}

function buildOutputArgs(options: ResolvedOptions): string[] {
	const rate = String(options.resampleRate ?? options.sampleRate);
	const channels = String(options.channels);
	const bitrate = options.encodedBitrate ?? "128k";
	return [
		"-ar",
		rate,
		"-ac",
		channels,
		"-c:a",
		"libopus",
		"-application",
		options.encodedApplication ?? "audio",
		"-b:a",
		String(bitrate),
		"-f",
		"ogg",
		"pipe:1",
	];
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			stream.off("drain", done);
			stream.off("close", done);
			stream.off("error", done);
			resolve();
		};
		stream.once("drain", done);
		stream.once("close", done);
		stream.once("error", done);
	});
}

interface ActiveProcess {
	proc: ChildProcess;
	exited: Promise<void>;
}

class FFmpegAudioProcessingPipeline implements AudioProcessingPipeline {
	public readonly outputFormat: AudioFrameFormat;
	private disposed = false;
	private readonly active = new Set<ActiveProcess>();
	private readonly options: ResolvedOptions;

	public constructor(
		options: ResolvedOptions,
		private readonly context: AudioProcessingContext = {},
		private readonly acquireProcessSlot: (signal?: AbortSignal) => Promise<() => void> = (signal) => acquireFfmpegSlot(signal),
	) {
		if (options.normalize && filterGraphContainsLoudnorm(context.filterString)) {
			throw new TypeError("audioProcessing.normalize cannot be combined with a loudnorm player filter");
		}
		this.options = options;
		this.outputFormat = describeOutputFormat(options);
	}

	public process(input: Source, signal?: AbortSignal): AsyncIterable<Uint8Array> {
		if (this.disposed) throw new Error("Audio processing pipeline is disposed");
		if (input == null) throw new TypeError("Audio processing input is required");
		const isAsync = typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
		if (!isAsync && typeof (input as Iterable<Uint8Array>)[Symbol.iterator] !== "function") {
			throw new TypeError("Audio processing input must be an async iterable, iterable, or readable stream");
		}

		const effectiveSignal = signal ?? this.context.signal;
		const options = this.options;
		const context = this.context;
		const maxChunk = Math.max(1, Math.floor(options.maxBufferBytes));
		const active = this.active;
		const debug = this.context.debug;
		const stallTimeoutMs = options.stallTimeoutMs === null ? null : (options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
		const maxInputBytes = options.maxInputBytes === null ? null : (options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES);
		const maxDurationMs = options.maxDurationMs === null ? null : options.maxDurationMs;
		const threads = options.ffmpegThreads ?? DEFAULT_FFMPEG_THREADS;
		const acquireProcessSlot = this.acquireProcessSlot;

		return (async function* (): AsyncGenerator<Uint8Array> {
			if (effectiveSignal?.aborted) {
				if (input instanceof Readable && !input.destroyed) input.destroy();
				return;
			}

			let releaseSlot: () => void = () => undefined;
			try {
				releaseSlot = await acquireProcessSlot(effectiveSignal);
			} catch (error) {
				if (input instanceof Readable && !input.destroyed) input.destroy();
				throw error;
			}
			let slotReleased = false;
			const releaseSlotOnce = () => {
				if (slotReleased) return;
				slotReleased = true;
				releaseSlot();
			};

			let fetched: Readable | null = null;
			let source: Source = input;
			let proc: ChildProcess;
			try {
				const useNodeUrl = Boolean(context.inputUrl && context.useInputUrl);
				if (useNodeUrl) {
					if (input instanceof Readable && !input.destroyed) input.destroy();
					fetched = await openSafeHttpStream(context.inputUrl!, effectiveSignal);
					source = fetched;
				}

				const args = ["-hide_banner", "-loglevel", "error", "-threads", String(threads), "-protocol_whitelist", PIPE_PROTOCOLS];
				args.push(...buildInputArgs(options));
				args.push("-i", "pipe:0", "-vn");
				if (typeof context.seekMs === "number" && context.seekMs > 0) {
					args.push("-ss", (context.seekMs / 1000).toFixed(3));
				}
				if (maxDurationMs != null) args.push("-t", (maxDurationMs / 1000).toFixed(3));
				const filterChain = buildFilterChain(options, context);
				if (filterChain) args.push("-af", filterChain);
				args.push(...buildOutputArgs(options));

				const executable = resolveFfmpegExecutable(options.ffmpegPath, ffmpegStaticPath);
				debug?.(`audio processing: ${executable} ${args.join(" ")}`);
				const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"];
				proc = spawn(executable, args, { stdio, windowsHide: true });
			} catch (error) {
				if (fetched && !fetched.destroyed) fetched.destroy();
				else if (input instanceof Readable && !input.destroyed) input.destroy();
				releaseSlotOnce();
				throw error;
			}
			const stdin = proc.stdin;
			const stdout = proc.stdout!;

			let stderrTail = "";
			let spawnError: Error | undefined;
			let upstreamError: unknown;
			let aborted = false;
			let bytesIn = 0;
			let bytesOut = 0;
			let exitCode: number | null = null;
			let exitSignal: NodeJS.Signals | null = null;
			let waitingForDrain = false;
			let waitingForConsumer = false;
			let lastActivity = Date.now();
			let stallError: Error | undefined;

			proc.stderr!.on("data", (chunk: Buffer) => {
				stderrTail = (stderrTail + chunk.toString()).slice(-1500);
			});
			stdin?.on("error", () => {});
			proc.once("error", (error) => {
				spawnError = error;
			});
			const exited = new Promise<void>((resolve) => {
				proc.once("close", (code, closeSignal) => {
					exitCode = code;
					exitSignal = closeSignal;
					resolve();
				});
			});
			const entry: ActiveProcess = { proc, exited };
			active.add(entry);

			const kill = () => {
				try {
					stdin?.destroy();
				} catch {}
				try {
					proc.kill("SIGKILL");
				} catch {}
			};
			const iterator: AsyncIterator<Uint8Array> =
				typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function" ?
					(source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
				:	(async function* () {
						yield* source as Iterable<Uint8Array>;
					})();
			const releaseInput = () => {
				if (input instanceof Readable && !input.destroyed) input.destroy();
				if (fetched && !fetched.destroyed) fetched.destroy();
				try {
					void Promise.resolve(iterator.return?.()).catch(() => {});
				} catch {}
			};
			const onAbort = () => {
				aborted = true;
				kill();
				releaseInput();
			};
			effectiveSignal?.addEventListener("abort", onAbort, { once: true });

			let stallTimer: ReturnType<typeof setInterval> | null = null;
			if (stallTimeoutMs != null) {
				stallTimer = setInterval(
					() => {
						if (aborted || waitingForDrain || waitingForConsumer) return;
						if (Date.now() - lastActivity < stallTimeoutMs) return;
						stallError = new Error(`FFmpeg stalled for ${stallTimeoutMs}ms with no input or output`);
						aborted = true;
						kill();
						releaseInput();
					},
					Math.min(1000, stallTimeoutMs),
				);
				stallTimer.unref?.();
			}

			if (stdin) {
				void (async () => {
					try {
						while (true) {
							const { value, done } = await iterator.next();
							if (done) break;
							if (!stdin.writable) break;
							lastActivity = Date.now();
							bytesIn += value.byteLength;
							if (maxInputBytes != null && bytesIn > maxInputBytes) {
								throw new Error("Audio processing exceeded maxInputBytes");
							}
							if (!stdin.write(value)) {
								waitingForDrain = true;
								await waitForDrain(stdin);
								waitingForDrain = false;
								lastActivity = Date.now();
							}
						}
						if (stdin.writable) stdin.end();
					} catch (error) {
						if (!aborted) upstreamError = error;
						kill();
					}
				})();
			}

			const failMessage = (prefix: string, detail?: string) => `${prefix}${detail ? `: ${sanitizeFfmpegLog(detail)}` : ""}`;

			try {
				for await (const raw of stdout) {
					if (aborted || effectiveSignal?.aborted) return;
					lastActivity = Date.now();
					const read = raw as Buffer;
					bytesOut += read.length;
					waitingForConsumer = true;
					try {
						for (let offset = 0; offset < read.length; offset += maxChunk) {
							yield new Uint8Array(read.buffer, read.byteOffset + offset, Math.min(maxChunk, read.length - offset));
						}
					} finally {
						waitingForConsumer = false;
						lastActivity = Date.now();
					}
				}
				if (aborted || effectiveSignal?.aborted) {
					if (stallError) throw stallError;
					return;
				}
				await exited;
				if (stallError) throw stallError;
				if (upstreamError) throw upstreamError;
				if (spawnError) throw spawnError;
				if (bytesOut === 0 && bytesIn > 0) {
					throw new Error(failMessage("FFmpeg produced no audio", stderrTail));
				}
				if (exitCode !== 0) {
					throw new Error(
						failMessage(
							`FFmpeg exited with code ${exitCode ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}`,
							stderrTail || "no stderr",
						),
					);
				}
			} finally {
				if (stallTimer) clearInterval(stallTimer);
				effectiveSignal?.removeEventListener("abort", onAbort);
				kill();
				releaseInput();
				await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref())]);
				active.delete(entry);
				releaseSlotOnce();
			}
		})();
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.active];
		for (const { proc } of entries) {
			try {
				proc.stdin?.destroy();
			} catch {}
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
		await Promise.race([
			Promise.all(entries.map((entry) => entry.exited)),
			new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref()),
		]);
	}
}

export class FFmpegAudioProcessingEngine implements AudioProcessingEngine {
	private readonly defaults: AudioProcessingOptions;
	private readonly processGate: FfmpegProcessGate;

	public constructor(defaults: AudioProcessingOptions = {}) {
		resolveAudioProcessingOptions({ enabled: true, outputFormat: "encoded", inputFormat: "encoded" }, defaults);
		this.defaults = { ...defaults };
		this.processGate = new FfmpegProcessGate(defaults.maxConcurrentProcesses ?? defaultFfmpegConcurrency());
	}

	public async createPipeline(
		options: AudioProcessingOptions,
		context: AudioProcessingContext = {},
	): Promise<AudioProcessingPipeline> {
		const resolved = resolveAudioProcessingOptions(this.defaults, options);
		if (options.maxConcurrentProcesses != null) this.processGate.configure(options.maxConcurrentProcesses);
		const acquireProcessSlot = async (signal?: AbortSignal) => {
			const releaseLocal = await this.processGate.acquire(signal);
			try {
				const releaseGlobal = await acquireFfmpegSlot(signal);
				return () => {
					releaseGlobal();
					releaseLocal();
				};
			} catch (error) {
				releaseLocal();
				throw error;
			}
		};
		return new FFmpegAudioProcessingPipeline(resolved, context, acquireProcessSlot);
	}
}
