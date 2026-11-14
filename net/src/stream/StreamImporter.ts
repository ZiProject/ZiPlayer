import { Readable } from "node:stream";
import type { NetNode } from "../NetNode";
import { DEFAULT_ALLOWED_STREAM_TYPES } from "./StreamProvider";
import { AUDIO_FLAG_EOS, type AudioFrame } from "../protocol/frames";

export interface RemoteStream {
	stream: Readable;
	streamType: string;
	seekable: boolean;
	/** Re-open the stream at `positionMs` from the same owner (seek / URL refresh). */
	recreate: (positionMs: number) => Promise<Readable>;
}

export interface StreamImporterOptions {
	/** Receive buffer in bytes; also the maximum credit outstanding. Default 512 KiB. */
	bufferBytes?: number;
	/** Max out-of-order chunks held while waiting for a gap. Default 256. */
	maxReorder?: number;
	openTimeoutMs?: number;
	/** Accepted stream types from peers. Default: compressed audio (Opus containers and `arbitrary`), never raw PCM. */
	allowedStreamTypes?: string[];
}

class IncomingStream extends Readable {
	expected = 0;
	received = 0;
	granted: number;
	readonly pendingChunks = new Map<number, AudioFrame>();

	constructor(
		readonly streamId: number,
		readonly peerId: string,
		readonly bufferBytes: number,
		private readonly grant: (bytes: number) => void,
		private readonly onDestroy: () => void,
	) {
		super({ highWaterMark: bufferBytes });
		this.granted = bufferBytes;
	}

	_read(): void {
		// Node may call _read() before the consumer has drained its read, so re-check once it has.
		queueMicrotask(() => this.topUp());
	}

	/** Every consumption path (flowing mode, async iteration, pipe) calls read(); re-grant credit right after. */
	read(size?: number): any {
		const chunk = super.read(size);
		this.topUp();
		return chunk;
	}

	topUp(): void {
		if (this.destroyed) return;
		const outstanding = this.granted - this.received;
		const want = this.bufferBytes - this.readableLength - outstanding;
		if (want >= this.bufferBytes / 4) {
			this.granted += want;
			this.grant(want);
		}
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.onDestroy();
		callback(error);
	}
}

/** Consumer side: asks the owner streamInfo node for audio and exposes it as a normal Readable. */
export class StreamImporter {
	private readonly streams = new Map<string, IncomingStream>();
	private nextStreamId = 1;
	private readonly bufferBytes: number;
	private readonly maxReorder: number;

	constructor(
		private readonly node: NetNode,
		private readonly options: StreamImporterOptions = {},
	) {
		this.bufferBytes = options.bufferBytes ?? 512 * 1024;
		this.maxReorder = options.maxReorder ?? 256;
		node.on("sessionClose", (peerId: string) => {
			for (const s of [...this.streams.values()]) if (s.peerId === peerId) s.destroy(new Error(`Session with ${peerId} closed`));
		});
		node.handle("stream.error", (body, ctx) => {
			this.streams
				.get(`${ctx.from}#${Number(body?.streamId)}`)
				?.destroy(new Error(String(body?.message ?? "Remote stream error")));
		});
	}

	/** Called by the owner of the audio handler for every frame received. */
	onFrame(peerId: string, frame: AudioFrame): void {
		const stream = this.streams.get(`${peerId}#${frame.streamId}`);
		if (!stream || stream.destroyed) return;
		if (frame.seq < stream.expected) return; // duplicate
		if (frame.seq > stream.expected) {
			if (stream.pendingChunks.size >= this.maxReorder)
				return void stream.destroy(new Error("Too many out-of-order audio frames"));
			stream.pendingChunks.set(frame.seq, frame);
			return;
		}
		let next: AudioFrame | undefined = frame;
		while (next) {
			stream.expected++;
			stream.pendingChunks.delete(next.seq);
			if (next.payload.length) {
				stream.received += next.payload.length;
				stream.push(next.payload);
			}
			if (next.flags & AUDIO_FLAG_EOS) {
				stream.push(null);
				return;
			}
			next = stream.pendingChunks.get(stream.expected);
		}
	}

	async open(
		peerId: string,
		track: unknown,
		options?: { position?: number; fresh?: boolean; signal?: AbortSignal },
	): Promise<RemoteStream> {
		const streamId = this.nextStreamId++ >>> 0;
		const key = `${peerId}#${streamId}`;
		const incoming = new IncomingStream(
			streamId,
			peerId,
			this.bufferBytes,
			(bytes) => void this.node.notify(peerId, "stream.credit", { streamId, bytes }).catch(() => {}),
			() => {
				if (this.streams.delete(key)) void this.node.notify(peerId, "stream.close", { streamId }).catch(() => {});
			},
		);
		this.streams.set(key, incoming);
		try {
			const reply = await this.node.request<{ streamType: string; seekable: boolean; positionApplied: boolean }>(
				peerId,
				"stream.open",
				{ streamId, track, position: options?.position ?? 0, fresh: options?.fresh === true, credit: this.bufferBytes },
				{ timeoutMs: this.options.openTimeoutMs ?? 20_000, signal: options?.signal },
			);
			const allowed = (this.options.allowedStreamTypes ?? DEFAULT_ALLOWED_STREAM_TYPES).map((t) => t.toLowerCase());
			if (!allowed.includes(String(reply.streamType).toLowerCase())) {
				throw new Error(`Peer offered disallowed stream type "${reply.streamType}"`);
			}
			if ((options?.position ?? 0) > 0 && !reply.positionApplied) {
				throw new Error("Stream owner cannot seek this stream");
			}
			return {
				stream: incoming,
				streamType: reply.streamType,
				seekable: reply.seekable,
				recreate: async (positionMs) => (await this.open(peerId, track, { position: positionMs, fresh: true })).stream,
			};
		} catch (error) {
			incoming.destroy();
			throw error;
		}
	}

	closeAll(): void {
		for (const s of [...this.streams.values()]) s.destroy();
	}
}
