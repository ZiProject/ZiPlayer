import type { StreamInfo, Track, ActiveStream, StreamControllerOptions, PlayerAction } from "../types";
import { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { PlayerBus } from "../structures/PlayerBus";

const STREAM_RPC_REPLACE = "controller.stream.replace";

export class StreamController {
	private active: ActiveStream | null = null;
	private readonly streamManager?: StreamManager;
	private readonly bus?: PlayerBus;
	private readonly detachAction?: () => void;
	private readonly detachRpcs: Array<() => void> = [];
	private readonly detachStreamError?: () => void;
	constructor(options: StreamControllerOptions = {}) {
		this.streamManager = options.streamManager;
		this.bus = options.bus;
		if (this.bus) {
			this.detachAction = this.bus.onAction((action: PlayerAction, context) => {
				if (!context.signal.aborted && action.type === "STOP") this.abortCurrent();
			});
			this.detachRpcs.push(
				this.bus.registerRpc<{ streamInfo: StreamInfo; session: PlaybackSession }, ActiveStream>(STREAM_RPC_REPLACE, ({ streamInfo, session }) =>
					this.replace(streamInfo, session),
				),
				this.bus.registerQuery("stream.stats", () => this.streamManager?.getStats() ?? null),
			);
		}
		if (this.streamManager && this.bus) {
			const onStreamError = ({ error }: { error: Error }) =>
				this.bus?.event({ type: "streamError", error, track: this.bus.querySync("currentTrack") as Track | null });
			this.streamManager.on("streamError", onStreamError);
			this.detachStreamError = () => this.streamManager?.off("streamError", onStreamError);
		}
	}
	get current() {
		return this.active;
	}
	async resolve(info: StreamInfo, session: PlaybackSession): Promise<Readable> {
		if (!session.isActive()) throw this.abortError();

		if (info.stream && !info.stream.destroyed && (info.stream as any).readable !== false) {
			return info.stream;
		}

		if (info.url) {
			try {
				if (/^https?:\/\//i.test(info.url)) {
					const response = await fetch(info.url, { signal: session.signal });
					if (!response.ok || !response.body) {
						throw new Error(`Failed to fetch stream from URL (${response.status} ${response.statusText}): ${info.url}`);
					}
					if (!session.isActive()) throw this.abortError();
					return Readable.fromWeb(response.body as any);
				}
				const fs = await import("fs");
				const filePath = info.url.startsWith("file://") ? new URL(info.url) : info.url;
				if (fs.existsSync(filePath)) {
					if (!session.isActive()) throw this.abortError();
					return fs.createReadStream(filePath);
				}
				throw new Error(`File URL not found: ${info.url}`);
			} catch (urlError) {
				if (!session.isActive() || this.isAbortError(urlError)) throw this.abortError();
				if (info.recreate) {
					const stream = await info.recreate(info.position ?? 0);
					if (!session.isActive()) {
						stream.destroy();
						throw this.abortError();
					}
					return stream;
				}
				throw urlError;
			}
		}

		if (info.recreate) {
			const stream = await info.recreate(info.position ?? 0);
			if (!session.isActive()) {
				stream.destroy();
				throw this.abortError();
			}
			return stream;
		}

		throw new Error("StreamInfo does not contain a readable stream, url, or recreate factory");
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
		const active: ActiveStream = {
			sessionId: session.id,
			session,
			track: session.track!,
			stream,
			streamId: streamId ?? null,
			inputType: info.inputType,
		};
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
		this.detachStreamError?.();
		this.detachAction?.();
		for (const detach of this.detachRpcs) detach();
		this.detachRpcs.length = 0;
		this.abortCurrent();
		this.active = null;
	}
	private isAbortError(error: unknown): boolean {
		return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
	}
	private abortError() {
		const error = new Error("Playback stream operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
