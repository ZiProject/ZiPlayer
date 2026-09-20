import type { AudioResource, StreamType } from "@discordjs/voice";
import type { Bus, PlayerInput } from "../structures/Bus";
import type { BusRpcContext } from "../types";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackSessionSnapshot, StreamInfo, Track } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Per-player resource-refresh workflow. Owned by the shared `ResourceRefreshController`
 *  below, one instance per active player, talking to the shared bus through a
 *  player-scoped `Bus` facade. */
class ResourceRefreshWorker {
	private readonly lifecycleAbort = new AbortController();
	private refreshSequence = 0;
	private refreshAbortController: AbortController | null = null;
	private disposed = false;

	constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.refreshSequence++;
		this.refreshAbortController?.abort();
		this.refreshAbortController = null;
	}

	async refreshResource(position: number, rpcContext: BusRpcContext): Promise<PlaybackSessionSnapshot> {
		const session = this.bus.querySync(this.playerId, "playbackSessionInternal");
		if (this.disposed || !session?.track || !session.isActive()) throw new Error("No active playback session");
		const sessionId = session.id;
		const refreshSequence = ++this.refreshSequence;
		if (this.refreshAbortController) {
			this.refreshAbortController.abort();
			if (!this.disposed) this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackEndResourceRefresh, {});
		}
		const refreshAbortController = new AbortController();
		this.refreshAbortController = refreshAbortController;
		this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackBeginResourceRefresh, {});
		const signal = AbortSignal.any([rpcContext.signal, refreshAbortController.signal, this.lifecycleAbort.signal]);
		const isCurrentRefresh = () =>
			!this.disposed &&
			refreshSequence === this.refreshSequence &&
			!signal.aborted &&
			this.bus.querySync(this.playerId, "playbackSessionInternal")?.owns(sessionId) === true;
		try {
			const info = await this.bus.requestRpc<{ track: Track; fresh?: boolean }, StreamInfo | null>(
				this.playerId,
				"stream.resolve",
				{ track: session.track, fresh: true },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!info?.stream && !info?.url && !info?.recreate) throw new Error("No stream available for resource refresh");
			if (info.remote) throw new Error("Cannot refresh a remote playback resource");
			await this.bus.action(this.playerId, { type: "FILTER_SET_SOURCE_TYPE", streamType: info.type ?? "arbitrary" }, { signal });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			await this.bus.action(
				this.playerId,
				{ type: "FILTER_APPLY_AND_SEEK", streamInfo: info, position: Math.max(0, position) },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const processed = await this.bus.query(this.playerId, "filteredStream");
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!processed) throw new Error("Playback resource controllers are unavailable");
			const active = await this.bus.requestRpc<
				{ streamInfo: StreamInfo; session: PlaybackSession },
				import("../types").ActiveStream
			>(this.playerId, "controller.stream.replace", { streamInfo: processed, session });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const resource = this.bus.requestRpcSync<
				{ stream: import("stream").Readable; track: Track; inputType?: StreamType },
				AudioResource
			>(this.playerId, "resource.create", { stream: active.stream, track: session.track, inputType: active.inputType });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			session.setResource(resource);
			session.setPlaybackOffset(Math.max(0, position));
			this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackPlay, { resource, session });
			session.markPlaying(Math.max(0, position));
			this.bus.event(this.playerId, { type: "playbackStateChanged", session: session.snapshot() });
			return session.snapshot();
		} finally {
			if (!this.disposed && isCurrentRefresh()) {
				this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackEndResourceRefresh, {});
				this.refreshAbortController = null;
			}
		}
	}

	async handleRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		const { bus } = this;
		try {
			const session = await bus.requestRpc(
				this.playerId,
				"playback.refreshResource",
				{ position: event.position ?? 0 },
				{ signal: this.lifecycleAbort.signal },
			);
			if (this.disposed) return;
			bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, playerId: this.playerId, session });
		} catch (error) {
			if (this.disposed || this.lifecycleAbort.signal.aborted) return;
			bus.emitOutput({
				type: "[Resource]->[Player]:error",
				requestId: event.requestId,
				playerId: this.playerId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}

/** Shared, singleton controller: owns the resource-refresh workflow and bridges Player
 *  refresh requests for every player, keyed by playerId. */
export class ResourceRefreshController {
	private readonly workers = new Map<string, ResourceRefreshWorker>();

	constructor(private readonly bus: Bus) {
		bus.registerRpc<{ position: number }, PlaybackSessionSnapshot>("playback.refreshResource", ({ position }, context) => {
			const worker = this.workers.get(context.playerId);
			if (!worker) throw new Error("No active playback session");
			return worker.refreshResource(position, context);
		});
		bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.workers.get(event.playerId)?.handleRefresh(event);
		});
	}

	attach(playerId: string): void {
		this.workers.set(playerId, new ResourceRefreshWorker(this.bus, playerId));
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}
}
