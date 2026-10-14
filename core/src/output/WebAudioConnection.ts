import { EventEmitter } from "node:events";
import { VoiceConnectionStatus, type AudioPlayer, type PlayerSubscription } from "@discordjs/voice";
import { getOpusPacketDurationMs, validateOpusPacketDuration, validateOpusPacketFraming } from "../audio/OpusSourceAdapter";

export const WEB_AUDIO_MAGIC_0 = 0x5a;
export const WEB_AUDIO_MAGIC_1 = 0x49;
export const WEB_AUDIO_PROTOCOL_VERSION_V1 = 1;
export const WEB_AUDIO_FLAG_CODEC_OPUS = 0x01;
export const WEB_AUDIO_FRAME_HEADER_BYTES = 16;
export const WEB_AUDIO_MAX_MESSAGE_BYTES = 1024 * 1024;
export const WEB_AUDIO_OPUS_CODEC_ID = 0;
export const WEB_AUDIO_OPUS_SAMPLE_RATE_HZ = 48_000;
export const WEB_AUDIO_OPUS_CHANNELS = 2;
export const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
export const DEFAULT_MAX_QUEUED_PACKETS = 50; // 50 * 20ms = 1s of audio

export interface WebSocketLike {
	readyState: number;
	bufferedAmount: number;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: (event: any) => void): void;
	removeEventListener?(type: string, listener: (event: any) => void): void;
}

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
 * - Byte 3: Flags (0x01 for Opus)
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
export function decodeWebAudioOpusFrame(
	frame: Uint8Array | Buffer,
	options?: { protocolVersion?: number; allowLegacy?: boolean },
): {
	version: number;
	codec: "opus";
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
		if (version !== 1) {
			throw new Error(`Unsupported audio frame protocol version: ${version}`);
		}
		const flags = view[3];
		if (flags !== WEB_AUDIO_FLAG_CODEC_OPUS) {
			throw new Error(`Invalid audio frame flags: 0x${flags.toString(16)}`);
		}
		const sequence = view.readUInt32BE(4);
		const timestampUs = view.readBigUInt64BE(8);
		const timestampMs = Number(timestampUs / 1000n);
		const payload = view.subarray(WEB_AUDIO_FRAME_HEADER_BYTES);
		return {
			version,
			codec: "opus",
			sequence,
			timestampMs,
			timestampUs,
			sampleRateHz: WEB_AUDIO_OPUS_SAMPLE_RATE_HZ,
			channels: WEB_AUDIO_OPUS_CHANNELS,
			payload,
		};
	} else {
		if (options?.protocolVersion === 1 || options?.allowLegacy === false) {
			throw new Error("Malformed Web audio frame: missing 'ZI' protocol header");
		}
		// Legacy format fallback
		const sequence = view.readUInt32LE(0);
		const timestampMs = view.readUInt32LE(4);
		const timestampUs = BigInt(timestampMs) * 1000n;
		const sampleRateHz = view.readUInt16LE(8);
		const channels = view.readUInt16LE(10);
		const codecId = view.readUInt16LE(12);
		if (codecId !== WEB_AUDIO_OPUS_CODEC_ID) throw new Error(`Unsupported legacy audio codec ID: ${codecId}`);
		const payload = view.subarray(WEB_AUDIO_FRAME_HEADER_BYTES);
		return { version: 0, codec: "opus", sequence, timestampMs, timestampUs, sampleRateHz, channels, payload };
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
		status: VoiceConnectionStatus.Disconnected,
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
	private readonly socketQueues = new Map<WebSocketLike, Array<{ frame: Buffer; sequence: number; size: number }>>();

	private pendingPacket: Buffer | null = null;
	private sequence = 0;
	private mediaTimestampUs = 0n;
	private startTime = 0;
	private speaking = false;
	private destroyed = false;
	private manuallyDisconnected = false;

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

	private setState(status: VoiceConnectionStatus): void {
		const oldStatus = this.state.status;
		if (oldStatus === status) return;
		this.state.status = status;
		this.emit("stateChange", status, oldStatus);
	}

	private updateState(): void {
		if (this.destroyed) {
			this.setState(VoiceConnectionStatus.Destroyed);
			return;
		}
		if (this.manuallyDisconnected) {
			this.setState(VoiceConnectionStatus.Disconnected);
			return;
		}
		const hasOpen = Array.from(this.sockets).some((s) => s.readyState === 1);
		if (hasOpen) {
			this.setState(VoiceConnectionStatus.Ready);
		} else {
			const hasConnecting = Array.from(this.sockets).some((s) => s.readyState === 0);
			if (hasConnecting) {
				this.setState(VoiceConnectionStatus.Connecting);
			} else {
				this.setState(VoiceConnectionStatus.Disconnected);
			}
		}
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
		this.socketQueues.set(socket, []);

		let configSent = false;
		const sendConfigOnce = () => {
			if (this.destroyed || configSent || socket.readyState !== 1) return;
			configSent = true;
			this.sendConfigToSocket(socket);
		};

		const onOpen = () => {
			if (this.destroyed) return;
			sendConfigOnce();
			this.manuallyDisconnected = false;
			this.updateState();
		};
		const onClose = () => this.detachSocket(socket);
		const onError = (error: any) => {
			this.debugLogger?.(`[WebAudioConnection] Socket error (${this.sessionId}): ${error?.message ?? error}`);
			this.emit("socketError", { socket, error });
			this.detachSocket(socket);
		};

		socket.addEventListener?.("open", onOpen);
		socket.addEventListener?.("close", onClose);
		socket.addEventListener?.("error", onError);

		this.socketCleanups.set(socket, () => {
			socket.removeEventListener?.("open", onOpen);
			socket.removeEventListener?.("close", onClose);
			socket.removeEventListener?.("error", onError);
		});

		if (socket.readyState === 1) {
			sendConfigOnce();
		}
		this.manuallyDisconnected = false;
		this.updateState();
		this.emit("socketAttach", socket);
	}

	/**
	 * Detach a WebSocket client or publisher socket.
	 */
	public detachSocket(socket: WebSocketLike): void {
		if (!this.sockets.has(socket)) return;
		this.sockets.delete(socket);
		this.socketQueues.delete(socket);
		const cleanup = this.socketCleanups.get(socket);
		if (cleanup) {
			cleanup();
			this.socketCleanups.delete(socket);
		}
		this.updateState();
		this.emit("socketDetach", socket);
	}

	/**
	 * Reconnects the connection after disconnect, restoring readiness if sinks are available.
	 */
	public reconnect(): boolean {
		if (this.destroyed) return false;
		this.manuallyDisconnected = false;
		this.updateState();
		return true;
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

		this.manuallyDisconnected = false;

		// If this connection is already subscribed to this player, return existing
		if (this.state.subscription && this.state.subscription.player === targetPlayer) {
			this.updateState();
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
		this.updateState();
		this.startTime = Date.now();
		this.reset();
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

		if (packet.length === 0 || !validateOpusPacketFraming(packet) || !validateOpusPacketDuration(packet, 20)) {
			this.debugLogger?.(`[WebAudioConnection] Dropped invalid or non-20ms Opus packet (length: ${packet.length})`);
			return;
		}

		const durationMs = 20;
		const seq = this.sequence;
		this.sequence = (this.sequence + 1) >>> 0;
		const timestampUs = this.mediaTimestampUs;

		const durationUs = BigInt(Math.round(durationMs * 1000));
		this.mediaTimestampUs += durationUs;

		let encodedFrame: Buffer | null = null;

		// Dispatch to all attached sockets
		for (const socket of [...this.sockets]) {
			if (socket.readyState !== 1 /* OPEN */) {
				continue;
			}

			if (!encodedFrame) {
				encodedFrame = encodeWebAudioOpusFrame(packet, seq, timestampUs);
			}

			const queue = this.socketQueues.get(socket) ?? [];

			// First, drain any previously queued packets if socket buffer has capacity
			while (queue.length > 0) {
				const next = queue[0];
				const buffered = socket.bufferedAmount ?? 0;
				if (buffered + next.frame.length > this.maxBufferedBytes) {
					break;
				}
				queue.shift();
				try {
					socket.send(next.frame);
					this.dispatchedPackets++;
					this.dispatchedBytes += next.size;
				} catch (err: any) {
					this.debugLogger?.(`[WebAudioConnection] Error sending queued frame: ${err?.message}`);
					this.detachSocket(socket);
					break;
				}
			}

			if (!this.sockets.has(socket)) continue;

			const currentBuffered = socket.bufferedAmount ?? 0;
			const fitsInBuffer = queue.length === 0 && currentBuffered + encodedFrame.length <= this.maxBufferedBytes;

			if (fitsInBuffer) {
				try {
					socket.send(encodedFrame);
					this.dispatchedPackets++;
					this.dispatchedBytes += packet.length;
				} catch (err: any) {
					this.debugLogger?.(`[WebAudioConnection] Error sending frame to socket: ${err?.message}`);
					this.detachSocket(socket);
				}
			} else {
				// Socket is congested or has queued frames
				if (queue.length >= this.maxQueuedPackets) {
					if (this.dropPolicy === "drop-oldest" && queue.length > 0) {
						const dropped = queue.shift()!;
						this.droppedPackets++;
						this.droppedBytes += dropped.size;
						this.debugLogger?.(
							`[WebAudioConnection] Dropped oldest queued packet ${dropped.sequence} (queue size: ${this.maxQueuedPackets})`,
						);
						this.onDropCallback?.({
							socket,
							droppedPackets: this.droppedPackets,
							droppedBytes: this.droppedBytes,
							reason: "maxQueuedPackets exceeded (drop-oldest)",
						});
						this.emit("drop", { socket, sequence: dropped.sequence, bytes: dropped.size });
						queue.push({ frame: encodedFrame, sequence: seq, size: packet.length });
					} else if (this.dropPolicy === "disconnect") {
						this.droppedPackets++;
						this.droppedBytes += packet.length;
						this.onDropCallback?.({
							socket,
							droppedPackets: this.droppedPackets,
							droppedBytes: this.droppedBytes,
							reason: "backpressure limit exceeded (disconnect)",
						});
						this.emit("drop", { socket, sequence: seq, bytes: packet.length });
						try {
							socket.close(1013, "Listener is too slow");
						} catch {}
						this.detachSocket(socket);
					} else {
						// drop-newest
						this.droppedPackets++;
						this.droppedBytes += packet.length;
						this.debugLogger?.(
							`[WebAudioConnection] Dropped newest packet ${seq} (buffered: ${currentBuffered}, queue: ${queue.length})`,
						);
						this.onDropCallback?.({
							socket,
							droppedPackets: this.droppedPackets,
							droppedBytes: this.droppedBytes,
							reason: "maxBufferedBytes or maxQueuedPackets exceeded (drop-newest)",
						});
						this.emit("drop", { socket, sequence: seq, bytes: packet.length });
					}
				} else {
					queue.push({ frame: encodedFrame, sequence: seq, size: packet.length });
				}
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
		this.manuallyDisconnected = true;
		this.setState(VoiceConnectionStatus.Disconnected);
		this.setSpeaking(false);
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
		this.socketQueues.clear();
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
