import { PlaybackMode, type StreamInfo, type Track, type ActiveStream, type StreamControllerOptions } from "../types";
import { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { Bus } from "../structures/Bus";
import { CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC, BUS_EVENT } from "../structures/BusContract";

const STREAM_RPC_REPLACE = "controller.stream.replace";

/** Per-player active-stream tracking, owned by the shared `StreamController` below. */
export class StreamWorker {
	private active: ActiveStream | null = null;
	private remoteHandle: NonNullable<StreamInfo["handle"]> | null = null;
	private remotePaused = false;
	private readonly streamManager?: StreamManager;
	private readonly bus?: Bus;
	private readonly playerId?: string;
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
	public get isRemotePaused(): boolean {
		return this.remotePaused;
	}
	public async handleRemote(stream: { handle?: NonNullable<StreamInfo["handle"]> }): Promise<boolean> {
		this.remoteHandle = stream?.handle ?? null;
		this.remotePaused = false;
		if (this.bus && this.playerId && this.bus.hasRpc(CONTROLLER_RPC.playbackModeSet)) {
			this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackModeSet, { mode: PlaybackMode.REMOTE });
		}
		if (stream?.handle?.play) await stream.handle.play();
		return true;
	}
	public exitRemote(): void {
		const handle = this.remoteHandle;
		if (!handle && !this.remotePaused) return;
		this.remoteHandle = null;
		this.remotePaused = false;
		if (this.bus && this.playerId && this.bus.hasRpc(CONTROLLER_RPC.playbackModeSet)) {
			this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackModeSet, { mode: PlaybackMode.NATIVE });
		}
		if (handle?.destroy) {
			void handle.destroy().catch(() => {});
		}
	}
	public remotePause(): boolean {
		if (!this.remoteHandle) return false;
		this.remotePaused = true;
		void this.remoteHandle.pause().catch(() => {});
		return true;
	}
	public remoteResume(): boolean {
		if (!this.remoteHandle) return false;
		this.remotePaused = false;
		void this.remoteHandle.resume().catch(() => {});
		return true;
	}
	public remoteStop(): boolean {
		this.remotePaused = false;
		if (this.remoteHandle) {
			void this.remoteHandle.stop().catch(() => {});
		}
		return true;
	}
	public async remoteSeek(position: number): Promise<boolean> {
		if (!this.remoteHandle) return false;
		try {
			await this.remoteHandle.seek(position);
			return true;
		} catch {
			return false;
		}
	}
	public async remoteSetVolume(volume: number): Promise<boolean> {
		if (!this.remoteHandle) return false;
		try {
			await this.remoteHandle.setVolume(volume);
			return true;
		} catch {
			return false;
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
		void this.exitRemote();
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
			if (!context.signal.aborted && action.type === "STOP") {
				const worker = this.workers.get(context.playerId);
				worker?.abortCurrent();
				void worker?.remoteStop();
			}
		});
		bus.registerRpc<{ track?: Track; stream: StreamInfo }, boolean>(
			CONTROLLER_RPC.playbackRemote,
			async ({ track, stream }, ctx) => {
				const worker = this.workers.get(ctx.playerId);
				if (!worker) return false;
				const ok = await worker.handleRemote(stream);
				if (ok && track) {
					bus.requestRpcSync(ctx.playerId, PLAYER_RPC.queueSetCurrent, { track });
					bus.event(ctx.playerId, { type: BUS_EVENT.trackStarted, session: null as any, track });
				}
				return ok;
			},
		);
		bus.registerRpc<{ stream: StreamInfo }, boolean>(
			CONTROLLER_RPC.playbackRemoteAttach,
			({ stream }, ctx) => this.workers.get(ctx.playerId)?.handleRemote(stream) ?? Promise.resolve(false),
		);
		bus.registerRpc<void, boolean>(
			CONTROLLER_RPC.playbackRemotePause,
			(_req, ctx) => this.workers.get(ctx.playerId)?.remotePause() ?? false,
		);
		bus.registerRpc<void, boolean>(
			CONTROLLER_RPC.playbackRemoteResume,
			(_req, ctx) => this.workers.get(ctx.playerId)?.remoteResume() ?? false,
		);
		bus.registerRpc<void, boolean>(
			CONTROLLER_RPC.playbackRemoteStop,
			(_req, ctx) => this.workers.get(ctx.playerId)?.remoteStop() ?? false,
		);
		bus.registerRpc<{ position: number }, boolean>(
			CONTROLLER_RPC.playbackRemoteSeek,
			({ position }, ctx) => this.workers.get(ctx.playerId)?.remoteSeek(position) ?? Promise.resolve(false),
		);
		bus.registerRpc<{ volume: number }, boolean>(
			CONTROLLER_RPC.playbackRemoteSetVolume,
			({ volume }, ctx) => this.workers.get(ctx.playerId)?.remoteSetVolume(volume) ?? Promise.resolve(false),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.playbackExitRemote, (_req, ctx) => {
			this.workers.get(ctx.playerId)?.exitRemote();
		});
		bus.registerQuery(PLAYER_QUERY.remotePaused, (playerId) => this.workers.get(playerId)?.isRemotePaused ?? false);
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
		if (this.workers.has(playerId)) this.detach(playerId);
		this.workers.set(playerId, new StreamWorker({ streamManager, bus: this.bus, playerId }));
	}
	aggregateSnapshot(): { active: number; loading: number } {
		let active = 0;
		let loading = 0;
		for (const worker of this.workers.values()) {
			const current = worker.current;
			const stats = worker.statsSnapshot as {
				active?: number;
				paused?: number;
				ended?: number;
				error?: number;
				destroyed?: number;
				total?: number;
				bySource?: Record<string, number>;
			} | null;
			if (current) active++;
			if (stats && typeof stats.active === "number") active += stats.active;
			if (stats && typeof (stats as any).loading === "number") loading += (stats as any).loading;
		}
		return { active, loading };
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}
}
