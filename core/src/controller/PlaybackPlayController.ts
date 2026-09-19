import type { GlobalPlayerBus, PlayerBus, PlayerBusRpcContext } from "../structures/PlayerBus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type { PlayerMessageContext, SearchResult, Track } from "../types";
import type { PlaybackPlayControllerOptions } from "../types";
import { CONTROLLER_RPC } from "./ControllerBusContract";

// playback.play must be registered exactly once on the shared GlobalPlayerBus; each
// per-player PlaybackPlayController registers itself here.
const playControllers = new Map<string, PlaybackPlayController>();
const playRpcRegistered = new WeakSet<GlobalPlayerBus>();
function ensurePlayRpcBridge(bus: GlobalPlayerBus): void {
	if (playRpcRegistered.has(bus)) return;
	playRpcRegistered.add(bus);
	bus.registerRpc<{ query: string | Track | SearchResult | null; requestedBy?: string }, boolean>(
		CONTROLLER_RPC.play,
		(request, context) => {
			const controller = playControllers.get(context.playerId);
			if (!controller) return Promise.resolve(false);
			return controller.play(request.query, request.requestedBy, context);
		},
	);
}

/** Owns the public play RPC: search, queue insertion, TTS interrupt, and initial skip.
 * Talks to sibling playback controllers only through PlayerBus queries/actions —
 * never by holding a direct reference to them. One instance per player. */
export class PlaybackPlayController {
	private readonly playerId: string;
	private readonly bus: PlayerBus;
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
		ensurePlayRpcBridge(this.bus.globalBus);
		playControllers.set(playerId, this);
	}

	public dispose(): void {
		if (playControllers.get(this.playerId) === this) playControllers.delete(this.playerId);
	}

	private currentSession(): PlaybackSession | null {
		return this.bus.querySync("playbackSessionInternal") ?? null;
	}

	private async skipThroughBus(context: PlayerMessageContext): Promise<void> {
		await this.bus.action({ type: "SKIP", requestId: context.requestId }, context);
	}

	public async play(
		query: string | Track | SearchResult | null,
		requestedBy: string | undefined,
		rpcContext: PlayerBusRpcContext,
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
			const session = this.currentSession();
			if ((session?.status === "playing" || session?.status === "paused") && !this.isWaitingForQueue()) {
				if (this.bus.hasRpc("preload.next")) {
					void this.bus
						.requestRpc("preload.next", {}, { signal: context.signal })
						.catch((error) => this.debug("[PlaybackPlayController] Preload after queue add error:", error));
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
				this.bus.event({
					type: "TRACK_ERROR",
					session: session.snapshot(),
					error: error instanceof Error ? error : new Error(String(error)),
				});
			return false;
		}
	}
}
