import { Readable } from "node:stream";
import type { NetNode } from "../NetNode";
import { AUDIO_FLAG_EOS } from "../protocol/frames";

/** The subset of ziplayer's `StreamInfo` the provider needs (keeps this module free of a runtime ziplayer dependency). */
/**
 * Compressed audio only. Official plugins (YouTube, SoundCloud, TTS...) return `arbitrary` (a compressed container the
 * receiver demuxes exactly as it would locally), so it is allowed; raw PCM is not. Pass `["webm/opus", "ogg/opus", "opus"]`
 * to accept Opus containers only.
 */
export const DEFAULT_ALLOWED_STREAM_TYPES = ["webm/opus", "ogg/opus", "opus", "arbitrary"];

export interface ProvidedStreamInfo {
	stream?: Readable;
	url?: string;
	streamType?: string;
	type?: string;
	recreate?: (position: number) => Promise<Readable>;
	remote?: boolean;
}

export interface StreamProviderOptions {
	/** Resolve a stream for a track, typically `(track) => manager.resolveStream(track)`. */
	resolveStream: (track: any, options: { fresh?: boolean }) => Promise<ProvidedStreamInfo | null>;
	/** Return false to refuse a track (allowlist of sources, etc.). */
	allow?: (track: any, peerId: string) => boolean | Promise<boolean>;
	/** Stream types that may leave this node. Default: compressed audio (Opus containers and `arbitrary`), never raw PCM. */
	allowedStreamTypes?: string[];
	chunkBytes?: number;
	maxStreamsPerPeer?: number;
	debug?: (message: string, ...args: unknown[]) => void;
}

interface OpenStream {
	peerId: string;
	streamId: number;
	source: Readable;
	credit: number;
	waiter: (() => void) | null;
	closed: boolean;
}

/**
 * Owner-streamInfo side. The node whose plugins resolve the stream keeps the source and pushes encoded
 * audio (webm/ogg/opus, never PCM) to the requesting node, paced by credit the receiver grants.
 */
export class StreamProvider {
	private readonly open = new Map<string, OpenStream>();
	private readonly chunkBytes: number;
	private readonly allowedTypes: Set<string>;

	constructor(
		private readonly node: NetNode,
		private readonly options: StreamProviderOptions,
	) {
		this.allowedTypes = new Set((options.allowedStreamTypes ?? DEFAULT_ALLOWED_STREAM_TYPES).map((t) => t.toLowerCase()));
		this.chunkBytes = Math.max(1024, Math.min(options.chunkBytes ?? 16 * 1024, 256 * 1024));
		node.handle("stream.open", (body, ctx) => this.onOpen(body, ctx.from), { role: "provide-stream" });
		node.handle("stream.credit", (body, ctx) => this.onCredit(body, ctx.from), { role: "provide-stream" });
		node.handle("stream.close", (body, ctx) => this.close(ctx.from, body?.streamId), { role: "provide-stream" });
		node.on("sessionClose", (peerId: string) => this.closePeer(peerId));
	}

	private key(peerId: string, streamId: number) {
		return `${peerId}#${streamId}`;
	}

	private async onOpen(body: any, from: string) {
		const streamId = Number(body?.streamId);
		if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) throw new Error("Invalid streamId");
		const track = body?.track;
		if (!track || typeof track !== "object") throw new Error("Missing track");
		if (this.options.allow && !(await this.options.allow(track, from))) throw new Error("Track refused by provider");
		const perPeer = [...this.open.values()].filter((s) => s.peerId === from).length;
		if (perPeer >= (this.options.maxStreamsPerPeer ?? 8)) throw new Error("Too many open streams");
		if (this.open.has(this.key(from, streamId))) this.close(from, streamId);

		const info = await this.options.resolveStream(track, { fresh: body?.fresh === true });
		if (!info) throw new Error("No stream available");
		const streamType = String(info.streamType ?? info.type ?? "arbitrary");
		if (!this.allowedTypes.has(streamType.toLowerCase())) {
			info.stream?.destroy();
			throw new Error(`Stream type "${streamType}" is not transferable (allowed: ${[...this.allowedTypes].join(", ")})`);
		}
		const position = Number(body?.position) > 0 ? Number(body.position) : 0;
		let source: Readable | null = null;
		if (position > 0 && info.recreate) {
			info.stream?.destroy();
			source = await info.recreate(position);
		} else if (info.stream) {
			source = info.stream;
		} else if (info.url) {
			source = await fetchUrl(info.url);
		}
		if (!source) throw new Error("Stream has no readable source");

		const state: OpenStream = {
			peerId: from,
			streamId,
			source,
			credit: Math.max(0, Number(body?.credit) || 0),
			waiter: null,
			closed: false,
		};
		this.open.set(this.key(from, streamId), state);
		// Start pumping after the reply has been queued.
		setImmediate(() => void this.pump(state));
		return { streamId, streamType, seekable: Boolean(info.recreate), positionApplied: position > 0 && Boolean(info.recreate) };
	}

	private onCredit(body: any, from: string) {
		const state = this.open.get(this.key(from, Number(body?.streamId)));
		if (!state) return;
		state.credit += Math.max(0, Number(body?.bytes) || 0);
		state.waiter?.();
	}

	private async pump(state: OpenStream): Promise<void> {
		let seq = 0;
		try {
			for await (const chunk of state.source as AsyncIterable<Buffer | string>) {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				for (let offset = 0; offset < buf.length; offset += this.chunkBytes) {
					const part = buf.subarray(offset, offset + this.chunkBytes);
					while (state.credit < part.length && !state.closed) {
						await new Promise<void>((resolve) => (state.waiter = resolve));
						state.waiter = null;
					}
					if (state.closed) return;
					state.credit -= part.length;
					await this.node.sendAudio(state.peerId, { streamId: state.streamId, seq: seq++, flags: 0, payload: part });
				}
			}
			if (!state.closed) {
				await this.node.sendAudio(state.peerId, {
					streamId: state.streamId,
					seq: seq++,
					flags: AUDIO_FLAG_EOS,
					payload: Buffer.alloc(0),
				});
			}
		} catch (error) {
			if (!state.closed) {
				this.options.debug?.(`stream ${state.streamId} failed: ${(error as Error).message}`);
				this.node
					.notify(state.peerId, "stream.error", { streamId: state.streamId, message: (error as Error).message })
					.catch(() => {});
			}
		} finally {
			this.close(state.peerId, state.streamId);
		}
	}

	close(peerId: string, streamId: number): void {
		const k = this.key(peerId, Number(streamId));
		const state = this.open.get(k);
		if (!state) return;
		state.closed = true;
		this.open.delete(k);
		state.waiter?.();
		state.source.destroy();
	}

	closePeer(peerId: string): void {
		for (const s of [...this.open.values()]) if (s.peerId === peerId) this.close(peerId, s.streamId);
	}

	closeAll(): void {
		for (const s of [...this.open.values()]) this.close(s.peerId, s.streamId);
	}
}

async function fetchUrl(url: string): Promise<Readable> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`Upstream returned ${res.status}`);
	return Readable.fromWeb(res.body as any);
}
