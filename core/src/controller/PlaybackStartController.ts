import type { AudioResource } from "@discordjs/voice";
import type { Bus } from "../structures/Bus";
import { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import { CONTROLLER_RPC } from "../structures/BusContract";
import type { PlayerMessageContext, StreamInfo, Track, TrackLoadResult } from "../types";
import type { PlaybackStartControllerOptions } from "../types";

/**
 * Owns loading and starting one playback session through the Bus.
 *
 * Per-player worker — created by the shared `PlaybackOrchestrator` in `attach(playerId, ...)`
 * and discarded in `detach(playerId)`. Registers no RPC of its own: `playback.start` is
 * registered exactly once, in `PlaybackOrchestrator`'s constructor, and routed to the right
 * worker via `ctx.playerId`.
 */
export class PlaybackStartController {
	private readonly bus: Bus;
	private readonly playerId: string;
	private readonly sessionController: PlaybackSessionController;
	private readonly transitionEnabled: PlaybackStartControllerOptions["transitionEnabled"];
	private readonly stopPlayback: PlaybackStartControllerOptions["stopPlayback"];
	private readonly prepareTrack: PlaybackStartControllerOptions["prepareTrack"];
	private readonly adapters: PlaybackStartControllerOptions["adapters"];

	constructor(playerId: string, options: PlaybackStartControllerOptions) {
		this.playerId = playerId;
		this.bus = options.bus;
		this.sessionController = options.sessionController;
		this.transitionEnabled = options.transitionEnabled;
		this.stopPlayback = options.stopPlayback;
		this.prepareTrack = options.prepareTrack;
		this.adapters = options.adapters;
	}

	public dispose(): void {
		// No module-level registration to release; kept for a uniform worker lifecycle API.
	}

	public async start(track: Track, parentContext: PlayerMessageContext, from: Track | null = null): Promise<void> {
		if (parentContext.signal.aborted) return;
		const hasPreload =
			this.bus.hasRpc(CONTROLLER_RPC.preloadHas) ?
				this.bus.requestRpcSync<{ track: Track }, boolean>(this.playerId, CONTROLLER_RPC.preloadHas, { track })
			:	(this.adapters?.hasPreload?.(track) ?? false);
		const transition = this.transitionEnabled();
		if (!transition) this.stopPlayback(parentContext.signal, !hasPreload);

		this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.trackResetRecovery, {});

		const session = this.sessionController.replace(this.playerId, track, { destroyPrevious: !transition });
		const context = this.childContext(parentContext, session.sessionId, session.signal);
		await this.setCurrentThroughBus(track, context);
		this.bus.event(this.playerId, { type: "TRACK_LOADING", session: session.snapshot() });
		this.bus.event(this.playerId, { type: "willPlay", track, upcomingTracks: this.queueSnapshot() });

		try {
			const loaded = await this.bus.requestRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				this.playerId,
				CONTROLLER_RPC.trackLoadWithRecovery,
				{ track, session },
				{ signal: context.signal },
			);
			if (!loaded) throw new Error("Track loader is unavailable");
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			this.bus.event(this.playerId, { type: "TRACK_LOADED", session: session.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle?.play) {
				session.setResource(null);
				await loaded.stream.handle.play();
				session.markPlaying(0);
				this.bus.event(this.playerId, { type: "TRACK_STARTED", session: session.snapshot(), track });
				await this.prepareTrack(session, context);
				return;
			}

			const filterString = await this.bus.query(this.playerId, "filterString");
			let activeStream = loaded.stream;
			if (filterString) {
				const filtered = await this.filterStreamThroughBus(loaded.stream, 0, context);
				if (!filtered?.stream) throw new Error("Filter controller produced no stream");
				activeStream = filtered;
			}
			const active = await this.bus.requestRpc<
				{ streamInfo: StreamInfo; session: PlaybackSession },
				import("../types").ActiveStream
			>(this.playerId, CONTROLLER_RPC.streamReplace, { streamInfo: activeStream, session });
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			const resource = this.bus.requestRpcSync<
				{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
				AudioResource
			>(this.playerId, CONTROLLER_RPC.resourceCreate, {
				stream: active.stream,
				track,
				inputType: active.inputType ?? activeStream.inputType,
			});
			session.setResource(resource);
			this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.playbackPlay, { resource, session, from, to: track });
			session.markPlaying(0);
			if (transition) this.sessionController.retirePendingPrevious(this.playerId);
			this.bus.event(this.playerId, { type: "TRACK_STARTED", session: session.snapshot(), track });
			await this.prepareTrack(session, context);
		} catch (error) {
			if (transition) this.sessionController.retirePendingPrevious(this.playerId);
			if (!context.signal.aborted && this.isCurrentSession(session, context)) {
				this.bus.event(this.playerId, {
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private isCurrentSession(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return this.sessionController.current(this.playerId) === session && session.ownsContext(context.sessionId);
	}

	private queueSnapshot(): Track[] {
		return this.bus.querySync(this.playerId, "queue") ?? [];
	}

	private childContext(context: PlayerMessageContext, sessionId: string, sessionSignal: AbortSignal): PlayerMessageContext {
		return {
			playerId: context.playerId,
			requestId: context.requestId,
			sessionId,
			source: context.source,
			signal: AbortSignal.any([context.signal, sessionSignal]),
			timestamp: context.timestamp,
			priority: context.priority,
		};
	}

	private async setCurrentThroughBus(track: Track | null, context: PlayerMessageContext): Promise<void> {
		if (!context.signal.aborted)
			await this.bus.action(this.playerId, { type: "QUEUE_SET_CURRENT", track, requestId: context.requestId }, context);
	}

	private async filterStreamThroughBus(
		streamInfo: StreamInfo,
		position: number,
		context: PlayerMessageContext,
	): Promise<StreamInfo | null> {
		if (context.signal.aborted) return null;
		await this.bus.action(
			this.playerId,
			{ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId },
			context,
		);
		await this.bus.action(
			this.playerId,
			{ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: context.requestId },
			context,
		);
		return this.bus.query(this.playerId, "filteredStream");
	}
}
