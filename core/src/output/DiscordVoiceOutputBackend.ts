import {
	AudioPlayer,
	AudioPlayerState,
	AudioPlayerStatus,
	AudioResource,
	createAudioResource,
	StreamType,
} from "@discordjs/voice";
import { Readable } from "stream";
import type {
	AudioFrameFormat,
	AudioOutputBackend,
	AudioOutputCapabilities,
	AudioOutputContext,
	AudioOutputEvent,
	AudioOutputHandle,
	AudioOutputInput,
	AudioOutputState,
} from "./AudioOutputBackend";
import { AudioOutputUnsupportedOperationError, createAudioAbortError } from "./AudioOutputBackend";

const DISCORD_CAPABILITIES: AudioOutputCapabilities = {
	pause: true,
	resume: true,
	stop: true,
	seek: "unsupported",
	replacement: "atomic",
	ownership: "transfer",
	volume: "backend",
	backpressure: "source",
	maxBufferedBytes: null,
};

function isAbortError(signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted);
}

function assertNotAborted(signal?: AbortSignal): void {
	if (isAbortError(signal)) throw createAudioAbortError();
}

function isCurrentResource(state: AudioPlayerState, resource: AudioResource): boolean {
	return "resource" in state && state.resource === resource;
}

function discordStreamType(format: AudioFrameFormat): StreamType | undefined {
	if (format.kind === "pcm") {
		if (
			format.sampleRateHz !== 48_000 ||
			format.channels !== 2 ||
			format.channelLayout !== "interleaved" ||
			format.endianness !== "little"
		) {
			throw new TypeError("Discord raw PCM requires interleaved 48 kHz stereo little-endian samples");
		}
		if (format.sampleFormat !== "s16" && format.sampleFormat !== "f32") {
			throw new TypeError(`Unsupported Discord PCM sample format: ${format.sampleFormat}`);
		}
		return StreamType.Raw;
	}

	if (format.codec === "opus" && format.container === "ogg") return StreamType.OggOpus;
	if (format.codec === "opus" && format.container === "webm") return StreamType.WebmOpus;
	if (format.codec === "opus") return StreamType.Opus;
	if (!format.codec && !format.container) return undefined;
	return StreamType.Arbitrary;
}

export function audioFrameFormatFromDiscordStreamType(streamType?: StreamType): AudioFrameFormat {
	switch (streamType) {
		case StreamType.Opus:
			return { kind: "encoded", codec: "opus" };
		case StreamType.OggOpus:
			return { kind: "encoded", codec: "opus", container: "ogg" };
		case StreamType.WebmOpus:
			return { kind: "encoded", codec: "opus", container: "webm" };
		case StreamType.Raw:
			return {
				kind: "pcm",
				sampleFormat: "s16",
				endianness: "little",
				sampleRateHz: 48_000,
				channels: 2,
				channelLayout: "interleaved",
				chunkAlignmentBytes: 4,
			};
		default:
			return { kind: "encoded" };
	}
}

export function resolveOutputStreamType(
	options: { enabled?: boolean; outputFormat?: "encoded" | "pcm16le" | "pcmFloat32" },
	fallback: StreamType = StreamType.Arbitrary,
): StreamType {
	if (options.enabled === false) return fallback;
	const outputFormat = options.outputFormat ?? "pcm16le";
	if (outputFormat === "pcm16le" || outputFormat === "pcmFloat32") return StreamType.Raw;
	if (outputFormat === "encoded") return fallback;
	throw new TypeError(`Invalid audio processing output format: ${String(outputFormat)}`);
}

export function convertFloat32PcmToS16Le(input: Readable): Readable {
	return Readable.from(
		(async function* () {
			let remainder = Buffer.alloc(0);
			for await (const chunk of input) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const data = remainder.length ? Buffer.concat([remainder, bytes]) : bytes;
				const alignedLength = data.length - (data.length % 4);
				if (alignedLength > 0) {
					const output = Buffer.allocUnsafe((alignedLength / 4) * 2);
					for (let inputOffset = 0, outputOffset = 0; inputOffset < alignedLength; inputOffset += 4, outputOffset += 2) {
						const rawSample = data.readFloatLE(inputOffset);
						const sample = Number.isFinite(rawSample) ? Math.max(-1, Math.min(1, rawSample)) : 0;
						output.writeInt16LE(Math.round(sample * 32767), outputOffset);
					}
					yield output;
				}
				remainder = data.subarray(alignedLength);
			}
			if (remainder.length !== 0) throw new Error("Float32 PCM stream ended with an incomplete sample");
		})(),
		{ objectMode: false },
	);
}

