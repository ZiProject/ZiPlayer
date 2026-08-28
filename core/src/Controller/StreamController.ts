import { createAudioResource, type AudioResource } from "@discordjs/voice";
import type { StreamInfo, Track } from "../types";
import type { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { PlayerBus } from "../structures/PlayerBus";
export interface ActiveStream {
	sessionId: number;
	session: PlaybackSession;
	track: Track;
	stream: Readable;
	streamId: string | null;
}
export interface StreamControllerOptions {
	streamManager?: StreamManager;
	bus?: PlayerBus;
}
export class StreamController {
	private active: ActiveStream | null = null;
	private readonly streamManager?: StreamManager;
	private readonly bus?: PlayerBus;
	constructor(options: StreamControllerOptions = {}) {
		this.streamManager = options.streamManager;
		this.bus = options.bus;
	}
	get current() {
		return this.active;
	}
	async resolve(info: StreamInfo, session: PlaybackSession): Promise<Readable> {
		if (!session.isActive()) throw this.abortError();
		if (info.stream) return info.stream;
		if (info.recreate) {
			const stream = await info.recreate(info.position ?? 0);
			if (!session.isActive()) {
				stream.destroy();
				throw this.abortError();
			}
			return stream;
		}
		throw new Error("StreamInfo does not contain a readable stream or recreate factory");
	}
	async replace(info: StreamInfo, session: PlaybackSession): Promise<ActiveStream> {
		const stream = await this.resolve(info, session);
		if (!session.isActive()) {
			stream.destroy();
			throw this.abortError();
		}
		this.abortCurrent();
		const streamId = this.streamManager?.registerStream(stream, session.track!, {
			source: session.track?.source,
			isPreload: false,
			isRemote: info.remote ?? false,
			priority: 10,
		});
		const active: ActiveStream = { sessionId: session.id, session, track: session.track!, stream, streamId: streamId ?? null };
		this.active = active;
		const cleanup = () => {
			if (this.active?.sessionId !== session.id || this.active.stream !== stream) return;
			this.active = null;
			if (streamId) this.streamManager?.unregisterStream(streamId, false);
		};
		stream.once("close", cleanup);
		stream.once("end", cleanup);
		stream.once("error", cleanup);
		session.signal.addEventListener("abort", () => this.abort(active), { once: true });
		return active;
	}
	createResource(stream: Readable, track?: Track): AudioResource {
		return createAudioResource(stream, { metadata: { ...track, inlineVolume: true } });
	}
	abortCurrent() {
		if (this.active) this.abort(this.active);
	}
	abort(stream: ActiveStream) {
		if (this.active?.stream !== stream.stream) return;
		this.active = null;
		this.bus?.event({ type: "STREAM_ABORTED", session: stream.session.snapshot() });
		if (stream.streamId) {
			this.streamManager?.unregisterStream(stream.streamId, true);
			return;
		}
		if (!stream.stream.destroyed) {
			try {
				stream.stream.destroy();
			} catch {}
		}
	}
	dispose() {
		this.abortCurrent();
		this.active = null;
	}
	private abortError() {
		const error = new Error("Playback stream operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
