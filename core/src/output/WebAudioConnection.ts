import { EventEmitter } from "node:events";
import { VoiceConnectionStatus, type AudioPlayer, type PlayerSubscription } from "@discordjs/voice";
import { WEB_AUDIO_MAX_MESSAGE_BYTES, type WebSocketLike } from "./WebSocketAudioOutputBackend";
import { getOpusPacketDurationMs } from "../audio/OpusSourceAdapter";
import type {
	AudioOutputBackend,
	AudioOutputCapabilities,
	AudioOutputContext,
	AudioOutputEvent,
	AudioOutputHandle,
	AudioOutputInput,
	AudioOutputState,
} from "./AudioOutputBackend";
import { AudioOutputUnsupportedOperationError } from "./AudioOutputBackend";

export const WEB_AUDIO_MAGIC_0 = 0x5a;
export const WEB_AUDIO_MAGIC_1 = 0x49;
export const WEB_AUDIO_PROTOCOL_VERSION_V1 = 1;
export const WEB_AUDIO_FLAG_CODEC_PCM = 0x00;
export const WEB_AUDIO_FLAG_CODEC_OPUS = 0x01;
export const WEB_AUDIO_FRAME_HEADER_BYTES = 16;
export const WEB_AUDIO_OPUS_CODEC_ID = 0;
export const WEB_AUDIO_OPUS_SAMPLE_RATE_HZ = 48_000;
export const WEB_AUDIO_OPUS_CHANNELS = 2;
export const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
export const DEFAULT_MAX_QUEUED_PACKETS = 50; // 50 * 20ms = 1s of audio

export interface WebAudioConnectionStats {
	dispatchedPackets: number;
	dispatchedBytes: number;
	droppedPackets: number;
	droppedBytes: number;
	sequence: number;
	activeSockets: number;
	speaking: boolean;
	status: VoiceConnectionStatus;
}

export interface WebAudioConnectionOptions {
	sessionId?: string;
	maxBufferedBytes?: number;
	maxQueuedPackets?: number;
	dropPolicy?: "drop-newest" | "drop-oldest" | "disconnect";
	onDrop?: (stats: { socket: WebSocketLike; droppedPackets: number; droppedBytes: number; reason: string }) => void;
	debug?: (message: string) => void;
}

export interface WebAudioConnectionState {
	status: VoiceConnectionStatus;
	subscription?: PlayerSubscription;
}

/**
 * Encodes a raw Opus packet into the 16-byte protocol binary frame format v1:
 * - Bytes 0..1: Magic 0x5A 0x49 ('ZI')
 * - Byte 2: Protocol version (0x01)
 * - Byte 3: Flags (bit 0 = 1 for Opus, 0 for PCM; bits 1..7 = 0)
 * - Bytes 4..7: Sequence (UInt32BE)
 * - Bytes 8..15: Media timestamp in microseconds (BigUInt64BE)
 * - Bytes 16..N: Raw Opus packet payload
 */
export function encodeWebAudioOpusFrame(packet: Uint8Array | Buffer, sequence: number, timestampUs: number | bigint = 0): Buffer {
	if (packet.length > WEB_AUDIO_MAX_MESSAGE_BYTES) {
		throw new Error(`Opus packet payload exceeds maximum limit of ${WEB_AUDIO_MAX_MESSAGE_BYTES} bytes`);
	}
	const header = Buffer.allocUnsafe(WEB_AUDIO_FRAME_HEADER_BYTES);
	header[0] = WEB_AUDIO_MAGIC_0;
	header[1] = WEB_AUDIO_MAGIC_1;
	header[2] = WEB_AUDIO_PROTOCOL_VERSION_V1;
	header[3] = WEB_AUDIO_FLAG_CODEC_OPUS;
	header.writeUInt32BE(sequence >>> 0, 4);
	const us = typeof timestampUs === "bigint" ? timestampUs : BigInt(Math.round(Number(timestampUs)));
	header.writeBigUInt64BE(us, 8);

	return Buffer.concat([header, Buffer.isBuffer(packet) ? packet : Buffer.from(packet)]);
}