class DiscordVoiceOutputHandle implements AudioOutputHandle<AudioResource> {
	private stateValue: AudioOutputState = "ready";
	private disposed = false;
	private readonly listeners = new Set<(event: AudioOutputEvent) => void>();
	private readonly detachListeners = new Set<() => void>();
	private readonly detachSignal?: () => void;
	private readonly detachInputClose: () => void;

	public readonly ready: Promise<void>;

	public constructor(
		private readonly backend: DiscordVoiceOutputBackend,
		public readonly resource: AudioResource,
		public readonly format: AudioFrameFormat,
		private readonly input: AudioOutputInput,
		private readonly signal?: AbortSignal,
	) {
		this.ready = backend.ready;
		const onInputClose = () => {
			if (!backend.isCurrent(this)) this.dispose();
		};
		input.stream.once("close", onInputClose);
		this.detachInputClose = () => input.stream.off("close", onInputClose);
		if (signal) {
			const abort = () => {
				this.stateValue = "stopped";
				this.backend.stopHandle(this);
				void this.dispose();
			};
			if (signal.aborted) abort();
			else {
				signal.addEventListener("abort", abort, { once: true });
				this.detachSignal = () => signal.removeEventListener("abort", abort);
			}
		}
	}

	public get state(): AudioOutputState {
		if (this.disposed) return this.stateValue;
		const playerState = this.backend.player.state;
		if (isCurrentResource(playerState, this.resource)) {
			if (playerState.status === AudioPlayerStatus.Playing) return "playing";
			if (playerState.status === AudioPlayerStatus.Paused || playerState.status === AudioPlayerStatus.AutoPaused) return "paused";
			if (playerState.status === AudioPlayerStatus.Buffering) return "buffering";
		}
		return this.stateValue;
	}

	public get bufferedBytes(): number | null {
		return null;
	}

	public start(signal?: AbortSignal): void {
		assertNotAborted(this.signal);
		assertNotAborted(signal);
		this.backend.startHandle(this);
		this.stateValue = "buffering";
		this.emit({ type: "state", state: "buffering" });
	}

	public pause(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal);
		assertNotAborted(signal);
		const changed = this.backend.pauseHandle(this);
		if (changed) {
			this.stateValue = "paused";
			this.emit({ type: "state", state: "paused" });
		}
		return changed;
	}

	public resume(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal);
		assertNotAborted(signal);
		const changed = this.backend.resumeHandle(this);
		if (changed) {
			this.stateValue = "playing";
			this.emit({ type: "state", state: "playing" });
		}
		return changed;
	}

	public stop(signal?: AbortSignal): boolean {
		assertNotAborted(signal);
		if (this.disposed) return false;
		const changed = this.backend.stopHandle(this);
		this.stateValue = "stopped";
		this.emit({ type: "state", state: "stopped" });
		this.destroyTransferredInput();
		return changed;
	}

	public seek(_positionMs: number, signal?: AbortSignal): boolean {
		assertNotAborted(signal);
		throw new AudioOutputUnsupportedOperationError("seeking; replace the resource at the requested position");
	}

	public replace(input: AudioOutputInput, signal?: AbortSignal): AudioOutputHandle<AudioResource> {
		assertNotAborted(signal);
		const replacement = this.backend.createSession(input, { signal });
		replacement.start(signal);
		void this.dispose();
		return replacement;
	}

	public setVolume(value: number, signal?: AbortSignal): void {
		assertNotAborted(signal);
		this.backend.setVolume(this.resource, value);
	}

	public onEvent(listener: (event: AudioOutputEvent) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		let active = true;
		const detach = () => {
			if (!active) return;
			active = false;
			this.listeners.delete(listener);
			this.detachListeners.delete(detach);
		};
		this.detachListeners.add(detach);
		return detach;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachSignal?.();
		this.detachInputClose();
		for (const detach of [...this.detachListeners]) detach();
		if (this.backend.isCurrent(this)) this.backend.stopHandle(this);
		this.destroyTransferredInput();
		this.backend.release(this);
		this.stateValue = "stopped";
	}

	public markEnded(): void {
		if (this.disposed || this.stateValue === "stopped") return;
		this.stateValue = "ended";
		this.emit({ type: "state", state: "ended" });
		this.detachSignal?.();
		this.detachInputClose();
		for (const detach of [...this.detachListeners]) detach();
		this.destroyTransferredInput();
		this.disposed = true;
		this.backend.release(this);
	}

	public markFailed(error: Error): void {
		if (this.disposed) return;
		this.stateValue = "failed";
		this.emit({ type: "error", error });
	}

	private emit(event: AudioOutputEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	public emitEvent(event: AudioOutputEvent): void {
		this.emit(event);
	}

	public observeState(state: AudioOutputState): void {
		if (this.disposed) return;
		this.stateValue = state;
		this.emit({ type: "state", state });
	}

	private destroyTransferredInput(): void {
		if (this.input.ownership === "transfer" && !this.input.stream.destroyed) this.input.stream.destroy();
	}
}

