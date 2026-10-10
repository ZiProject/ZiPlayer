import type { Readable } from "stream";
import { AudioOutputUnsupportedOperationError, createAudioAbortError } from "./AudioOutputBackend";
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

export const WEB_AUDIO_PROTOCOL_VERSION = 1;
export const WEB_AUDIO_SAMPLE_RATE_HZ = 48_000;
export const WEB_AUDIO_CHANNELS = 2;
export const WEB_AUDIO_SAMPLE_BYTES = 2;
export const WEB_AUDIO_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface WebSocketLike {
	readyState: number;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: (event: any) => void): void;
	removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WebSocketAudioControlMessage =
	| { v: number; type: "ready"; sessionId: string; protocolVersion: number }
	| { v: number; type: "audio:config"; sessionId: string; protocolVersion: number; sampleRateHz: number; channels: number; sampleFormat: "s16"; endianness: "little"; channelLayout: "interleaved"; }
	| { v: number; type: "audio:frame"; sessionId: string; sequence: number; timestampMs: number }
	| { v: number; type: "playback:pause"; sessionId: string }
	| { v: number; type: "playback:resume"; sessionId: string }
	| { v: number; type: "playback:stop"; sessionId: string }
	| { v: number; type: "playback:state"; sessionId: string; state: AudioOutputState }
	| { v: number; type: "error"; sessionId: string; code: string; message: string }
	| { v: number; type: "pong"; sessionId?: string }
	| { v: number; type: string; sessionId?: string; [key: string]: unknown };

export interface WebSocketAudioOutputBackendOptions {
	protocolVersion?: number;
	maxBufferedBytes?: number;
	socketFactory?: (context: WebSocketAudioBackendContext) => WebSocketLike | Promise<WebSocketLike>;
	authorize?: (context: WebSocketAudioBackendContext) => boolean | Promise<boolean>;
}

export interface WebSocketAudioBackendContext {
	playerId?: string;
	sessionId?: string;
	metadata?: unknown;
	signal?: AbortSignal;
}

export interface WebSocketAudioSessionResource {
	readonly id: string;
	readonly sessionId: string;
	socket: WebSocketLike | null;
	readonly protocolVersion: number;
}

export function webAudioFormatFromPcm(options: { sampleRateHz?: number; channels?: number; sampleFormat?: "s16" | "f32"; }): AudioFrameFormat {
	return {
		kind: "pcm",
		sampleFormat: options.sampleFormat ?? "s16",
		endianness: "little",
		sampleRateHz: options.sampleRateHz ?? WEB_AUDIO_SAMPLE_RATE_HZ,
		channels: options.channels ?? WEB_AUDIO_CHANNELS,
		channelLayout: "interleaved",
		chunkAlignmentBytes: (options.channels ?? WEB_AUDIO_CHANNELS) * WEB_AUDIO_SAMPLE_BYTES,
	};
}

export function validateWebAudioOutputFormat(format: AudioFrameFormat): void {
	if (format.kind !== "pcm") {
		throw new TypeError("WebSocket audio output backend only supports PCM input streams");
	}
	if (format.sampleFormat !== "s16") {
		throw new TypeError("WebSocket audio output backend only supports 16-bit little-endian PCM samples");
	}
	if (format.endianness !== "little") {
		throw new TypeError("WebSocket audio output backend requires little-endian PCM samples");
	}
	if (format.sampleRateHz !== WEB_AUDIO_SAMPLE_RATE_HZ) {
		throw new TypeError(`WebSocket audio output backend requires ${WEB_AUDIO_SAMPLE_RATE_HZ} Hz PCM output`);
	}
	if (format.channels !== WEB_AUDIO_CHANNELS) {
		throw new TypeError(`WebSocket audio output backend requires ${WEB_AUDIO_CHANNELS} channels`);
	}
	if (format.channelLayout !== "interleaved") {
		throw new TypeError("WebSocket audio output backend requires interleaved stereo PCM");
	}
}

export function encodeWebAudioControlMessage(message: Record<string, unknown>): string {
	const payload = { v: WEB_AUDIO_PROTOCOL_VERSION, ...message };
	return JSON.stringify(payload);
}

export function decodeWebAudioControlMessage(payload: string): Record<string, unknown> {
	const parsed = JSON.parse(payload) as Record<string, unknown>;
	if (typeof parsed.v !== "number" || parsed.v !== WEB_AUDIO_PROTOCOL_VERSION) {
		throw new Error(`Unsupported Web audio protocol version: ${String(parsed.v ?? "unknown")}`);
	}
	return parsed;
}

