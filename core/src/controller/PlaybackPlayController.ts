import type { PlayerBus, PlayerBusRpcContext } from "../structures/PlayerBus";
import type { PlaybackSessionController } from "./PlaybackSessionController";
import type { PlaybackSkipController } from "./PlaybackSkipController";
import type { PlayerMessageContext, SearchResult, Track } from "../types";
import type { PlaybackPlayControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

/** Owns the public play RPC: search, queue insertion, TTS interrupt, and initial skip. */
export class PlaybackPlayController {
	private readonly detachRpc: () => void;
	private readonly bus: PlayerBus;
	private readonly sessionController: PlaybackSessionController;
	private readonly skipController: PlaybackSkipController;
	private readonly isWaitingForQueue: PlaybackPlayControllerOptions["isWaitingForQueue"];
	private readonly debug: PlaybackPlayControllerOptions["debug"];
	private readonly lifecycleSignal: AbortSignal;
	private readonly adapters: PlaybackPlayControllerOptions["adapters"];

	public constructor(options: PlaybackPlayControllerOptions) {
		this.bus = options.bus;
		this.sessionController = options.sessionController;
		this.skipController = options.skipController;
		this.isWaitingForQueue = options.isWaitingForQueue;
		this.debug = options.debug;
		this.lifecycleSignal = options.lifecycleSignal;
		this.adapters = options.adapters;
		this.detachRpc = this.bus.registerRpc<{ query: string | Track | SearchResult | null; requestedBy?: string }, boolean>(
			CONTROLLER_RPC.play,
			(request, context) => this.play(request.query, request.requestedBy, context),
		);
	}

	public dispose(): void {
		this.detachRpc();
	}

	private async play(
		query: string | Track | SearchResult | null,
		requestedBy: string | undefined,
		rpcContext: PlayerBusRpcContext,
	): Promise<boolean> {
		if (rpcContext.signal.aborted || this.lifecycleSignal.aborted) return false;
		const context: PlayerMessageContext = {
			requestId: rpcContext.requestId,
			source: "PlaybackPlayController:play",
			signal: AbortSignal.any([rpcContext.signal, this.lifecycleSignal]),
			timestamp: rpcContext.timestamp,
			priority: 10,
		};
		try {
			if (query === null) {
				const session = this.sessionController.current;
				if (session?.status === "playing" || session?.status === "paused") return true;
				await this.skipController.skip(context);
				return this.sessionController.current?.track !== null && this.sessionController.current?.track !== undefined;
			}
			let tracks: Track[];
			if (typeof query === "string") {
				const result = await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(
					"search",
					{ query, requestedBy: requestedBy || "Unknown" },
					{ signal: context.signal },
				);
				tracks = result.playlist ? result.tracks : result.tracks.slice(0, 1);
			} else if ("tracks" in query) tracks = query.playlist ? query.tracks : query.tracks.slice(0, 1);
			else tracks = [query];
			if (tracks.length === 0 || context.signal.aborted) return false;
			const ttsInterruptEnabled = this.bus.querySync("ttsInterrupt") ?? true;
			const isTTSTrack =
				tracks.length === 1 &&
				ttsInterruptEnabled &&
				(this.bus.hasRpc(CONTROLLER_RPC.ttsIsTTS) ?
					this.bus.requestRpcSync<{ track: Track }, boolean>(CONTROLLER_RPC.ttsIsTTS, { track: tracks[0] })
				:	(this.adapters?.isTTS?.(tracks[0]) ?? false));
			if (isTTSTrack) {
				if (this.bus.hasRpc(CONTROLLER_RPC.ttsPlay)) {
					await this.bus.requestRpc(CONTROLLER_RPC.ttsPlay, { track: tracks[0] }, { signal: context.signal });
				} else {
					await this.adapters?.playTTS?.(tracks[0]);
				}
				return true;
			}
			await this.bus.requestRpc("queue.addMultiple", { tracks }, { signal: context.signal });
			const session = this.sessionController.current;
			if ((session?.status === "playing" || session?.status === "paused") && !this.isWaitingForQueue()) {
				if (this.bus.hasRpc("preload.next")) {
					void this.bus
						.requestRpc("preload.next", {}, { signal: context.signal })
						.catch((error) => this.debug("[PlaybackPlayController] Preload after queue add error:", error));
				}
				return true;
			}
			if (this.isWaitingForQueue()) {
				return this.sessionController.current?.status === "playing" || this.sessionController.current?.status === "paused";
			}
			await this.skipController.skip(context);
			return this.sessionController.current?.track !== null && this.sessionController.current?.track !== undefined;
		} catch (error) {
			this.debug("[PlaybackPlayController] Play error:", error);
			const session = this.sessionController.current;
			if (session && !context.signal.aborted)
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			return false;
		}
	}
}
