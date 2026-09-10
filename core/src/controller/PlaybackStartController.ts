import type { AudioResource } from "@discordjs/voice";
import type { PlayerBus } from "../structures/PlayerBus";
import { PlaybackSession } from "../structures/PlaybackSession";
import { CONTROLLER_RPC } from "./ControllerBusContract";
import type { PlayerMessageContext, StreamInfo, Track, TrackLoadResult } from "../types";
import type { PlaybackStartControllerOptions } from "../types";

/** Owns loading and starting one playback session through the Bus. */
export class PlaybackStartController {
	private readonly bus: PlayerBus;
	private readonly getSession: PlaybackStartControllerOptions["getSession"];
	private readonly setSession: PlaybackStartControllerOptions["setSession"];
	private readonly transitionEnabled: PlaybackStartControllerOptions["transitionEnabled"];
	private readonly stopPlayback: PlaybackStartControllerOptions["stopPlayback"];
	private readonly prepareTrack: PlaybackStartControllerOptions["prepareTrack"];

	constructor(options: PlaybackStartControllerOptions) {
		this.bus = options.bus;
		this.getSession = options.getSession;
		this.setSession = options.setSession;
		this.transitionEnabled = options.transitionEnabled;
		this.stopPlayback = options.stopPlayback;
		this.prepareTrack = options.prepareTrack;
	}

	public async start(track: Track, parentContext: PlayerMessageContext, from: Track | null = null): Promise<void> {
		if (parentContext.signal.aborted) return;
		const hasPreload = this.bus.requestRpcSync<{ track: Track }, boolean>(CONTROLLER_RPC.preloadHas, { track });
		if (!this.transitionEnabled()) this.stopPlayback(parentContext.signal, !hasPreload);

		const previousSession = this.getSession();
		if (previousSession) {
			previousSession.markStopped();
			previousSession.destroy();
		}
		this.bus.requestRpcSync(CONTROLLER_RPC.trackResetRecovery, {});

		const session = new PlaybackSession();
		session.begin(track);
		this.setSession(session);
		const context = this.childContext(parentContext, session.sessionId, session.signal);
		await this.setCurrentThroughBus(track, context);
		this.bus.event({ type: "TRACK_LOADING", session: session.snapshot() });
		this.bus.event({ type: "willPlay", track, upcomingTracks: this.queueSnapshot() });

		try {
			const loaded = await this.bus.requestRpc<{ track: Track; session: PlaybackSession }, TrackLoadResult>(
				CONTROLLER_RPC.trackLoadWithRecovery,
				{ track, session },
				{ signal: context.signal },
			);
			if (!loaded) throw new Error("Track loader is unavailable");
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			this.bus.event({ type: "TRACK_LOADED", session: session.snapshot() });
			if (loaded.stream.remote && loaded.stream.handle?.play) {
				session.setResource(null);
				await loaded.stream.handle.play();
				session.markPlaying(0);
				this.bus.event({ type: "TRACK_STARTED", session: session.snapshot(), track });
				await this.prepareTrack(session, context);
				return;
			}

			const filterString = await this.bus.query("filterString");
			let activeStream = loaded.stream;
			if (filterString) {
				const filtered = await this.filterStreamThroughBus(loaded.stream, 0, context);
				if (!filtered?.stream) throw new Error("Filter controller produced no stream");
				activeStream = filtered;
			}
			const active = await this.bus.requestRpc<
				{ streamInfo: StreamInfo; session: PlaybackSession },
				import("../types").ActiveStream
			>(CONTROLLER_RPC.streamReplace, { streamInfo: activeStream, session });
			if (context.signal.aborted || !this.isCurrentSession(session, context)) return;
			const resource = this.bus.requestRpcSync<
				{ stream: import("stream").Readable; track: Track; inputType?: import("@discordjs/voice").StreamType },
				AudioResource
			>(CONTROLLER_RPC.resourceCreate, { stream: active.stream, track, inputType: active.inputType ?? activeStream.inputType });
			session.setResource(resource);
			this.bus.requestRpcSync(CONTROLLER_RPC.playbackPlay, { resource, session, from, to: track });
			session.markPlaying(0);
			this.bus.event({ type: "TRACK_STARTED", session: session.snapshot(), track });
			await this.prepareTrack(session, context);
		} catch (error) {
			if (!context.signal.aborted && this.isCurrentSession(session, context)) {
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
	}

	private isCurrentSession(session: PlaybackSession, context: PlayerMessageContext): boolean {
		return this.getSession() === session && session.ownsContext(context.sessionId);
	}

	private queueSnapshot(): Track[] {
		return this.bus.querySync("queue") ?? [];
	}

	private childContext(context: PlayerMessageContext, sessionId: string, sessionSignal: AbortSignal): PlayerMessageContext {
		return {
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
			await this.bus.action({ type: "QUEUE_SET_CURRENT", track, requestId: context.requestId }, context);
	}

	private async filterStreamThroughBus(
		streamInfo: StreamInfo,
		position: number,
		context: PlayerMessageContext,
	): Promise<StreamInfo | null> {
		if (context.signal.aborted) return null;
		await this.bus.action(
			{ type: "FILTER_SET_SOURCE_TYPE", streamType: streamInfo.type ?? "arbitrary", requestId: context.requestId },
			context,
		);
		await this.bus.action({ type: "FILTER_APPLY_AND_SEEK", streamInfo, position, requestId: context.requestId }, context);
		return this.bus.query("filteredStream");
	}
}