export function encodeWebAudioFrame(payload: Uint8Array, sequence: number, timestampMs: number): Uint8Array {
	if (payload.length > WEB_AUDIO_MAX_MESSAGE_BYTES) {
		throw new Error(`Audio frame payload exceeds ${WEB_AUDIO_MAX_MESSAGE_BYTES} bytes`);
	}
	const header = Buffer.allocUnsafe(16);
	header.writeUInt32LE(sequence >>> 0, 0);
	header.writeUInt32LE(timestampMs >>> 0, 4);
	header.writeUInt16LE(WEB_AUDIO_SAMPLE_RATE_HZ, 8);
	header.writeUInt16LE(WEB_AUDIO_CHANNELS, 10);
	header.writeUInt16LE(WEB_AUDIO_SAMPLE_BYTES, 12);
	header.writeUInt16LE(0, 14);
	const output = Buffer.alloc(header.length + payload.length);
	output.set(header, 0);
	output.set(Buffer.from(payload), header.length);
	return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

export function decodeWebAudioFrame(frame: Uint8Array): { sequence: number; timestampMs: number; payload: Uint8Array } {
	if (frame.length < 16) throw new Error("Malformed Web audio frame: missing protocol header");
	const view = Buffer.from(frame);
	const sequence = view.readUInt32LE(0);
	const timestampMs = view.readUInt32LE(4);
	const payload = view.subarray(16);
	return { sequence, timestampMs, payload: new Uint8Array(payload) };
}

export function defaultWebAudioSocketFactory(_context: WebSocketAudioBackendContext): WebSocketLike {
	throw new Error("WebSocketAudioOutputBackend requires a socketFactory or a connected WebSocket to be provided");
}

function assertNotAborted(...signals: Array<AbortSignal | undefined>): void {
	for (const signal of signals) {
		if (signal?.aborted) throw createAudioAbortError();
	}
}

class WebSocketAudioOutputHandle implements AudioOutputHandle<WebSocketAudioSessionResource> {
	private stateValue: AudioOutputState = "ready";
	private disposed = false;
	private readonly listeners = new Set<(event: AudioOutputEvent) => void>();
	private readonly cleanupFns = new Set<() => void>();
	private readonly signal?: AbortSignal;
	private readonly socketSignal?: AbortSignal;
	private socket: WebSocketLike | null = null;
	private queuedBytes = 0;
	private sequence = 0;
	private sendingPromise: Promise<void> | null = null;
	private readonly backend: WebSocketAudioOutputBackend;
	public readonly resource: WebSocketAudioSessionResource;
	public readonly format: AudioFrameFormat;
	public readonly ready: Promise<void>;
	public readonly input: AudioOutputInput;
	public readonly ownership: "transfer" | "borrow";

	public constructor(
		backend: WebSocketAudioOutputBackend,
		input: AudioOutputInput,
		resource: WebSocketAudioSessionResource,
		context: AudioOutputContext = {},
	) {
		this.backend = backend;
		this.input = input;
		this.resource = resource;
		this.format = input.format;
		this.ownership = input.ownership;
		this.signal = context.signal;
		this.socketSignal = context.signal;
		this.ready = Promise.resolve();
		if (this.signal) {
			const abort = () => {
				if (!this.disposed) void this.dispose();
			};
			this.signal.addEventListener("abort", abort, { once: true });
			this.cleanupFns.add(() => this.signal?.removeEventListener("abort", abort));
		}
	}

	public get state(): AudioOutputState {
		return this.stateValue;
	}

	public get bufferedBytes(): number | null {
		return this.queuedBytes;
	}

	public emit(event: AudioOutputEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	public async start(signal?: AbortSignal): Promise<void> {
		assertNotAborted(this.signal, signal);
		if (this.disposed) throw new Error("WebSocket audio session is disposed");
		if (this.format.kind !== "pcm") throw new TypeError("WebSocket audio output backend only supports PCM streams");
		this.stateValue = "buffering";
		this.emit({ type: "state", state: "buffering" });
		this.socket = await this.backend.resolveSocket(this, signal);
		if (!this.socket) throw new Error("WebSocket audio output requires a transport socket");
		this.socket.send(
			encodeWebAudioControlMessage({
				type: "audio:config",
				sessionId: this.resource.sessionId,
				protocolVersion: this.resource.protocolVersion,
				sampleRateHz: this.format.sampleRateHz,
				channels: this.format.channels,
				sampleFormat: this.format.sampleFormat,
				endianness: this.format.endianness,
				channelLayout: this.format.channelLayout,
			}),
		);
		this.stateValue = "playing";
		this.emit({ type: "state", state: "playing" });
		this.sendingPromise = this.consumeInput(signal);
		await this.sendingPromise;
	}

	public pause(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.stateValue !== "playing") return false;
		this.stateValue = "paused";
		this.emit({ type: "state", state: "paused" });
		this.socket?.send(
			encodeWebAudioControlMessage({
				type: "playback:pause",
				sessionId: this.resource.sessionId,
			}),
		);
		return true;
	}

	public resume(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.stateValue !== "paused") return false;
		this.stateValue = "playing";
		this.emit({ type: "state", state: "playing" });
		this.socket?.send(
			encodeWebAudioControlMessage({
				type: "playback:resume",
				sessionId: this.resource.sessionId,
			}),
		);
		return true;
	}

	public stop(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.disposed) return false;
		this.stateValue = "stopped";
		this.emit({ type: "state", state: "stopped" });
		this.socket?.send(
			encodeWebAudioControlMessage({
				type: "playback:stop",
				sessionId: this.resource.sessionId,
			}),
		);
		this.destroyTransferredInput();
		return true;
	}

	public seek(_positionMs: number, signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		throw new AudioOutputUnsupportedOperationError("seek");
	}

	public async replace(input: AudioOutputInput, signal?: AbortSignal): Promise<AudioOutputHandle<WebSocketAudioSessionResource>> {
		assertNotAborted(this.signal, signal);
		const replacement = this.backend.createSession(input, { signal, metadata: { sessionId: this.resource.sessionId } });
		await replacement.start(signal);
		await this.dispose();
		return replacement;
	}

	public setVolume(value: number, signal?: AbortSignal): void {
		assertNotAborted(this.signal, signal);
		if (this.backend.capabilities.volume !== "backend") {
			throw new AudioOutputUnsupportedOperationError("volume control");
		}
		this.socket?.send(
			encodeWebAudioControlMessage({
				type: "playback:state",
				sessionId: this.resource.sessionId,
				state: this.stateValue,
				volume: value,
			}),
		);
	}

	public onEvent(listener: (event: AudioOutputEvent) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const cleanup of [...this.cleanupFns]) cleanup();
		this.discoveryStop();
		this.destroyTransferredInput();
		if (this.socket && typeof this.socket.close === "function") {
			try {
				this.socket.close();
			} catch {
				// no-op: socket teardown is best-effort when the transport is already closing
			}
		}
		this.socket = null;
		this.resource.socket = null;
		this.listeners.clear();
	}

	public get disposedState(): boolean {
		return this.disposed;
	}

	private destroyTransferredInput(): void {
		if (this.input.ownership === "transfer" && !this.input.stream.destroyed) {
			this.input.stream.destroy();
		}
	}

	private discoveryStop(): void {
		if (this.stateValue !== "stopped" && this.stateValue !== "ended" && this.stateValue !== "failed") {
			this.stateValue = "stopped";
			this.emit({ type: "state", state: "stopped" });
		}
	}

	private async consumeInput(signal?: AbortSignal): Promise<void> {
		const frameBytes = this.calculateFrameBytes();
		this.resource.socket = this.socket;
		let remainder: Buffer = Buffer.alloc(0);
		try {
			for await (const chunk of this.input.stream) {
				assertNotAborted(this.signal, signal);
				const nextChunk: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
				const combined: Buffer = remainder.length > 0 ? Buffer.concat([remainder, nextChunk]) : nextChunk;
				const completeFrames = Math.floor(combined.length / frameBytes) * frameBytes;
				for (let offset = 0; offset < completeFrames; offset += frameBytes) {
					const framePayload: Buffer = combined.subarray(offset, offset + frameBytes);
					if (this.socket == null) return;
					if (this.backend.capabilities.maxBufferedBytes != null) {
						this.queuedBytes += framePayload.length;
						if (this.queuedBytes > this.backend.capabilities.maxBufferedBytes) {
							this.stateValue = "buffering";
							this.emit({ type: "state", state: "buffering" });
							throw new Error(`WebSocket audio output exceeded max buffered bytes: ${this.backend.capabilities.maxBufferedBytes}`);
						}
					}
					this.socket.send(encodeWebAudioFrame(framePayload, this.sequence++, Date.now()));
				}
				remainder = combined.subarray(completeFrames) as Buffer;
			}
			if (remainder.length !== 0) {
				throw new Error("WebSocket audio stream ended with an incomplete audio frame");
			}
			this.stateValue = "ended";
			this.emit({ type: "state", state: "ended" });
		} catch (error) {
			if (this.disposed) return;
			this.stateValue = "failed";
			this.emit({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
			this.destroyTransferredInput();
			throw error;
		} finally {
			this.resource.socket = null;
		}
	}

	private calculateFrameBytes(): number {
		if (this.format.kind !== "pcm") throw new TypeError("WebSocket backend requires PCM stream input");
		return this.format.channels * (this.format.sampleFormat === "s16" ? 2 : 4);
	}
}

export class WebSocketAudioOutputBackend implements AudioOutputBackend<WebSocketAudioSessionResource> {
	public readonly capabilities: AudioOutputCapabilities = {
		pause: true,
		resume: true,
		stop: true,
		seek: "unsupported",
		replacement: "atomic",
		ownership: "transfer",
		volume: "upstream",
		backpressure: "bounded",
		maxBufferedBytes: 256 * 1024,
	};
	public readonly ready: Promise<void>;
	private readonly protocolVersion: number;
	private readonly maxBufferedBytes: number;
	private readonly socketFactory: (context: WebSocketAudioBackendContext) => WebSocketLike | Promise<WebSocketLike>;
	private readonly authorize?: (context: WebSocketAudioBackendContext) => boolean | Promise<boolean>;
	private disposed = false;
	private readonly sessions = new Set<WebSocketAudioOutputHandle>();
	private readonly abortController = new AbortController();

	public constructor(options: WebSocketAudioOutputBackendOptions = {}) {
		this.protocolVersion = options.protocolVersion ?? WEB_AUDIO_PROTOCOL_VERSION;
		this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
		this.capabilities.maxBufferedBytes = this.maxBufferedBytes;
		this.socketFactory = options.socketFactory ?? defaultWebAudioSocketFactory;
		this.authorize = options.authorize;
		this.ready = Promise.resolve();
	}

	public async initialize(_signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error("WebSocket audio backend is disposed");
		this.abortController.signal.throwIfAborted?.();
	}

	public createSession(input: AudioOutputInput, context: AudioOutputContext = {}): AudioOutputHandle<WebSocketAudioSessionResource> {
		if (this.disposed) throw new Error("WebSocket audio backend is disposed");
		validateWebAudioOutputFormat(input.format);
		if (input.ownership !== "transfer" && input.ownership !== "borrow") {
			throw new TypeError(`Unsupported WebSocket audio ownership mode: ${String(input.ownership)}`);
		}
		const metadata = context.metadata as Record<string, unknown> | undefined;
		const sessionId = metadata && typeof metadata === "object" && "sessionId" in metadata ? String((metadata as any).sessionId) : undefined;
		const resource: WebSocketAudioSessionResource = {
			id: `web-audio-${Math.random().toString(16).slice(2)}`,
			sessionId: sessionId ?? `session-${Math.random().toString(16).slice(2)}`,
			socket: null,
			protocolVersion: this.protocolVersion,
		};
		const handle = new WebSocketAudioOutputHandle(this, input, resource, context);
		this.sessions.add(handle);
		return handle;
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();
		for (const session of [...this.sessions]) {
			await session.dispose();
		}
		this.sessions.clear();
	}

	public async resolveSocket(handle: WebSocketAudioOutputHandle, signal?: AbortSignal): Promise<WebSocketLike> {
		if (this.disposed) throw new Error("WebSocket audio backend is disposed");
		if (signal?.aborted) throw createAudioAbortError();
		const context: WebSocketAudioBackendContext = {
			playerId: undefined,
			sessionId: handle.resource.sessionId,
			metadata: { handle },
			signal,
		};
		const authorized = this.authorize ? await this.authorize(context) : true;
		if (!authorized) throw new Error("WebSocket audio session is not authorized");
		const socket = await this.socketFactory(context);
		if (!socket || typeof socket.send !== "function") {
			throw new TypeError("WebSocket audio output transport did not provide a valid WebSocket-like object");
		}
		return socket;
	}
}

export const WebAudioOutputBackend = WebSocketAudioOutputBackend;
export const WebSocketOutputBackend = WebSocketAudioOutputBackend;
export class WebAudioOutputHandle extends WebSocketAudioOutputHandle {}
export class WebSocketAudioOutputHandleImpl extends WebSocketAudioOutputHandle {}
