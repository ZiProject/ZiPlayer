import { PlaybackMode, type StreamInfo, type Track, type ActiveStream, type StreamControllerOptions } from "../types";
import { Readable } from "stream";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { StreamManager } from "../structures/StreamManager";
import type { Bus } from "../structures/Bus";
import { CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC, BUS_EVENT } from "../structures/BusContract";

const STREAM_RPC_REPLACE = "controller.stream.replace";

interface StreamState {
	active: ActiveStream | null;
	remoteHandle: NonNullable<StreamInfo["handle"]> | null;
	remotePaused: boolean;
	streamManager?: StreamManager;
	detachStreamError?: () => void;
}

/** Shared stream controller with active and remote stream state isolated by playerId. */
export class StreamController {
	public readonly states = new Map<string, StreamState>();

	constructor(private readonly bus: Bus) {
		bus.onAction((action, context) => {
			if (context.signal.aborted || action.type !== "STOP") return;
			const state = this.states.get(context.playerId);
			if (!state) return;
			this.abortCurrent(context.playerId, state);
			void this.remoteStop(state);
		});
		bus.registerRpc<{ track?: Track; stream: StreamInfo }, boolean>(
			CONTROLLER_RPC.playbackRemote,
			async ({ track, stream }, ctx) => {
				const state = this.states.get(ctx.playerId);
				if (!state) return false;
				const ok = await this.handleRemote(ctx.playerId, state, stream);
				if (ok && track) {
					bus.requestRpcSync(ctx.playerId, PLAYER_RPC.queueSetCurrent, { track });
					bus.event(ctx.playerId, { type: BUS_EVENT.trackStarted, session: null as any, track });
				}
				return ok;
			},
		);
		bus.registerRpc<{ stream: StreamInfo }, boolean>(CONTROLLER_RPC.playbackRemoteAttach, ({ stream }, ctx) => {
			const state = this.states.get(ctx.playerId);
			return state ? this.handleRemote(ctx.playerId, state, stream) : false;
		});
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackRemotePause, (_req, ctx) =>
			this.remotePause(this.states.get(ctx.playerId)),
		);
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackRemoteResume, (_req, ctx) =>
			this.remoteResume(this.states.get(ctx.playerId)),
		);
		bus.registerRpc<void, boolean>(CONTROLLER_RPC.playbackRemoteStop, (_req, ctx) =>
			this.remoteStop(this.states.get(ctx.playerId)),
		);
		bus.registerRpc<{ position: number }, boolean>(CONTROLLER_RPC.playbackRemoteSeek, ({ position }, ctx) =>
			this.remoteSeek(this.states.get(ctx.playerId), position),
		);
		bus.registerRpc<{ volume: number }, boolean>(CONTROLLER_RPC.playbackRemoteSetVolume, ({ volume }, ctx) =>
			this.remoteSetVolume(this.states.get(ctx.playerId), volume),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.playbackExitRemote, (_req, ctx) => {
			const state = this.states.get(ctx.playerId);
			if (state) this.exitRemote(ctx.playerId, state);
		});
		bus.registerQuery(PLAYER_QUERY.remotePaused, (playerId) => this.states.get(playerId)?.remotePaused ?? false);
		bus.registerRpc<void, void>(CONTROLLER_RPC.playbackDestroyCurrentStream, (_req, ctx) => {
			const state = this.states.get(ctx.playerId);
			if (state) this.abortCurrent(ctx.playerId, state);
		});
		bus.registerRpc<{ streamInfo: StreamInfo; session: PlaybackSession }, ActiveStream>(
			STREAM_RPC_REPLACE,
			({ streamInfo, session }, ctx) => {
				const state = this.states.get(ctx.playerId);
				if (!state) throw new Error("StreamController is disposed");
				return this.replace(ctx.playerId, state, streamInfo, session);
			},
		);
		bus.registerQuery(PLAYER_QUERY.streamStats, (playerId) => this.states.get(playerId)?.streamManager?.getStats() ?? null);
		bus.registerQuery(PLAYER_QUERY.streamState, (playerId) => this.stateSnapshot(this.states.get(playerId)));
		bus.registerQuery(PLAYER_QUERY.streamCurrent, (playerId) => this.states.get(playerId)?.active ?? null);
		bus.registerRpc(PLAYER_RPC.streamState, (_req, ctx) => this.stateSnapshot(this.states.get(ctx.playerId)));
		bus.registerRpc(PLAYER_RPC.streamCurrent, (_req, ctx) => this.states.get(ctx.playerId)?.active ?? null);
	}

	attach(playerId: string, streamManager?: StreamManager): void {
		this.detach(playerId);
		const state: StreamState = { active: null, remoteHandle: null, remotePaused: false, streamManager };
		if (streamManager) {
			const onStreamError = ({ error }: { error: Error }) =>
				this.bus.event(playerId, {
					type: BUS_EVENT.streamError,
					error,
					track: this.bus.querySync(playerId, PLAYER_QUERY.currentTrack) as Track | null,
				});
			streamManager.on("streamError", onStreamError);
			state.detachStreamError = () => streamManager.off("streamError", onStreamError);
		}
		this.states.set(playerId, state);
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.detachStreamError?.();
		this.abortCurrent(playerId, state);
		this.exitRemote(playerId, state);
		state.active = null;
		state.streamManager?.dispose();
		state.streamManager = undefined;
	}

	/** Resolves stream information using this player's active playback session. */
	public resolve(playerId: string, info: StreamInfo, session: PlaybackSession): Promise<Readable> {
		if (!this.states.has(playerId)) throw new Error("StreamController is disposed");
		return this.resolveInfo(info, session);
	}

	aggregateSnapshot(): { active: number; loading: number } {
		let active = 0;
		let loading = 0;
		for (const state of this.states.values()) {
			if (state.active) active++;
			const stats = state.streamManager?.getStats() as {
				active?: number;
				loading?: number;
			} | null;
			if (stats && typeof stats.active === "number") active += stats.active;
			if (stats && typeof stats.loading === "number") loading += stats.loading;
		}
		return { active, loading };
	}

	public getStreamManager(playerId: string): StreamManager | undefined {
		return this.states.get(playerId)?.streamManager;
	}

	public has(playerId: string): boolean {
		return this.states.has(playerId);
	}

	private stateSnapshot(state?: StreamState): { sessionId: number; track: Track } | null {
		return state?.active ? { sessionId: state.active.sessionId, track: state.active.track } : null;
	}

	private async handleRemote(
		playerId: string,
		state: StreamState,
		stream: { handle?: NonNullable<StreamInfo["handle"]> },
	): Promise<boolean> {
		state.remoteHandle = stream?.handle ?? null;
		state.remotePaused = false;
		if (this.bus.hasRpc(CONTROLLER_RPC.playbackModeSet)) {
			this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackModeSet, { mode: PlaybackMode.REMOTE });
		}
		if (stream?.handle?.play) await stream.handle.play();
		return true;
	}

	private exitRemote(playerId: string, state: StreamState): void {
		const handle = state.remoteHandle;
		if (!handle && !state.remotePaused) return;
		state.remoteHandle = null;
		state.remotePaused = false;
		if (this.bus.hasRpc(CONTROLLER_RPC.playbackModeSet)) {
			this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackModeSet, { mode: PlaybackMode.NATIVE });
		}
		if (handle?.destroy) void handle.destroy().catch(() => {});
	}

	private remotePause(state?: StreamState): boolean {
		if (!state?.remoteHandle) return false;
		state.remotePaused = true;
		void state.remoteHandle.pause().catch(() => {});
		return true;
	}

	private remoteResume(state?: StreamState): boolean {
		if (!state?.remoteHandle) return false;
		state.remotePaused = false;
		void state.remoteHandle.resume().catch(() => {});
		return true;
	}

	private remoteStop(state?: StreamState): boolean {
		if (!state) return false;
		state.remotePaused = false;
		if (state.remoteHandle) void state.remoteHandle.stop().catch(() => {});
		return true;
	}

	private async remoteSeek(state: StreamState | undefined, position: number): Promise<boolean> {
		if (!state?.remoteHandle) return false;
		try {
			await state.remoteHandle.seek(position);
			return true;
		} catch {
			return false;
		}
	}

	private async remoteSetVolume(state: StreamState | undefined, volume: number): Promise<boolean> {
		if (!state?.remoteHandle) return false;
		try {
			await state.remoteHandle.setVolume(volume);
			return true;
		} catch {
			return false;
		}
	}

	private async resolveInfo(info: StreamInfo, session: PlaybackSession): Promise<Readable> {
		if (!session.isActive()) throw this.abortError();
		if (info.stream && !info.stream.destroyed && (info.stream as any).readable !== false) return info.stream;

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

	private async replace(playerId: string, state: StreamState, info: StreamInfo, session: PlaybackSession): Promise<ActiveStream> {
		const stream = await this.resolveInfo(info, session);
		if (!session.isActive()) {
			stream.destroy();
			throw this.abortError();
		}
		this.abortCurrent(playerId, state);
		const streamId = state.streamManager?.registerStream(stream, session.track!, {
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
		state.active = active;
		const cleanup = () => {
			if (state.active?.sessionId !== session.id || state.active.stream !== stream) return;
			state.active = null;
			if (streamId) state.streamManager?.unregisterStream(streamId, false);
		};
		stream.once("close", cleanup);
		stream.once("end", cleanup);
		stream.once("error", cleanup);
		session.signal.addEventListener("abort", () => this.abort(playerId, state, active), { once: true });
		return active;
	}

	private abortCurrent(playerId: string, state: StreamState): void {
		if (state.active) this.abort(playerId, state, state.active);
	}

	private abort(playerId: string, state: StreamState, active: ActiveStream): void {
		if (state.active?.stream !== active.stream) return;
		state.active = null;
		this.bus.event(playerId, { type: BUS_EVENT.streamAborted, session: active.session.snapshot() });
		if (active.streamId) {
			state.streamManager?.unregisterStream(active.streamId, true);
			return;
		}
		if (!active.stream.destroyed) {
			try {
				active.stream.destroy();
			} catch {}
		}
	}

	private isAbortError(error: unknown): boolean {
		return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
	}

	private abortError(): Error {
		const error = new Error("Playback stream operation was aborted");
		error.name = "AbortError";
		return error;
	}
}
