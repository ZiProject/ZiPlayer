import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import ffmpegStaticPath from "ffmpeg-static";
import type { AudioFrameFormat } from "../output/AudioOutputBackend";
import type {
	AudioProcessingContext,
	AudioProcessingEngine,
	AudioProcessingOptions,
	AudioProcessingPipeline,
} from "./AudioProcessingEngine";

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
/** Longest we wait for a killed FFmpeg process to be reaped before giving up on it. */
const KILL_GRACE_MS = 2000;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
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
		outputFormat: "pcm16le",
		sampleRate: 48_000,
		channels: 2,
		maxBufferBytes: 64 * 1024,
		...merged,
	} as ResolvedOptions;

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
			`Audio processing inputFormat=${String(resolved.inputFormat)} is not supported by the current runtime; use encoded input and let FFmpeg decode it before DSP processing.`,
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
	if (!isFiniteNumber(resolved.maxBufferBytes) || resolved.maxBufferBytes <= 0) {
		throw new TypeError("Audio processing maxBufferBytes must be a positive finite number");
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
	return resolved;
}

function validateInputFormat(format: AudioFrameFormat | undefined): void {
	if (!format || format.kind !== "pcm") return;
	if (format.sampleFormat !== "s16" && format.sampleFormat !== "f32") {
		throw new TypeError(`Unsupported PCM input sample format: ${String(format.sampleFormat)}`);
	}
	if (format.endianness !== "little") throw new TypeError("PCM input must be little-endian");
	if (format.channelLayout !== "interleaved") throw new TypeError("PCM input must be interleaved");
	if (!isFiniteNumber(format.sampleRateHz) || format.sampleRateHz <= 0) {
		throw new TypeError("PCM input sampleRateHz must be a positive finite number");
	}
	if (!isFiniteNumber(format.channels) || format.channels <= 0 || !Number.isInteger(format.channels)) {
		throw new TypeError("PCM input channels must be a positive integer");
	}
}

function buildInputArgs(options: ResolvedOptions, inputFormat: AudioFrameFormat | undefined): string[] {
	if (inputFormat?.kind === "pcm") {
		return [
			"-f",
			inputFormat.sampleFormat === "f32" ? "f32le" : "s16le",
			"-ar",
			String(inputFormat.sampleRateHz),
			"-ac",
			String(inputFormat.channels),
		];
	}
	const formats = options.ffmpegInputFormats === undefined ? DEFAULT_FFMPEG_INPUT_FORMATS : options.ffmpegInputFormats;
	return formats && formats.length > 0 ? ["-format_whitelist", formats.join(",")] : [];
}

function buildFilterChain(options: ResolvedOptions): string {
	const filters: string[] = [];
	if (options.gainDb != null) filters.push(`volume=${options.gainDb}dB`);
	else if (options.gainLinear != null) filters.push(`volume=${options.gainLinear}`);
	if (options.highpassHz != null) filters.push(`highpass=f=${options.highpassHz}`);
	if (options.lowpassHz != null) filters.push(`lowpass=f=${options.lowpassHz}`);
	if (options.normalize) {
		const target = options.normalize === true ? LOUDNORM_TARGET.streaming : LOUDNORM_TARGET[options.normalize];
		filters.push(`loudnorm=I=${target}:TP=-1:LRA=11`);
	}
	return filters.join(",");
}