/**
 * Decodes a 16-byte protocol binary frame into its header fields and raw payload.
 * Supports Wire Format v1 (Magic 'ZI') and legacy format fallback.
 */
export function decodeWebAudioOpusFrame(frame: Uint8Array | Buffer): {
	version: number;
	codec: "opus" | "pcm16le";
	sequence: number;
	timestampMs: number;
	timestampUs: bigint;
	sampleRateHz: number;
	channels: number;
	payload: Buffer;
} {
	if (frame.length < WEB_AUDIO_FRAME_HEADER_BYTES) {
		throw new Error("Malformed Web audio frame: missing 16-byte protocol header");
	}
	const view = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
	if (view[0] === WEB_AUDIO_MAGIC_0 && view[1] === WEB_AUDIO_MAGIC_1) {
		const version = view[2];
		const flags = view[3];
		const codec = (flags & 0x01) === 1 ? "opus" : "pcm16le";
		const sequence = view.readUInt32BE(4);
		const timestampUs = view.readBigUInt64BE(8);
		const timestampMs = Number(timestampUs / 1000n);
		const payload = view.subarray(WEB_AUDIO_FRAME_HEADER_BYTES);
		return {
			version,
			codec,
			sequence,
			timestampMs,
			timestampUs,
			sampleRateHz: WEB_AUDIO_OPUS_SAMPLE_RATE_HZ,
			channels: WEB_AUDIO_OPUS_CHANNELS,
			payload,
		};
	} else {
		// Legacy format fallback
		const sequence = view.readUInt32LE(0);
		const timestampMs = view.readUInt32LE(4);
		const timestampUs = BigInt(timestampMs) * 1000n;
		const sampleRateHz = view.readUInt16LE(8);
		const channels = view.readUInt16LE(10);
		const codecId = view.readUInt16LE(12);
		const codec = codecId === 0 ? "opus" : "pcm16le";
		const payload = view.subarray(WEB_AUDIO_FRAME_HEADER_BYTES);
		return { version: 0, codec, sequence, timestampMs, timestampUs, sampleRateHz, channels, payload };
	}
}

/**
 * Adapter that satisfies the runtime duck-typing contract of `@discordjs/voice` VoiceConnection:
 * - `state.status === "ready"` so `AudioPlayer.playable` recognizes it as an active receiver.
 * - `prepareAudioPacket(packet)` called by `AudioPlayer._stepPrepare()` roughly every 20ms.
 * - `dispatchAudio()` called by `AudioPlayer._stepDispatch()` roughly every 20ms.
 * - `setSpeaking(enabled)` called when playback state changes.
 * - `onSubscriptionRemoved(subscription)` called when unsubscribing.
 *
 * Distributes raw Opus packets non-blockingly to attached WebSocket sockets / browser listeners
 * without creating any FFmpeg child processes or extra source readers.
 */
export class WebAudioConnection extends EventEmitter {
	public state: WebAudioConnectionState = {
		status: VoiceConnectionStatus.Ready,
		subscription: undefined,
	};

	public readonly isWebAudioConnection = true;
	public readonly sessionId: string;
	private readonly maxBufferedBytes: number;
	private readonly maxQueuedPackets: number;
	private readonly dropPolicy: "drop-newest" | "drop-oldest" | "disconnect";
	private readonly onDropCallback?: (stats: {
		socket: WebSocketLike;
		droppedPackets: number;
		droppedBytes: number;
		reason: string;
	}) => void;
	private readonly debugLogger?: (message: string) => void;

	private readonly sockets = new Set<WebSocketLike>();
	private readonly socketCleanups = new Map<WebSocketLike, () => void>();

	private pendingPacket: Buffer | null = null;
	private sequence = 0;
	private mediaTimestampUs = 0n;
	private startTime = 0;
	private speaking = false;
	private destroyed = false;

	// Metrics
	private dispatchedPackets = 0;
	private dispatchedBytes = 0;
	private droppedPackets = 0;
	private droppedBytes = 0;

