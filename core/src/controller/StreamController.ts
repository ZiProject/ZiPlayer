import type { StreamInfo, Track, ActiveStream, StreamControllerOptions, PlayerAction } from "../types";
import { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { Bus } from "../structures/Bus";
import { CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC, BUS_EVENT } from "../structures/BusContract";

const STREAM_RPC_REPLACE = "controller.stream.replace";

/** Per-player active-stream tracking, owned by the shared `StreamController` below. */
export class StreamWorker {
	private active: ActiveStream | null = null;
	private readonly streamManager?: StreamManager;
	private readonly bus?: Bus;
	private readonly playerId?: string;
	private readonly detachAction?: () => void;
	private readonly detachRpcs: Array<() => void> = [];
	private readonly detachStreamError?: () => void;
	constructor(options: StreamControllerOptions & { playerId?: string } = {}) {
		this.streamManager = options.streamManager;
		this.bus = options.bus;
		this.playerId = options.playerId;
		if (this.streamManager && this.bus && this.playerId) {
			const bus = this.bus;
			const playerId = this.playerId;
			const onStreamError = ({ error }: { error: Error }) =>
				bus.event(playerId, {
					type: BUS_EVENT.streamError,
					error,
					track: bus.querySync(playerId, PLAYER_QUERY.currentTrack) as Track | null,
				});
			this.streamManager.on("streamError", onStreamError);
			this.detachStreamError = () => this.streamManager?.off("streamError", onStreamError);
		}
	}
	public get statsSnapshot() {
		return this.streamManager?.getStats() ?? null;
	}
	public get stateSnapshot() {
		return this.active ? { sessionId: this.active.sessionId, track: this.active.track } : null;
	}
	public async handleRemote(stream: { handle?: { play?: () => void | Promise<void> } }): Promise<boolean> {
		if (stream?.handle?.play) await stream.handle.play();
		return true;
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
		if (this.bus && this.playerId)
			this.bus.event(this.playerId, { type: BUS_EVENT.streamAborted, session: stream.session.snapshot() });
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

/** Shared, singleton controller: owns active-stream tracking for every player, keyed
 *  by playerId. */
export class StreamController {
	private readonly workers = new Map<string, StreamWorker>();

	constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			if (!context.signal.aborted && action.type === "STOP") this.workers.get(context.playerId)?.abortCurrent();
		});
		bus.registerRpc<{ track: Track; stream: { handle?: { play?: () => void | Promise<void> } } }, boolean>(
			CONTROLLER_RPC.playbackRemote,
			({ stream }, ctx) => this.workers.get(ctx.playerId)?.handleRemote(stream) ?? Promise.resolve(true),
		);
		bus.registerRpc<void, void>(CONTROLLER_RPC.playbackDestroyCurrentStream, (_req, ctx) =>
			this.workers.get(ctx.playerId)?.abortCurrent(),
		);
		bus.registerRpc<{ streamInfo: StreamInfo; session: PlaybackSession }, ActiveStream>(
			STREAM_RPC_REPLACE,
			({ streamInfo, session }, ctx) => {
				const worker = this.workers.get(ctx.playerId);
				if (!worker) throw new Error("StreamController is disposed");
				return worker.replace(streamInfo, session);
			},
		);
		bus.registerQuery(PLAYER_QUERY.streamStats, (playerId) => this.workers.get(playerId)?.statsSnapshot ?? null);
		bus.registerQuery(PLAYER_QUERY.streamState, (playerId) => this.workers.get(playerId)?.stateSnapshot ?? null);
		bus.registerQuery(PLAYER_QUERY.streamCurrent, (playerId) => this.workers.get(playerId)?.current ?? null);
		bus.registerRpc(PLAYER_RPC.streamState, (_req, ctx) => this.workers.get(ctx.playerId)?.stateSnapshot ?? null);
		bus.registerRpc(PLAYER_RPC.streamCurrent, (_req, ctx) => this.workers.get(ctx.playerId)?.current ?? null);
	}

	attach(playerId: string, streamManager?: StreamManager): void {
		this.workers.set(playerId, new StreamWorker({ streamManager, bus: this.bus, playerId }));
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}
}
