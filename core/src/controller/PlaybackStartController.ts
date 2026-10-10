import type { AudioResource } from "@discordjs/voice";
import type { Bus } from "../structures/Bus";
import { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import { CONTROLLER_RPC, PLAYER_ACTION, BUS_EVENT, PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";
import { PlaybackMode, type PlayerMessageContext, type StreamInfo, type Track, type TrackLoadResult } from "../types";
import type { PlaybackStartControllerOptions } from "../types";

/**
 * Owns loading and starting one playback session through the Bus.
 *
 * Per-player controller instance held by the shared `PlaybackOrchestrator` state for
 * `playerId`. Registers no RPC of its own: `playback.start` is registered once in the
 * orchestrator and routed by `ctx.playerId`.
 */
export class PlaybackStartController {
	private readonly bus: Bus;
	private readonly playerId: string;
	private readonly sessionController: PlaybackSessionController;
	private readonly transitionEnabled: PlaybackStartControllerOptions["transitionEnabled"];
	private readonly stopPlayback: PlaybackStartControllerOptions["stopPlayback"];
	private readonly prepareTrack: PlaybackStartControllerOptions["prepareTrack"];
	private readonly adapters: PlaybackStartControllerOptions["adapters"];
	private consecutiveFailures = 0;

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
		// No module-level registration to release; kept for a uniform per-player lifecycle API.
	}

	public async start(track: Track, parentContext: PlayerMessageContext, from: Track | null = null): Promise<void> {
		if (parentContext.signal.aborted) return;
		const hasPreload =
			this.bus.hasRpc(CONTROLLER_RPC.preloadHas) ?
				this.bus.requestRpcSync<{ track: Track }, boolean>(this.playerId, CONTROLLER_RPC.preloadHas, { track })
			:	(this.adapters?.hasPreload?.(track) ?? false);
		const transition = this.transitionEnabled();
		if (!transition) await this.stopPlayback(parentContext.signal, !hasPreload);

		this.bus.requestRpcSync(this.playerId, CONTROLLER_RPC.trackResetRecovery, {});

		const session = this.sessionController.replace(this.playerId, track, { destroyPrevious: !transition });
		const context = this.childContext(parentContext, session.sessionId, session.signal);
		await this.setCurrentThroughBus(track, context);
		this.bus.event(this.playerId, { type: BUS_EVENT.trackLoading, session: session.snapshot() });

		try {
			const loaded = await this.bus.requestRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				this.playerId,
				CONTROLLER_RPC.trackLoadWithRecovery,
				{ track, session },
				{ signal: context.signal },
			);
			if (!loaded) throw new Error("Track loader is unavailable");
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			this.bus.event(this.playerId, { type: BUS_EVENT.trackLoaded, session: session.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle?.play) {
				session.setResource(null);
				await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackRemoteAttach, { stream: loaded.stream });
				session.markPlaying(0);
				this.consecutiveFailures = 0;
				this.bus.event(this.playerId, { type: BUS_EVENT.trackStarted, session: session.snapshot(), track });
				await this.prepareTrack(session, context);
				return;
			}

			const currentMode = this.bus.querySync(this.playerId, PLAYER_QUERY.playbackMode);
			if (currentMode === PlaybackMode.REMOTE && this.bus.hasRpc(PLAYER_RPC.playbackExitRemote)) {
				await this.bus.requestRpc(this.playerId, PLAYER_RPC.playbackExitRemote, undefined);
			}

			const filterString = await this.bus.query(this.playerId, PLAYER_QUERY.filterString);
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
			const resource = await this.bus.requestRpc<
				{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
				AudioResource
			>(
				this.playerId,
				CONTROLLER_RPC.resourceCreate,
				{
					stream: active.stream,
					track,
					inputType: active.inputType ?? activeStream.inputType,
				},
				{ signal: context.signal },
			);
			if (context.signal.aborted || !this.isCurrentSession(session, context)) {
				return;
			}
			session.setResource(resource);
			await this.bus.requestRpc(
				this.playerId,
				CONTROLLER_RPC.playbackPlay,
				{ resource, session, from, to: track },
				{ signal: context.signal },
			);
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			session.markPlaying(0);
			this.consecutiveFailures = 0;
			if (transition) this.sessionController.retirePendingPrevious(this.playerId);
			this.bus.event(this.playerId, { type: BUS_EVENT.trackStarted, session: session.snapshot(), track });
			await this.prepareTrack(session, context);
		} catch (error) {
			if (transition) this.sessionController.retirePendingPrevious(this.playerId);
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (context.signal.aborted) throw error;
			if (!context.signal.aborted && this.isCurrentSession(session, context)) {
				this.bus.event(this.playerId, {
					type: BUS_EVENT.trackError,
					session: session.snapshot(),
					error: normalized,
				});
			}
			this.consecutiveFailures++;
			const controlledSkipThreshold = 3;
			if (this.consecutiveFailures >= controlledSkipThreshold) {
				this.consecutiveFailures = 0;
				this.bus.event(this.playerId, { type: BUS_EVENT.queueEnd });
				if (this.bus.hasRpc(PLAYER_RPC.lifecycleScheduleLeave)) {
					void this.bus
						.requestRpc(this.playerId, PLAYER_RPC.lifecycleScheduleLeave, {})
						.catch((reportError) => this.reportStreamError(track, reportError));
				}
			} else if (!parentContext.signal.aborted) {
				void this.bus
					.action(
						this.playerId,
						{ type: PLAYER_ACTION.skip, ignoreLoop: true, requestId: parentContext.requestId },
						parentContext,
					)
					.catch((reportError) => this.reportStreamError(track, reportError));
			}
			throw error;
		}
	}

	private reportStreamError(track: Track, error: unknown): void {
		try {
			this.bus.event(this.playerId, {
				type: BUS_EVENT.streamError,
				error: error instanceof Error ? error : new Error(String(error)),
				track,
			});
		} catch (reportError) {
			console.error("Failed to report playback stream error", reportError);
		}
	}

	private isCurrentSession(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return this.sessionController.current(this.playerId) === session && session.ownsContext(context.sessionId);
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
			await this.bus.action(this.playerId, { type: PLAYER_ACTION.queueSetCurrent, track, requestId: context.requestId }, context);
	}

	private async filterStreamThroughBus(
		streamInfo: StreamInfo,
		position: number,
		context: PlayerMessageContext,
	): Promise<StreamInfo | null> {
		if (context.signal.aborted) return null;
		await this.bus.action(
			this.playerId,
			{ type: PLAYER_ACTION.filterSetSourceType, streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId },
			context,
		);
		await this.bus.action(
			this.playerId,
			{ type: PLAYER_ACTION.filterApplyAndSeek, streamInfo, position, requestId: context.requestId },
			context,
		);
		return this.bus.query(this.playerId, PLAYER_QUERY.filteredStream);
	}
}