	public constructor(options: WebAudioConnectionOptions = {}) {
		super();
		this.sessionId = options.sessionId ?? `web-conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
		this.maxQueuedPackets = options.maxQueuedPackets ?? DEFAULT_MAX_QUEUED_PACKETS;
		this.dropPolicy = options.dropPolicy ?? "drop-newest";
		this.onDropCallback = options.onDrop;
		this.debugLogger = options.debug;
	}

	public get isReady(): boolean {
		return this.state.status === VoiceConnectionStatus.Ready;
	}

	public get isSpeaking(): boolean {
		return this.speaking;
	}

	public isAvailableForPacing(): boolean {
		return this.state.status === VoiceConnectionStatus.Ready && this.sockets.size > 0;
	}

	/**
	 * Attach a WebSocket client or publisher socket.
	 * When attached, Opus frames dispatched by the AudioPlayer are relayed non-blockingly.
	 */
	public attachSocket(socket: WebSocketLike): void {
		if (this.destroyed) {
			socket.close?.(1001, "Connection destroyed");
			return;
		}
		if (this.sockets.has(socket)) return;
		this.sockets.add(socket);

		const onClose = () => this.detachSocket(socket);
		const onError = (error: any) => {
			this.debugLogger?.(`[WebAudioConnection] Socket error (${this.sessionId}): ${error?.message ?? error}`);
			this.emit("socketError", { socket, error });
			this.detachSocket(socket);
		};

		socket.addEventListener?.("close", onClose);
		socket.addEventListener?.("error", onError);

		this.socketCleanups.set(socket, () => {
			socket.removeEventListener?.("close", onClose);
			socket.removeEventListener?.("error", onError);
		});

		// Send initial audio:config if the socket is already OPEN (readyState === 1)
		this.sendConfigToSocket(socket);
		this.emit("socketAttach", socket);
	}

	/**
	 * Detach a WebSocket client or publisher socket.
	 */
	public detachSocket(socket: WebSocketLike): void {
		if (!this.sockets.has(socket)) return;
		this.sockets.delete(socket);
		const cleanup = this.socketCleanups.get(socket);
		if (cleanup) {
			cleanup();
			this.socketCleanups.delete(socket);
		}
		this.emit("socketDetach", socket);
	}

	/**
	 * Subscribes this connection to an AudioPlayer or Player facade.
	 * Returns the resulting PlayerSubscription.
	 */
	public subscribe(
		player: AudioPlayer | { audioPlayer?: AudioPlayer | null; subscribe?: (conn: any) => any } | any,
	): PlayerSubscription | undefined {
		if (this.state.status === VoiceConnectionStatus.Destroyed) {
			return undefined;
		}
		const targetPlayer: AudioPlayer =
			"audioPlayer" in player && player.audioPlayer ? (player.audioPlayer as AudioPlayer) : (player as AudioPlayer);

		// If this connection is already subscribed to this player, return existing
		if (this.state.subscription && this.state.subscription.player === targetPlayer) {
			return this.state.subscription;
		}

		// Clean up any previous subscription
		this.unsubscribe();

		// Subscribe to AudioPlayer using its internal subscribe method
		const subscribeMethod = (targetPlayer as any)["subscribe"];
		if (typeof subscribeMethod !== "function") {
			throw new TypeError("Provided player does not implement subscribe(connection)");
		}

		const subscription: PlayerSubscription = subscribeMethod.call(targetPlayer, this);
		this.state.subscription = subscription;
		this.state.status = VoiceConnectionStatus.Ready;
		this.startTime = Date.now();
		this.reset();
		this.emit("stateChange", this.state.status);
		return subscription;
	}

	/**
	 * Resets sequence and media timestamp counters to 0 (e.g. for a new track or session generation).
	 */
	public reset(): void {
		this.sequence = 0;
		this.mediaTimestampUs = 0n;
		this.pendingPacket = null;
	}

	/**
	 * Unsubscribes from the active AudioPlayer subscription.
	 */
	public unsubscribe(): boolean {
		const sub = this.state.subscription;
		if (!sub) return false;
		this.state.subscription = undefined;
		try {
			sub.unsubscribe();
		} catch {
			// ignore
		}
		this.setSpeaking(false);
		return true;
	}

	/**
	 * Called by PlayerSubscription#unsubscribe() when removing this connection from an AudioPlayer.
	 */
	public onSubscriptionRemoved(subscription: PlayerSubscription): void {
		if (this.state.subscription === subscription) {
			this.state.subscription = undefined;
			this.setSpeaking(false);
		}
	}

	/**
	 * Called by AudioPlayer._stepPrepare() roughly every 20ms with the raw Opus packet Buffer.
	 */
	public prepareAudioPacket(packet: Buffer): void {
		if (this.state.status !== VoiceConnectionStatus.Ready) return;
		this.pendingPacket = packet;
	}

	/**
	 * Called by AudioPlayer._stepDispatch() roughly every 20ms to dispatch the prepared packet.
	 * Completely non-blocking: never awaits or blocks AudioPlayer's 20ms scheduler cycle.
	 */
	public dispatchAudio(): void {
		if (this.state.status !== VoiceConnectionStatus.Ready) {
			this.pendingPacket = null;
			return;
		}
		const packet = this.pendingPacket;
		if (!packet) return;
		this.pendingPacket = null;

		const seq = this.sequence;
		this.sequence = (this.sequence + 1) >>> 0;
		const timestampUs = this.mediaTimestampUs;

		// Determine duration from packet TOC or default 20ms
		const durationMs = getOpusPacketDurationMs(packet) || 20;
		const durationUs = BigInt(Math.round(durationMs * 1000));
		this.mediaTimestampUs += durationUs;

		let encodedFrame: Buffer | null = null;

		// Dispatch to all attached sockets
		for (const socket of [...this.sockets]) {
			if (socket.readyState !== 1 /* OPEN */) {
				continue;
			}

			// Backpressure check
			const buffered = socket.bufferedAmount ?? 0;
			if (buffered + packet.length + WEB_AUDIO_FRAME_HEADER_BYTES > this.maxBufferedBytes) {
				this.droppedPackets++;
				this.droppedBytes += packet.length;
				this.debugLogger?.(
					`[WebAudioConnection] Dropped packet ${seq} on socket (buffered: ${buffered} bytes, max: ${this.maxBufferedBytes})`,
				);
				this.onDropCallback?.({
					socket,
					droppedPackets: this.droppedPackets,
					droppedBytes: this.droppedBytes,
					reason: "maxBufferedBytes exceeded",
				});
				this.emit("drop", { socket, sequence: seq, bytes: packet.length });

				if (this.dropPolicy === "disconnect") {
					try {
						socket.close(1013, "Listener is too slow");
					} catch {}
					this.detachSocket(socket);
				}
				continue;
			}

			if (!encodedFrame) {
				encodedFrame = encodeWebAudioOpusFrame(packet, seq, timestampUs);
			}

			try {
				socket.send(encodedFrame);
				this.dispatchedPackets++;
				this.dispatchedBytes += packet.length;
			} catch (err: any) {
				this.debugLogger?.(`[WebAudioConnection] Error sending frame to socket: ${err?.message}`);
				this.detachSocket(socket);
			}
		}

		this.emit("packet", {
			sequence: seq,
			size: packet.length,
			timestampMs: Number(timestampUs / 1000n),
			timestampUs,
		});
	}

	/**
	 * Updates speaking status. Called by AudioPlayer when speaking starts or stops.
	 */
	public setSpeaking(enabled: boolean): boolean {
		if (this.speaking === enabled) return true;
		this.speaking = enabled;
		this.emit("speaking", enabled);
		return true;
	}

	/**
	 * Disconnects the connection without destroying it (can reconnect/re-subscribe later).
	 */
	public disconnect(): boolean {
		if (this.state.status === VoiceConnectionStatus.Destroyed) return false;
		this.state.status = VoiceConnectionStatus.Disconnected;
		this.setSpeaking(false);
		this.emit("stateChange", this.state.status);
		return true;
	}

	/**
	 * Permanently destroys the connection, unsubscribes and cleans up all sockets.
	 */
	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.unsubscribe();
		this.state.status = VoiceConnectionStatus.Destroyed;

		for (const socket of [...this.sockets]) {
			try {
				socket.close?.(1000, "Connection destroyed");
			} catch {}
			this.detachSocket(socket);
		}
		this.sockets.clear();
		this.socketCleanups.clear();
		this.pendingPacket = null;
		this.removeAllListeners();
	}

	public getStats(): WebAudioConnectionStats {
		return {
			dispatchedPackets: this.dispatchedPackets,
			dispatchedBytes: this.dispatchedBytes,
			droppedPackets: this.droppedPackets,
			droppedBytes: this.droppedBytes,
			sequence: this.sequence,
			activeSockets: this.sockets.size,
			speaking: this.speaking,
			status: this.state.status,
		};
	}

	private sendConfigToSocket(socket: WebSocketLike): void {
		if (socket.readyState !== 1 /* OPEN */) return;
		const configMsg = JSON.stringify({
			v: 1,
			type: "audio:config",
			sessionId: this.sessionId,
			protocolVersion: 1,
			codec: "opus",
			sampleRateHz: WEB_AUDIO_OPUS_SAMPLE_RATE_HZ,
			channels: WEB_AUDIO_OPUS_CHANNELS,
		});
		try {
			socket.send(configMsg);
		} catch {}
	}
}

/**
 * Adapts a WebAudioConnection into an AudioOutputBackend so it can be managed
 * via MultiAudioOutputBackend, Player.connect(connection), and standard output APIs.
 */
export class WebAudioConnectionBackend implements AudioOutputBackend<WebAudioConnection> {
	public readonly capabilities: AudioOutputCapabilities = {
		pause: true,
		resume: true,
		stop: true,
		seek: "unsupported",
		replacement: "atomic",
		ownership: "both",
		volume: "backend",
		backpressure: "bounded",
		maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
		acceptedProcessOutputs: ["encoded", "pcm16le"],
		preferredProcessOutput: "encoded",
	};
	public readonly ready = Promise.resolve();

	public constructor(public readonly connection: WebAudioConnection) {}

	public isAvailableForPacing(): boolean {
		return this.connection.isAvailableForPacing();
	}

	public async initialize(_signal?: AbortSignal): Promise<void> {
		return;
	}

	public createSession(input: AudioOutputInput, _context: AudioOutputContext = {}): AudioOutputHandle<WebAudioConnection> {
		const conn = this.connection;
		let disposed = false;
		const listeners = new Set<(event: AudioOutputEvent) => void>();

		const emit = (event: AudioOutputEvent) => {
			for (const l of listeners) l(event);
		};

		if (!conn.state.subscription && input.stream && !input.stream.destroyed) {
			input.stream.on("data", (chunk: any) => {
				if (disposed) return;
				const packet = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				conn.prepareAudioPacket(packet);
				conn.dispatchAudio();
			});
			input.stream.once("end", () => {
				emit({ type: "state", state: "ended" });
			});
			input.stream.once("error", (err: any) => {
				emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
			});
		}

		return {
			resource: conn,
			format: input.format,
			ready: Promise.resolve(),
			get state(): AudioOutputState {
				if (disposed) return "stopped";
				return conn.isReady ? "playing" : "ready";
			},
			get bufferedBytes(): number | null {
				return 0;
			},
			start: () => {
				emit({ type: "state", state: "playing" });
			},
			pause: () => {
				conn.setSpeaking(false);
				emit({ type: "state", state: "paused" });
				return true;
			},
			resume: () => {
				conn.setSpeaking(true);
				emit({ type: "state", state: "playing" });
				return true;
			},
			stop: () => {
				conn.disconnect();
				emit({ type: "state", state: "stopped" });
				return true;
			},
			seek: () => false,
			replace: () => {
				throw new AudioOutputUnsupportedOperationError("replace");
			},
			setVolume: () => {},
			onEvent: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				listeners.clear();
				if (input.ownership === "transfer" && !input.stream.destroyed) {
					input.stream.destroy();
				}
			},
		};
	}

	public dispose(): void {
		this.connection.destroy();
	}
}
