import type { AudioResource, StreamType } from "@discordjs/voice";
import type { Bus, PlayerInput } from "../structures/Bus";
import type { BusRpcContext } from "../types";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlaybackSessionSnapshot, StreamInfo, Track } from "../types";
import {
	BUS_OUTPUT,
	BUS_REQUEST,
	CONTROLLER_RPC,
	PLAYER_QUERY,
	PLAYER_RPC,
	BUS_EVENT,
	traceBusSignal,
} from "../structures/BusContract";

interface ResourceRefreshState {
	lifecycleAbort: AbortController;
	refreshSequence: number;
	refreshAbortController: AbortController | null;
}

/** Shared resource-refresh controller with transient state isolated by playerId. */
export class ResourceRefreshController {
	private readonly states = new Map<string, ResourceRefreshState>();

	constructor(
		private readonly bus: Bus,
		private readonly debug?: (message: string) => void,
	) {
		bus.registerRpc<{ position: number }, PlaybackSessionSnapshot>(
			PLAYER_RPC.playbackRefreshResource,
			({ position }, context) => {
				if (!this.states.has(context.playerId)) throw new Error("No active playback session");
				return this.refreshResource(context.playerId, position, context);
			},
		);
		bus.onInput(BUS_REQUEST.resourceRefresh, (event) => {
			void this.handleRefresh(event.playerId, event);
		});
	}

	attach(playerId: string): void {
		this.detach(playerId);
		this.states.set(playerId, {
			lifecycleAbort: new AbortController(),
			refreshSequence: 0,
			refreshAbortController: null,
		});
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.lifecycleAbort.abort();
		state.refreshSequence++;
		state.refreshAbortController?.abort();
		state.refreshAbortController = null;
	}

	private async refreshResource(playerId: string, position: number, rpcContext: BusRpcContext): Promise<PlaybackSessionSnapshot> {
		const state = this.states.get(playerId);
		const session = this.bus.querySync(playerId, PLAYER_QUERY.playbackSessionInternal);
		if (!state || !session?.track || !session.isActive()) throw new Error("No active playback session");
		const sessionId = session.id;
		const refreshSequence = ++state.refreshSequence;
		if (state.refreshAbortController) {
			state.refreshAbortController.abort();
			this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackEndResourceRefresh, {});
		}
		const refreshAbortController = new AbortController();
		state.refreshAbortController = refreshAbortController;
		this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackBeginResourceRefresh, {});
		const signal = AbortSignal.any([rpcContext.signal, refreshAbortController.signal, state.lifecycleAbort.signal]);
		const isCurrentRefresh = () =>
			this.states.get(playerId) === state &&
			refreshSequence === state.refreshSequence &&
			!signal.aborted &&
			this.bus.querySync(playerId, PLAYER_QUERY.playbackSessionInternal)?.owns(sessionId) === true;
		try {
			const info = await this.bus.requestRpc<{ track: Track; fresh?: boolean }, StreamInfo | null>(
				playerId,
				PLAYER_RPC.streamResolve,
				{ track: session.track, fresh: true },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!info?.stream && !info?.url && !info?.recreate) throw new Error("No stream available for resource refresh");
			if (info.remote) throw new Error("Cannot refresh a remote playback resource");
			await this.bus.action(playerId, { type: "FILTER_SET_SOURCE_TYPE", streamType: info.type ?? "arbitrary" }, { signal });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			await this.bus.action(
				playerId,
				{ type: "FILTER_APPLY_AND_SEEK", streamInfo: info, position: Math.max(0, position) },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const processed = await this.bus.query(playerId, PLAYER_QUERY.filteredStream);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			if (!processed) throw new Error("Playback resource controllers are unavailable");
			const active = await this.bus.requestRpc<
				{ streamInfo: StreamInfo; session: PlaybackSession },
				import("../types").ActiveStream
			>(playerId, CONTROLLER_RPC.streamReplace, { streamInfo: processed, session });
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			const resource = await this.bus.requestRpc<
				{ stream: import("stream").Readable; track: Track; inputType?: StreamType },
				AudioResource
			>(
				playerId,
				PLAYER_RPC.resourceCreate,
				{ stream: active.stream, track: session.track, inputType: active.inputType },
				{ signal },
			);
			if (!isCurrentRefresh()) throw new Error("Playback resource refresh superseded");
			session.setResource(resource);
			session.setPlaybackOffset(Math.max(0, position));
			await this.bus.requestRpc(playerId, CONTROLLER_RPC.playbackPlay, { resource, session }, { signal });
			session.markPlaying(Math.max(0, position));
			this.bus.event(playerId, { type: BUS_EVENT.playbackStateChanged, session: session.snapshot() });
			return session.snapshot();
		} finally {
			if (isCurrentRefresh()) {
				this.bus.requestRpcSync(playerId, CONTROLLER_RPC.playbackEndResourceRefresh, {});
				state.refreshAbortController = null;
			}
		}
	}

	private async handleRefresh(
		playerId: string,
		event: Extract<PlayerInput, { type: typeof BUS_REQUEST.resourceRefresh }>,
	): Promise<void> {
		const state = this.states.get(playerId);
		if (!state) return;
		this.debug?.(`[ResourceRefreshController] ${traceBusSignal(BUS_REQUEST.resourceRefresh)} guild=${playerId}`);
		try {
			const session = await this.bus.requestRpc(
				playerId,
				PLAYER_RPC.playbackRefreshResource,
				{ position: event.position ?? 0 },
				{ signal: state.lifecycleAbort.signal },
			);
			if (this.states.get(playerId) !== state) return;
			this.debug?.(`[ResourceRefreshController] ${traceBusSignal(BUS_OUTPUT.resourceRefreshed)} guild=${playerId}`);
			this.bus.emitOutput({ type: BUS_OUTPUT.resourceRefreshed, requestId: event.requestId, playerId, session });
		} catch (error) {
			if (this.states.get(playerId) !== state || state.lifecycleAbort.signal.aborted) return;
			this.debug?.(
				`[ResourceRefreshController] ${traceBusSignal(BUS_OUTPUT.resourceError)} guild=${playerId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			this.bus.emitOutput({
				type: BUS_OUTPUT.resourceError,
				requestId: event.requestId,
				playerId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}