export class DiscordVoiceOutputBackend implements AudioOutputBackend<AudioResource> {
	public readonly capabilities = DISCORD_CAPABILITIES;
	public readonly ready = Promise.resolve();
	private readonly handles = new Map<AudioResource, DiscordVoiceOutputHandle>();
	private activeHandle: DiscordVoiceOutputHandle | null = null;
	private disposed = false;
	private readonly onPlayerStateChange = (oldState: AudioPlayerState, newState: AudioPlayerState) => {
		const handle = this.activeHandle;
		if (!handle) return;
		if (isCurrentResource(newState, handle.resource)) {
			switch (newState.status) {
				case AudioPlayerStatus.Buffering:
					handle.observeState("buffering");
					break;
				case AudioPlayerStatus.Playing:
					handle.observeState("playing");
					break;
				case AudioPlayerStatus.Paused:
				case AudioPlayerStatus.AutoPaused:
					handle.observeState("paused");
					break;
			}
			return;
		}
		if (isCurrentResource(oldState, handle.resource)) {
			this.activeHandle = null;
			handle.markEnded();
		}
	};
	private readonly onPlayerError = (error: Error & { resource?: AudioResource }) => {
		const handle = error.resource ? this.handles.get(error.resource) : this.activeHandle;
		handle?.markFailed(error);
	};

	public constructor(public readonly player: AudioPlayer) {
		player.on("stateChange", this.onPlayerStateChange);
		player.on("error", this.onPlayerError);
	}

	public async initialize(signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error("Discord voice output backend is disposed");
		assertNotAborted(signal);
		await this.ready;
		assertNotAborted(signal);
	}

	public createSession(input: AudioOutputInput, context: AudioOutputContext = {}): AudioOutputHandle<AudioResource> {
		try {
			return this.createSessionWithInputType(input, context, discordStreamType(input.format));
		} catch (error) {
			this.discardTransferredInput(input);
			throw error;
		}
	}

	private createSessionWithInputType(
		input: AudioOutputInput,
		context: AudioOutputContext,
		inputType: StreamType | undefined,
	): AudioOutputHandle<AudioResource> {
		if (this.disposed) throw new Error("Discord voice output backend is disposed");
		assertNotAborted(context.signal);
		if (input.ownership !== "transfer") {
			throw new TypeError(
				"Discord voice output requires transferred stream ownership because AudioPlayer destroys replaced resources",
			);
		}
		let outputStream = input.stream;
		try {
			if (input.format.kind === "pcm" && input.format.sampleFormat === "f32") {
				outputStream = convertFloat32PcmToS16Le(input.stream);
			}
			const resource = createAudioResource(outputStream, {
				metadata: context.metadata,
				inlineVolume: true,
				...(inputType === undefined ? {} : { inputType }),
			});
			const handle = new DiscordVoiceOutputHandle(this, resource, input.format, input, context.signal);
			this.handles.set(resource, handle);
			return handle;
		} catch (error) {
			if (outputStream !== input.stream && !outputStream.destroyed) outputStream.destroy();
			this.discardTransferredInput(input);
			throw error;
		}
	}

