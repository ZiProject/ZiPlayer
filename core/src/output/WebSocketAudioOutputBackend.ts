import { performance } from "node:perf_hooks";
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
	bufferedAmount: number;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: (event: any) => void): void;
	removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WebSocketAudioControlMessage =
	| { v: number; type: "ready"; sessionId: string; protocolVersion: number }
	| {
			v: number;
			type: "audio:config";
			sessionId: string;
			protocolVersion: number;
			sampleRateHz: number;
			channels: number;
			sampleFormat: "s16";
			endianness: "little";
			channelLayout: "interleaved";
	  }
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
	sessionId?: string;
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

export interface WebSocketAudioOutputHandleContract extends AudioOutputHandle<WebSocketAudioSessionResource> {
	readonly completion: Promise<void>;
}

export function webAudioFormatFromPcm(options: {
	sampleRateHz?: number;
	channels?: number;
	sampleFormat?: "s16";
}): AudioFrameFormat {
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

class WebSocketAudioOutputHandle implements WebSocketAudioOutputHandleContract {
	private stateValue: AudioOutputState = "ready";
	private disposed = false;
	private readonly listeners = new Set<(event: AudioOutputEvent) => void>();
	private readonly cleanupFns = new Set<() => void>();
	private readonly signal?: AbortSignal;
	private socket: WebSocketLike | null = null;
	private sequence = 0;
	private sendingPromise: Promise<void> | null = null;
	public completion: Promise<void> = Promise.resolve();
	private started = false;
	private stopped = false;
	private transportClosed = false;
	private playbackDeadline: number | null = null;
	private pendingReadCancel: (() => void) | null = null;
	private pendingReadRetry: (() => void) | null = null;
	private readonly activityWaiters = new Set<(active: boolean) => void>();
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
		return this.socket?.bufferedAmount ?? 0;
	}

	public emit(event: AudioOutputEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	public async start(signal?: AbortSignal): Promise<void> {
		assertNotAborted(this.signal, signal);
		if (this.disposed || this.stopped) throw new Error("WebSocket audio session is stopped or disposed");
		if (this.started) throw new Error("WebSocket audio session has already started");
		if (this.format.kind !== "pcm") throw new TypeError("WebSocket audio output backend only supports PCM streams");
		this.started = true;
		this.stateValue = "buffering";
		this.emit({ type: "state", state: "buffering" });
		try {
			const socket = await this.backend.resolveSocket(this, signal);
			if (this.disposed || this.stopped || this.signal?.aborted || signal?.aborted) {
				socket.close();
				assertNotAborted(this.signal, signal);
				throw new Error("WebSocket audio session was stopped while connecting");
			}
			this.socket = socket;
			this.listenForTransportClose();
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
		} catch (error) {
			if (!this.disposed && !this.stopped) {
				this.stateValue = "failed";
				this.emit({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
				await this.dispose();
			}
			throw error;
		}
		this.stateValue = "playing";
		this.emit({ type: "state", state: "playing" });
		this.sendingPromise = this.consumeInput(signal);
		this.completion = this.sendingPromise;
		void this.completion.catch(() => undefined);
	}

	public pause(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.stateValue !== "playing") return false;
		if (!this.sendControlMessage("playback:pause")) return false;
		this.stateValue = "paused";
		this.emit({ type: "state", state: "paused" });
		return true;
	}

	public resume(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.stateValue !== "paused") return false;
		if (!this.sendControlMessage("playback:resume")) return false;
		this.stateValue = "playing";
		this.emit({ type: "state", state: "playing" });
		this.playbackDeadline = null;
		this.wakeActivityWaiters(true);
		this.pendingReadRetry?.();
		return true;
	}

	public stop(signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		if (this.disposed) return false;
		this.stopped = true;
		this.stateValue = "stopped";
		this.emit({ type: "state", state: "stopped" });
		this.pendingReadCancel?.();
		this.wakeActivityWaiters(false);
		this.destroyTransferredInput();
		return this.sendControlMessage("playback:stop");
	}

	public seek(_positionMs: number, signal?: AbortSignal): boolean {
		assertNotAborted(this.signal, signal);
		throw new AudioOutputUnsupportedOperationError("seek");
	}

	public async replace(input: AudioOutputInput, signal?: AbortSignal): Promise<WebSocketAudioOutputHandleContract> {
		assertNotAborted(this.signal, signal);
		this.stop(signal);
		await this.dispose();
		const replacement = this.backend.createSession(input, { signal, metadata: { sessionId: this.resource.sessionId } });
		await replacement.start(signal);
		return replacement;
	}

	public setVolume(value: number, signal?: AbortSignal): void {
		assertNotAborted(this.signal, signal);
		throw new AudioOutputUnsupportedOperationError("volume control; apply volume upstream");
	}

	public onEvent(listener: (event: AudioOutputEvent) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped = true;
		for (const cleanup of [...this.cleanupFns]) cleanup();
		this.discoveryStop();
		this.pendingReadCancel?.();
		this.wakeActivityWaiters(false);
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
		this.backend.unregisterSession(this);
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
			while (true) {
				assertNotAborted(this.signal, signal);
				if (!(await this.waitUntilActive())) return;
				const chunk = await this.readNextChunk();
				if (chunk === null) break;
				if (!(await this.waitUntilActive())) return;
				const nextChunk: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const combined: Buffer = remainder.length > 0 ? Buffer.concat([remainder, nextChunk]) : nextChunk;
				const completeFrames = Math.floor(combined.length / frameBytes) * frameBytes;
				for (let offset = 0; offset < completeFrames; offset += frameBytes) {
					const framePayload: Buffer = combined.subarray(offset, offset + frameBytes);
					if (!(await this.sendFrame(framePayload, signal))) return;
				}
				remainder = combined.subarray(completeFrames) as Buffer;
			}
			if (remainder.length !== 0) {
				const sampleBytes = this.calculateSampleFrameBytes();
				if (remainder.length % sampleBytes !== 0) {
					throw new Error("WebSocket audio stream ended with an incomplete PCM sample frame");
				}
				if (!(await this.sendFrame(remainder, signal))) return;
			}
			if (this.stopped || this.disposed || this.transportClosed) return;
			this.stateValue = "ended";
			this.emit({ type: "state", state: "ended" });
		} catch (error) {
			if (this.disposed || this.stopped || this.transportClosed) return;
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
		const sampleFrameBytes = this.calculateSampleFrameBytes();
		const maxPayloadBytes = Math.min(
			WEB_AUDIO_MAX_MESSAGE_BYTES,
			(this.backend.capabilities.maxBufferedBytes ?? WEB_AUDIO_MAX_MESSAGE_BYTES + 16) - 16,
		);
		const maxSamples = Math.floor(maxPayloadBytes / sampleFrameBytes);
		if (maxSamples < 1) throw new TypeError("WebSocket audio buffer limit is too small for one PCM sample frame");
		const samplesPerFrame = this.format.frameSamplesPerChannel ?? Math.min(960, maxSamples);
		if (!Number.isInteger(samplesPerFrame) || samplesPerFrame < 1 || samplesPerFrame > maxSamples) {
			throw new TypeError(`PCM frame size must be between 1 and ${maxSamples} samples per channel`);
		}
		return sampleFrameBytes * samplesPerFrame;
	}

	private calculateSampleFrameBytes(): number {
		if (this.format.kind !== "pcm" || this.format.sampleFormat !== "s16") {
			throw new TypeError("WebSocket backend requires interleaved s16 PCM input");
		}
		return this.format.channels * WEB_AUDIO_SAMPLE_BYTES;
	}

	private async sendFrame(payload: Uint8Array, signal?: AbortSignal): Promise<boolean> {
		const socket = this.socket;
		if (!socket || this.stopped || this.disposed || this.transportClosed) return false;
		const messageBytes = payload.byteLength + 16;
		const maxBufferedBytes = this.backend.capabilities.maxBufferedBytes;
		if (maxBufferedBytes !== null && messageBytes > maxBufferedBytes) {
			throw new Error(`Audio frame exceeds max buffered bytes: ${maxBufferedBytes}`);
		}
		while (true) {
			assertNotAborted(this.signal, signal);
			if (!(await this.waitUntilActive())) return false;
			if (socket.readyState !== 1) {
				this.transportClosed = true;
				return false;
			}
			if (maxBufferedBytes !== null && socket.bufferedAmount + messageBytes > maxBufferedBytes) {
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
				continue;
			}
			const now = performance.now();
			const deadline = this.playbackDeadline ?? now;
			this.playbackDeadline = deadline;
			if (deadline > now) {
				await new Promise<void>((resolve) => setTimeout(resolve, deadline - now));
				continue;
			}
			break;
		}
		assertNotAborted(this.signal, signal);
		if (this.stopped || this.disposed || this.transportClosed) return false;
		if (socket.readyState !== 1) {
			this.transportClosed = true;
			return false;
		}
		const format = this.format;
		if (format.kind !== "pcm") throw new TypeError("WebSocket backend requires PCM stream input");
		const frameDurationMs = (payload.byteLength / (format.sampleRateHz * this.calculateSampleFrameBytes())) * 1000;
		socket.send(encodeWebAudioFrame(payload, this.sequence++, Date.now()));
		this.playbackDeadline = (this.playbackDeadline ?? performance.now()) + frameDurationMs;
		return true;
	}

	private sendControlMessage(type: "playback:pause" | "playback:resume" | "playback:stop"): boolean {
		const socket = this.socket;
		if (!socket || socket.readyState !== 1 || this.transportClosed) {
			this.failTransport(new Error(`Cannot send ${type}: WebSocket audio transport is not open`));
			return false;
		}
		try {
			socket.send(
				encodeWebAudioControlMessage({
					type,
					sessionId: this.resource.sessionId,
				}),
			);
			return true;
		} catch (error) {
			this.failTransport(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}

	private failTransport(error: Error): void {
		if (this.transportClosed || this.disposed) return;
		this.transportClosed = true;
		this.stateValue = "failed";
		this.emit({ type: "error", error });
		this.pendingReadCancel?.();
		this.wakeActivityWaiters(false);
		this.destroyTransferredInput();
		try {
			this.socket?.close();
		} catch {
			// The transport is already unusable; local cleanup must still complete.
		}
	}

	private waitUntilActive(): Promise<boolean> {
		if (this.stopped || this.disposed || this.transportClosed) return Promise.resolve(false);
		if (this.stateValue !== "paused") return Promise.resolve(true);
		return new Promise((resolve) => this.activityWaiters.add(resolve));
	}

	private wakeActivityWaiters(active: boolean): void {
		for (const resolve of this.activityWaiters) resolve(active);
		this.activityWaiters.clear();
	}

	private readNextChunk(): Promise<Buffer | null> {
		const stream = this.input.stream;
		const read = (): Buffer | null | undefined => {
			const chunk = stream.read() as Buffer | Uint8Array | string | null;
			if (chunk !== null) return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (stream.readableEnded || stream.destroyed || this.stopped || this.disposed) return null;
			return undefined;
		};
		const initial = read();
		if (initial !== undefined) return Promise.resolve(initial);
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				stream.removeListener("readable", onReadable);
				stream.removeListener("end", onEnd);
				stream.removeListener("close", onClose);
				stream.removeListener("error", onError);
				this.pendingReadCancel = null;
				this.pendingReadRetry = null;
			};
			const finish = (chunk: Buffer | null) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(chunk);
			};
			const onReadable = () => {
				if (this.stateValue === "paused") return;
				const chunk = read();
				if (chunk !== undefined) finish(chunk);
			};
			const onEnd = () => finish(null);
			const onClose = () => finish(null);
			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			this.pendingReadCancel = () => finish(null);
			this.pendingReadRetry = onReadable;
			stream.on("readable", onReadable);
			stream.once("end", onEnd);
			stream.once("close", onClose);
			stream.once("error", onError);
			onReadable();
		});
	}

	private listenForTransportClose(): void {
		if (!this.socket?.addEventListener) return;
		const socket = this.socket;
		const onClose = () => {
			if (!this.stopped && !this.disposed) this.failTransport(new Error("WebSocket audio transport closed"));
		};
		socket.addEventListener?.("close", onClose);
		this.cleanupFns.add(() => socket.removeEventListener?.("close", onClose));
	}
}