function resolveExecutable(explicit?: string | null): string {
	const candidates = [explicit, process.env.FFMPEG_PATH, ffmpegStaticPath, "ffmpeg"];
	return candidates.find((path) => path && (path === "ffmpeg" || fs.existsSync(path))) || "ffmpeg";
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
	) {
		validateInputFormat(context.inputFormat);
		this.options = options;
		const bytesPerSample = options.outputFormat === "pcmFloat32" ? 4 : 2;
		this.outputFormat = {
			kind: "pcm",
			sampleFormat: bytesPerSample === 4 ? "f32" : "s16",
			endianness: "little",
			sampleRateHz: options.resampleRate ?? options.sampleRate,
			channels: options.channels,
			channelLayout: "interleaved",
			chunkAlignmentBytes: options.channels * bytesPerSample,
		};
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
		const alignment = this.outputFormat.kind === "pcm" ? (this.outputFormat.chunkAlignmentBytes ?? 4) : 4;
		const maxChunk = Math.max(alignment, Math.floor(options.maxBufferBytes / alignment) * alignment);
		const active = this.active;
		const debug = this.context.debug;
		const inputFormat = this.context.inputFormat;

		return (async function* (): AsyncGenerator<Uint8Array> {
			if (effectiveSignal?.aborted) {
				if (input instanceof Readable && !input.destroyed) input.destroy();
				return;
			}

			const args = ["-hide_banner", "-loglevel", "error", ...buildInputArgs(options, inputFormat), "-i", "pipe:0", "-vn"];
			const filterChain = buildFilterChain(options);
			if (filterChain) args.push("-af", filterChain);
			args.push(
				"-f",
				options.outputFormat === "pcmFloat32" ? "f32le" : "s16le",
				"-ar",
				String(options.resampleRate ?? options.sampleRate),
				"-ac",
				String(options.channels),
				"pipe:1",
			);

			const executable = resolveExecutable(options.ffmpegPath);
			debug?.(`audio processing: ${executable} ${args.join(" ")}`);
			const proc = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			const stdin = proc.stdin!;
			const stdout = proc.stdout!;

			let stderrTail = "";
			let spawnError: Error | undefined;
			let upstreamError: unknown;
			let aborted = false;
			let bytesIn = 0;
			let bytesOut = 0;
			let exitCode: number | null = null;
			let exitSignal: NodeJS.Signals | null = null;

			proc.stderr!.on("data", (chunk: Buffer) => {
				stderrTail = (stderrTail + chunk.toString()).slice(-1500);
			});
			// EPIPE is expected whenever FFmpeg exits (or is killed) before the input is fully written.
			stdin.on("error", () => {});
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
					stdin.destroy();
				} catch {}
				try {
					proc.kill("SIGKILL");
				} catch {}
			};
			const iterator: AsyncIterator<Uint8Array> =
				isAsync ?
					(input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
				:	(async function* () {
						yield* input as Iterable<Uint8Array>;
					})();
			// A generator suspended inside an `await` cannot be cancelled from outside, so the return() is
			// fire-and-forget. Node Readables are destroyed explicitly, which is what actually frees the socket.
			const releaseInput = () => {
				if (input instanceof Readable && !input.destroyed) input.destroy();
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

			// Input -> FFmpeg stdin with real backpressure: the source is only pulled while stdin has room.
			void (async () => {
				try {
					while (true) {
						const { value, done } = await iterator.next();
						if (done) break;
						if (!stdin.writable) break;
						bytesIn += value.byteLength;
						if (!stdin.write(value)) await waitForDrain(stdin);
					}
					if (stdin.writable) stdin.end();
				} catch (error) {
					if (!aborted) upstreamError = error;
					kill();
				}
			})();

			try {
				let carry: Buffer = Buffer.alloc(0);
				for await (const raw of stdout) {
					if (aborted || effectiveSignal?.aborted) return;
					const read = raw as Buffer;
					bytesOut += read.length;
					const buffer = carry.length ? Buffer.concat([carry, read]) : read;
					const usable = buffer.length - (buffer.length % alignment);
					carry = usable < buffer.length ? Buffer.from(buffer.subarray(usable)) : Buffer.alloc(0);
					for (let offset = 0; offset < usable; offset += maxChunk) {
						yield new Uint8Array(buffer.buffer, buffer.byteOffset + offset, Math.min(maxChunk, usable - offset));
					}
				}
				if (aborted || effectiveSignal?.aborted) return;
				await exited;
				if (upstreamError) throw upstreamError;
				if (spawnError) throw spawnError;
				// FFmpeg can exit 0 while decoding nothing (e.g. MP4 with the moov atom at the end, read from a pipe).
				if (bytesOut === 0 && bytesIn > 0) {
					throw new Error(`FFmpeg produced no audio${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`);
				}
				if (exitCode !== 0) {
					throw new Error(
						`FFmpeg exited with code ${exitCode ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}: ${stderrTail.trim() || "no stderr"}`,
					);
				}
			} finally {
				effectiveSignal?.removeEventListener("abort", onAbort);
				kill();
				releaseInput();
				await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref())]);
				active.delete(entry);
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

	public constructor(defaults: AudioProcessingOptions = {}) {
		resolveAudioProcessingOptions({ enabled: true, outputFormat: "pcm16le", inputFormat: "encoded" }, defaults);
		this.defaults = { ...defaults };
	}

	public async createPipeline(
		options: AudioProcessingOptions,
		context: AudioProcessingContext = {},
	): Promise<AudioProcessingPipeline> {
		return new FFmpegAudioProcessingPipeline(resolveAudioProcessingOptions(this.defaults, options), context);
	}
}
