import type { Bus, BusRpcContext } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, SearchResult, Track } from "../types";
import type { PlaybackPlayControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/**
 * Owns the public play RPC: search, queue insertion, TTS interrupt, and initial skip.
 * Talks to sibling playback controllers only through Bus queries/actions —
 * never by holding a direct reference to them.
 *
 * Per-player worker — created by the shared `PlaybackOrchestrator` in `attach(playerId, ...)`
 * and discarded in `detach(playerId)`. Registers no RPC of its own: `play` is registered
 * exactly once, in `PlaybackOrchestrator`'s constructor, and routed to the right worker via
 * `ctx.playerId`.
 */
export class PlaybackPlayController {
	private readonly playerId: string;
	private readonly bus: Bus;
	private readonly isWaitingForQueue: PlaybackPlayControllerOptions["isWaitingForQueue"];
	private readonly debug: PlaybackPlayControllerOptions["debug"];
	private readonly lifecycleSignal: AbortSignal;
	private readonly adapters: PlaybackPlayControllerOptions["adapters"];

	public constructor(playerId: string, options: PlaybackPlayControllerOptions) {
		this.playerId = playerId;
		this.bus = options.bus;
		this.isWaitingForQueue = options.isWaitingForQueue;
		this.debug = options.debug;
		this.lifecycleSignal = options.lifecycleSignal;
		this.adapters = options.adapters;
	}

	public dispose(): void {
		// No module-level registration to release; kept for a uniform worker lifecycle API.
	}

	private currentSession(): PlaybackSession | null {
		return this.bus.querySync(this.playerId, "playbackSessionInternal") ?? null;
	}

	private async skipThroughBus(context: PlayerMessageContext): Promise<void> {
		await this.bus.action(this.playerId, { type: "SKIP", requestId: context.requestId }, context);
	}

	public async play(
		query: string | Track | SearchResult | null,
		requestedBy: string | undefined,
		rpcContext: BusRpcContext,
	): Promise<boolean> {
		if (rpcContext.signal.aborted || this.lifecycleSignal.aborted) return false;
		const context: PlayerMessageContext = {
			playerId: this.playerId,
			requestId: rpcContext.requestId,
			source: "PlaybackPlayController:play",
			signal: AbortSignal.any([rpcContext.signal, this.lifecycleSignal]),
			timestamp: rpcContext.timestamp,
			priority: 10,
		};
		try {
			if (query === null) {
				const session = this.currentSession();
				if (session?.status === "playing" || session?.status === "paused") return true;
				await this.skipThroughBus(context);
				const after = this.currentSession();
				return after?.track !== null && after?.track !== undefined;
			}
			let tracks: Track[];
			if (typeof query === "string") {
				const result = await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(
					this.playerId,
					"search",
					{ query, requestedBy: requestedBy || "Unknown" },
					{ signal: context.signal },
				);
				tracks = result.playlist ? result.tracks : result.tracks.slice(0, 1);
			} else if ("tracks" in query) tracks = query.playlist ? query.tracks : query.tracks.slice(0, 1);
			else tracks = [query];
			if (tracks.length === 0 || context.signal.aborted) return false;
			const ttsInterruptEnabled = this.bus.querySync(this.playerId, "ttsInterrupt") ?? true;
			const isTTSTrack =
				tracks.length === 1 &&
				ttsInterruptEnabled &&
				(this.bus.hasRpc(CONTROLLER_RPC.ttsIsTTS) ?
					this.bus.requestRpcSync<{ track: Track }, boolean>(this.playerId, CONTROLLER_RPC.ttsIsTTS, { track: tracks[0] })
				:	(this.adapters?.isTTS?.(tracks[0]) ?? false));
			if (isTTSTrack) {
				if (this.bus.hasRpc(CONTROLLER_RPC.ttsPlay)) {
					await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.ttsPlay, { track: tracks[0] }, { signal: context.signal });
				} else {
					await this.adapters?.playTTS?.(tracks[0]);
				}
				return true;
			}
			await this.bus.requestRpc(this.playerId, "queue.addMultiple", { tracks }, { signal: context.signal });
			const session = this.currentSession();
			if ((session?.status === "playing" || session?.status === "paused") && !this.isWaitingForQueue()) {
				if (this.bus.hasRpc("preload.next")) {
					void this.bus
						.requestRpc(this.playerId, "preload.next", {}, { signal: context.signal })
						.catch((error: unknown) => this.debug("[PlaybackPlayController] Preload after queue add error:", error));
				}
				return true;
			}
			if (this.isWaitingForQueue()) {
				const waiting = this.currentSession();
				return waiting?.status === "playing" || waiting?.status === "paused";
			}
			await this.skipThroughBus(context);
			const after = this.currentSession();
			return after?.track !== null && after?.track !== undefined;
		} catch (error) {
			this.debug("[PlaybackPlayController] Play error:", error);
			const session = this.currentSession();
			if (session && !context.signal.aborted)
				this.bus.event(this.playerId, {
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			return false;
		}
	}
}