export class WebSocketAudioOutputBackend implements AudioOutputBackend<WebSocketAudioSessionResource> {
	public readonly capabilities: AudioOutputCapabilities = {
		pause: true,
		resume: true,
		stop: true,
		seek: "unsupported",
		replacement: "stop-before-start",
		ownership: "both",
		volume: "unsupported",
		backpressure: "bounded",
		maxBufferedBytes: 256 * 1024,
	};
	public readonly ready: Promise<void>;
	private readonly protocolVersion: number;
	private readonly maxBufferedBytes: number;
	private readonly sessionId?: string;
	private readonly socketFactory: (context: WebSocketAudioBackendContext) => WebSocketLike | Promise<WebSocketLike>;
	private readonly authorize?: (context: WebSocketAudioBackendContext) => boolean | Promise<boolean>;
	private disposed = false;
	private readonly sessions = new Set<WebSocketAudioOutputHandle>();
	private readonly abortController = new AbortController();

	public constructor(options: WebSocketAudioOutputBackendOptions = {}) {
		this.protocolVersion = options.protocolVersion ?? WEB_AUDIO_PROTOCOL_VERSION;
		this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
		if (
			options.sessionId !== undefined &&
			(typeof options.sessionId !== "string" || !options.sessionId || options.sessionId.length > 128)
		) {
			throw new TypeError("sessionId must be a non-empty string of at most 128 characters");
		}
		this.sessionId = options.sessionId;
		this.capabilities.maxBufferedBytes = this.maxBufferedBytes;
		this.socketFactory = options.socketFactory ?? defaultWebAudioSocketFactory;
		this.authorize = options.authorize;
		this.ready = Promise.resolve();
		if (!Number.isInteger(this.maxBufferedBytes) || this.maxBufferedBytes <= 16) {
			throw new TypeError("maxBufferedBytes must be an integer greater than the 16-byte audio header");
		}
	}

