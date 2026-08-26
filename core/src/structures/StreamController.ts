import { Readable } from "stream";
import type { StreamInfo, Track } from "../types";
import type { PlaybackSession } from "./PlaybackSession";
import type { StreamManager } from "./StreamManager";

export interface ActiveStream {
	sessionId: number;
	track: Track;
	stream: Readable;
	streamId: string | null;
}

export interface StreamControllerOptions {
	streamManager?: StreamManager;
}

/**
 * Owns exactly one playback stream at a time.
 *
 * Replacing a stream always aborts the previous session before the new stream
 * becomes active. This is the stream-side lifecycle boundary for PlaybackSession.
 */
export class StreamController {
	private active: ActiveStream | null = null;
	private readonly streamManager?: StreamManager;

	public constructor(options: StreamControllerOptions = {}) {
		this.streamManager = options.streamManager;
	}

	public get current(): ActiveStream | null {
		return this.active;
	}

	public async resolve(info: StreamInfo, session: PlaybackSession): Promise<Readable> {
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

	public async replace(info: StreamInfo, session: PlaybackSession): Promise<ActiveStream> {
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

		const active: ActiveStream = {
			sessionId: session.id,
			track: session.track!,
			stream,
			streamId: streamId ?? null,
		};
		this.active = active;

		const cleanup = (): void => {
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

	public abortCurrent(): void {
		if (this.active) this.abort(this.active);
	}

	public abort(stream: ActiveStream): void {
		if (this.active?.stream !== stream.stream) return;
		this.active = null;

		if (stream.streamId) {
			this.streamManager?.unregisterStream(stream.streamId, true);
			return;
		}

		if (!stream.stream.destroyed) {
			try {
				stream.stream.destroy();
			} catch {
				// Cleanup must be best-effort and never mask the lifecycle transition.
			}
		}
	}

	public dispose(): void {
		this.abortCurrent();
		this.active = null;
	}

	private abortError(): Error {
		const error = new Error("Playback stream operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
