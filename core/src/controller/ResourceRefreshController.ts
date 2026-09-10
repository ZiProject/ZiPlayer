import type { AudioResource, StreamType } from "@discordjs/voice";
import type { PlayerBus, PlayerInput } from "../structures/PlayerBus";
import type { PlayerBusRpcContext } from "../types";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackSessionSnapshot, StreamInfo, Track } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";
import type { ResourceRefreshControllerOptions } from "../types";

/** Owns resource refresh workflow and bridges Player refresh requests to it. */
export class ResourceRefreshController {
	private readonly detach: () => void;
	private readonly detachRpc: () => void;
	private readonly bus: PlayerBus;
	private readonly getSession: ResourceRefreshControllerOptions["getSession"];
	private readonly lifecycleAbort = new AbortController();
	private refreshSequence = 0;
	private refreshAbortController: AbortController | null = null;
	private disposed = false;

	constructor(options: ResourceRefreshControllerOptions) {
		this.bus = options.bus;
		this.getSession = options.getSession;
		this.detachRpc = this.bus.registerRpc<{ position: number }, PlaybackSessionSnapshot>(
			"playback.refreshResource",
			({ position }, context) => this.refreshResource(position, context),
		);
		this.detach = options.bus.onInput("[Player]->[Resource]:refresh", (event) => {
			void this.handleRefresh(event);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.refreshSequence++;
		this.refreshAbortController?.abort();
		this.refreshAbortController = null;
		this.detachRpc();
		this.detach();
	}

	private async refreshResource(position: number, rpcContext: PlayerBusRpcContext): Promise<PlaybackSessionSnapshot> {
		const session = this.getSession();
		if (this.disposed || !session?.track || !session.isActive()) throw new Error("No active playback session");
		const sessionId = session.id;
		const refreshSequence = ++this.refreshSequence;
		if (this.refreshAbortController) {
			this.refreshAbortController.abort();
			if (!this.disposed) this.bus.requestRpcSync(CONTROLLER_RPC.playbackEndResourceRefresh, {});
		}
		const refreshAbortController = new AbortController();
		this.refreshAbortController = refreshAbortController;
		this.bus.requestRpcSync(CONTROLLER_RPC.playbackBeginResourceRefresh, {});
		const signal = AbortSignal.any([rpcContext.signal, refreshAbortController.signal, this.lifecycleAbort.signal]);
		const isCurrentRefresh = () =>
			!this.disposed &&
			refreshSequence === this.refreshSequence &&
			!signal.aborted &&
			this.getSession()?.owns(sessionId) === true;
		try {
			const info = await this.bus.requestRpc<{ track: Track; fresh?: boolean }, StreamInfo | null>(
				"stream.resolve",
				{ track: session.track, fresh: true },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!info?.stream && !info?.url && !info?.recreate) throw new Error("No stream available for resource refresh");
			if (info.remote) throw new Error("Cannot refresh a remote playback resource");
			await this.bus.action({ type: "FILTER_SET_SOURCE_TYPE", streamType: info.type ?? "arbitrary" }, { signal });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo: info, position: Math.max(0, position) }, { signal });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const processed = await this.bus.query("filteredStream");
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!processed) throw new Error("Playback resource controllers are unavailable");
			const active = await this.bus.requestRpc<
				{ streamInfo: StreamInfo; session: PlaybackSession },
				import("../types").ActiveStream
			>("controller.stream.replace", { streamInfo: processed, session });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const resource = this.bus.requestRpcSync<
				{ stream: import("stream").Readable; track: Track; inputType?: StreamType },
				AudioResource
			>("resource.create", { stream: active.stream, track: session.track, inputType: active.inputType });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			session.setResource(resource);
			session.setPlaybackOffset(Math.max(0, position));
			this.bus.requestRpcSync(CONTROLLER_RPC.playbackPlay, { resource, session });
			session.markPlaying(Math.max(0, position));
			this.bus.event({ type: "playbackStateChanged", session: session.snapshot() });
			return session.snapshot();
		} finally {
			if (!this.disposed && isCurrentRefresh()) {
				this.bus.requestRpcSync(CONTROLLER_RPC.playbackEndResourceRefresh, {});
				this.refreshAbortController = null;
			}
		}
	}

	private async handleRefresh(event: Extract<PlayerInput, { type: "[Player]->[Resource]:refresh" }>): Promise<void> {
		const { bus } = this;
		try {
			const session = await bus.requestRpc(
				"playback.refreshResource",
				{ position: event.position ?? 0 },
				{ signal: this.lifecycleAbort.signal },
			);
			if (this.disposed) return;
			bus.emitOutput({ type: "[Resource]->[Player]:refreshed", requestId: event.requestId, session });
		} catch (error) {
			if (this.disposed || this.lifecycleAbort.signal.aborted) return;
			bus.emitOutput({
				type: "[Resource]->[Player]:error",
				requestId: event.requestId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}