	public async initialize(_signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error("WebSocket audio backend is disposed");
		this.abortController.signal.throwIfAborted?.();
	}

	public createSession(input: AudioOutputInput, context: AudioOutputContext = {}): WebSocketAudioOutputHandleContract {
		if (this.disposed) throw new Error("WebSocket audio backend is disposed");
		validateWebAudioOutputFormat(input.format);
		if (input.ownership !== "transfer" && input.ownership !== "borrow") {
			throw new TypeError(`Unsupported WebSocket audio ownership mode: ${String(input.ownership)}`);
		}
		const metadata = context.metadata as Record<string, unknown> | undefined;
		const sessionId =
			metadata && typeof metadata === "object" && "sessionId" in metadata ? String((metadata as any).sessionId) : undefined;
		const resource: WebSocketAudioSessionResource = {
			id: `web-audio-${Math.random().toString(16).slice(2)}`,
			sessionId: sessionId ?? this.sessionId ?? `session-${Math.random().toString(16).slice(2)}`,
			socket: null,
			protocolVersion: this.protocolVersion,
		};
		const handle = new WebSocketAudioOutputHandle(this, input, resource, context);
		this.sessions.add(handle);
		return handle;
	}

	public unregisterSession(handle: WebSocketAudioOutputHandle): void {
		this.sessions.delete(handle);
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
		if (
			!socket ||
			typeof socket.send !== "function" ||
			typeof socket.close !== "function" ||
			typeof socket.bufferedAmount !== "number" ||
			!Number.isFinite(socket.bufferedAmount) ||
			socket.bufferedAmount < 0
		) {
			throw new TypeError("WebSocket audio output transport did not provide a valid WebSocket-like object");
		}
		return socket;
	}
}

export const WebAudioOutputBackend = WebSocketAudioOutputBackend;
export const WebSocketOutputBackend = WebSocketAudioOutputBackend;
export class WebAudioOutputHandle extends WebSocketAudioOutputHandle {}
export class WebSocketAudioOutputHandleImpl extends WebSocketAudioOutputHandle {}