	public createResource(
		stream: Readable,
		metadata: unknown,
		inputType?: StreamType,
		format?: AudioFrameFormat,
		signal?: AbortSignal,
	): AudioResource {
		const inferredInputType = inputType ?? (stream as Readable & { inputType?: StreamType }).inputType;
		const inputFormat = format ?? audioFrameFormatFromDiscordStreamType(inferredInputType);
		const discordInputType = format ? discordStreamType(format) : inferredInputType;
		const input: AudioOutputInput = { stream, format: inputFormat, ownership: "transfer" };
		try {
			return this.createSessionWithInputType(input, { metadata, signal }, discordInputType).resource;
		} catch (error) {
			this.discardTransferredInput(input);
			throw error;
		}
	}

	public play(resource: AudioResource, signal?: AbortSignal): void {
		this.handleFor(resource).start(signal);
	}

	public pause(resource?: AudioResource | null, signal?: AbortSignal): boolean {
		assertNotAborted(signal);
		if (resource && this.activeHandle?.resource !== resource) return false;
		return this.player.pause(true);
	}

	public resume(resource?: AudioResource | null, signal?: AbortSignal): boolean {
		assertNotAborted(signal);
		if (resource && this.activeHandle?.resource !== resource) return false;
		return this.player.unpause();
	}

	public stop(resource?: AudioResource | null, signal?: AbortSignal): boolean {
		assertNotAborted(signal);
		if (resource && this.activeHandle?.resource !== resource) return false;
		const stopped = this.player.stop(true);
		if (this.activeHandle) {
			this.activeHandle.markEnded();
			this.activeHandle = null;
		}
		return stopped;
	}

	public setVolume(resource: AudioResource, value: number): void {
		if (!resource.volume) throw new AudioOutputUnsupportedOperationError("backend volume control");
		resource.volume.setVolume(value);
	}

	public getVolume(resource: AudioResource): number | null {
		return resource.volume?.volume ?? null;
	}

	public getSessionHandle(resource: AudioResource): AudioOutputHandle<AudioResource> {
		return this.handleFor(resource);
	}

	public isCurrent(handle: DiscordVoiceOutputHandle): boolean {
		return this.activeHandle === handle;
	}

	public startHandle(handle: DiscordVoiceOutputHandle): void {
		if (this.disposed) throw new Error("Discord voice output backend is disposed");
		const previousHandle = this.activeHandle;
		this.activeHandle = handle;
		try {
			this.player.play(handle.resource);
		} catch (error) {
			this.activeHandle = previousHandle;
			throw error;
		}
		if (previousHandle && previousHandle !== handle) previousHandle.markEnded();
	}

	public pauseHandle(handle: DiscordVoiceOutputHandle): boolean {
		if (this.activeHandle !== handle) return false;
		return this.player.pause(true);
	}

	public resumeHandle(handle: DiscordVoiceOutputHandle): boolean {
		if (this.activeHandle !== handle) return false;
		return this.player.unpause();
	}

	public stopHandle(handle: DiscordVoiceOutputHandle): boolean {
		if (this.activeHandle !== handle) return false;
		const stopped = this.player.stop(true);
		this.activeHandle = null;
		return stopped;
	}

	public release(handle: DiscordVoiceOutputHandle): void {
		this.handles.delete(handle.resource);
		if (this.activeHandle === handle) this.activeHandle = null;
	}

	private discardTransferredInput(input: AudioOutputInput): void {
		if (input.ownership === "transfer" && !input.stream.destroyed) input.stream.destroy();
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const handle of [...this.handles.values()]) handle.dispose();
		this.player.stop(true);
		this.activeHandle = null;
		this.player.off("stateChange", this.onPlayerStateChange);
		this.player.off("error", this.onPlayerError);
	}

	private handleFor(resource: AudioResource): DiscordVoiceOutputHandle {
		const existing = this.handles.get(resource);
		if (existing) return existing;
		const format = audioFrameFormatFromDiscordStreamType(undefined);
		const input: AudioOutputInput = {
			stream: resource.playStream ?? Readable.from([]),
			format,
			ownership: "transfer",
		};
		const handle = new DiscordVoiceOutputHandle(this, resource, format, input);
		this.handles.set(resource, handle);
		return handle;
	}
}
