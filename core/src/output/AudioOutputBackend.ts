import type { Readable } from "stream";

export type AudioFrameFormat =
	| {
			kind: "encoded";
			codec?: string;
			container?: string;
	  }
	| {
			kind: "pcm";
			sampleFormat: "s16" | "f32";
			endianness: "little";
			sampleRateHz: number;
			channels: number;
			channelLayout: "interleaved";
			frameSamplesPerChannel?: number;
			chunkAlignmentBytes?: number;
	  };

export interface AudioOutputInput {
	stream: Readable;
	format: AudioFrameFormat;
	ownership: "transfer" | "borrow";
}

export interface AudioOutputCapabilities {
	pause: boolean;
	resume: boolean;
	stop: boolean;
	seek: "native" | "replace" | "unsupported";
	replacement: "atomic" | "stop-before-start" | "unsupported";
	ownership: "transfer" | "borrow" | "both";
	volume: "backend" | "upstream" | "unsupported";
	backpressure: "source" | "bounded" | "unbounded";
	maxBufferedBytes: number | null;
}

export type AudioOutputState = "ready" | "buffering" | "playing" | "paused" | "stopped" | "ended" | "failed";

export type AudioOutputEvent = { type: "state"; state: AudioOutputState } | { type: "error"; error: Error };

export interface AudioOutputContext {
	signal?: AbortSignal;
	metadata?: unknown;
}

export interface AudioOutputBackendFactoryContext {
	playerId: string;
}

export type AudioOutputBackendFactory<TResource = unknown> = (
	context: AudioOutputBackendFactoryContext,
) => AudioOutputBackend<TResource>;

export interface AudioOutputHandle<TResource = unknown> {
	readonly resource: TResource;
	readonly format: AudioFrameFormat;
	readonly ready: Promise<void>;
	readonly state: AudioOutputState;
	readonly bufferedBytes: number | null;
	start(signal?: AbortSignal): void | Promise<void>;
	pause(signal?: AbortSignal): boolean | Promise<boolean>;
	resume(signal?: AbortSignal): boolean | Promise<boolean>;
	stop(signal?: AbortSignal): boolean | Promise<boolean>;
	seek(positionMs: number, signal?: AbortSignal): boolean | Promise<boolean>;
	replace(input: AudioOutputInput, signal?: AbortSignal): AudioOutputHandle<TResource> | Promise<AudioOutputHandle<TResource>>;
	setVolume(value: number, signal?: AbortSignal): void | Promise<void>;
	onEvent(listener: (event: AudioOutputEvent) => void): () => void;
	dispose(): void | Promise<void>;
}

export interface AudioOutputBackend<TResource = unknown> {
	readonly capabilities: AudioOutputCapabilities;
	readonly ready: Promise<void>;
	initialize(signal?: AbortSignal): Promise<void>;
	createSession(input: AudioOutputInput, context?: AudioOutputContext): AudioOutputHandle<TResource>;
	dispose(): void | Promise<void>;
}

export class AudioOutputUnsupportedOperationError extends Error {
	public constructor(operation: string) {
		super(`Audio output does not support ${operation}`);
		this.name = "AudioOutputUnsupportedOperationError";
	}
}

export function createAudioAbortError(): Error {
	const error = new Error("Audio output operation was aborted");
	error.name = "AbortError";
	return error;
}
