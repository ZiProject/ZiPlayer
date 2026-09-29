import type { Bus, BusRpcContext } from "../structures/Bus";
import type { PlaybackSession } from "../structures/PlaybackSession";
import type {
	PlayerMessageContext,
	SearchResult,
	Track,
	PlaybackPlayControllerOptions,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
} from "../types";
import { BUS_EVENT, CONTROLLER_RPC, PLAYER_QUERY, PLAYER_RPC, PLAYER_ACTION } from "../structures/BusContract";

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
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playbackSessionInternal) ?? null;
	}

	private async skipThroughBus(context: PlayerMessageContext): Promise<void> {
		await this.bus.action(this.playerId, { type: PLAYER_ACTION.skip, requestId: context.requestId }, context);
	}

	private async beforePlayHooks(
		request: ExtensionPlayRequest,
	): Promise<{ request: ExtensionPlayRequest; response: ExtensionPlayResponse }> {
		if (this.bus.hasRpc(CONTROLLER_RPC.extensionBeforePlay)) {
			try {
				return await this.bus.requestRpc<
					ExtensionPlayRequest,
					{ request: ExtensionPlayRequest; response: ExtensionPlayResponse }
				>(this.playerId, CONTROLLER_RPC.extensionBeforePlay, request);
			} catch (e) {
				this.debug("[PlaybackPlayController] extensionBeforePlay error:", e);
			}
		}
		return { request, response: {} };
	}

	private async afterPlayHooks(payload: ExtensionAfterPlayPayload): Promise<void> {
		if (this.bus.hasRpc(CONTROLLER_RPC.extensionAfterPlay)) {
			try {
				await this.bus.requestRpc<ExtensionAfterPlayPayload, void>(
					this.playerId,
					CONTROLLER_RPC.extensionAfterPlay,
					payload,
				);
			} catch (e) {
				this.debug("[PlaybackPlayController] extensionAfterPlay error:", e);
			}
		}
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
		let tracksToAdd: Track[] = [];
		let isPlaylist = false;
		let effectiveRequest: ExtensionPlayRequest = { query: query as string | Track, requestedBy };
		let hookResponse: ExtensionPlayResponse = {};

		try {
			if (query === null) {
				const session = this.currentSession();
				if (session?.status === "playing" || session?.status === "paused") return true;
				const queueLength = (this.bus.querySync(this.playerId, PLAYER_QUERY.queue) ?? []).length;
				if (queueLength === 0) return false;
				await this.skipThroughBus(context);
				return true;
			}

			if (query && typeof query === "object" && "tracks" in query && Array.isArray((query as SearchResult).tracks)) {
				const sr = query as SearchResult;
				tracksToAdd = sr.tracks;
				isPlaylist = !!sr.playlist || sr.tracks.length > 1;
			} else {
				const hookOutcome = await this.beforePlayHooks(effectiveRequest);
				effectiveRequest = hookOutcome.request;
				hookResponse = hookOutcome.response;
				if (effectiveRequest.requestedBy === undefined) {
					effectiveRequest.requestedBy = requestedBy;
				}

				const hookTracks = Array.isArray(hookResponse.tracks) ? hookResponse.tracks : undefined;

				if (hookResponse.handled && (!hookTracks || hookTracks.length === 0)) {
					const handledPayload: ExtensionAfterPlayPayload = {
						success: hookResponse.success ?? true,
						query: effectiveRequest.query,
						requestedBy: effectiveRequest.requestedBy,
						tracks: [],
						isPlaylist: hookResponse.isPlaylist ?? false,
						error: hookResponse.error,
					};
					await this.afterPlayHooks(handledPayload);
					if (hookResponse.error) {
						const session = this.currentSession();
						this.bus.event(this.playerId, {
							type: BUS_EVENT.trackError,
							session: session?.snapshot() ?? {
								id: 0,
								track: null,
								resource: null,
								status: "idle",
								position: null,
								startedAt: null,
							},
							error: hookResponse.error,
						});
					}
					return hookResponse.success ?? true;
				}

				if (hookTracks && hookTracks.length > 0) {
					tracksToAdd = hookTracks;
					isPlaylist = hookResponse.isPlaylist ?? hookTracks.length > 1;
				} else if (typeof effectiveRequest.query === "string") {
					const result = await this.bus.requestRpc<{ query: string; requestedBy: string }, SearchResult>(
						this.playerId,
						PLAYER_RPC.search,
						{ query: effectiveRequest.query, requestedBy: effectiveRequest.requestedBy || "Unknown" },
						{ signal: context.signal },
					);
					tracksToAdd = result.tracks;
					isPlaylist = !!result.playlist || result.tracks.length > 1;
				} else if (effectiveRequest.query) {
					tracksToAdd = [effectiveRequest.query as Track];
				}
			}

			if (tracksToAdd.length === 0 || context.signal.aborted) {
				throw new Error("No tracks found");
			}

			const ttsInterruptEnabled = this.bus.querySync(this.playerId, PLAYER_QUERY.ttsInterrupt) ?? true;
			const isTTS = (t: Track | undefined) => {
				if (!t) return false;
				try {
					return typeof t.source === "string" && t.source.toLowerCase().includes("tts");
				} catch {
					return false;
				}
			};
			const queryLooksTTS =
				typeof effectiveRequest.query === "string" && effectiveRequest.query.trim().toLowerCase().startsWith("tts");

			const isTTSTrack =
				!isPlaylist &&
				tracksToAdd.length > 0 &&
				ttsInterruptEnabled &&
				((this.bus.hasRpc(CONTROLLER_RPC.ttsIsTTS) ?
					this.bus.requestRpcSync<{ track: Track }, boolean>(this.playerId, CONTROLLER_RPC.ttsIsTTS, {
						track: tracksToAdd[0],
					})
				:	(this.adapters?.isTTS?.(tracksToAdd[0]) ?? isTTS(tracksToAdd[0]))) || queryLooksTTS);

			if (isTTSTrack) {
				if (this.bus.hasRpc(CONTROLLER_RPC.ttsPlay)) {
					await this.bus.requestRpc(this.playerId, CONTROLLER_RPC.ttsPlay, { track: tracksToAdd[0] }, { signal: context.signal });
				} else {
					await this.adapters?.playTTS?.(tracksToAdd[0]);
				}
				await this.afterPlayHooks({
					success: true,
					query: effectiveRequest.query,
					requestedBy: effectiveRequest.requestedBy,
					tracks: tracksToAdd,
					isPlaylist,
				});
				return true;
			}

			if (isPlaylist) {
				await this.bus.requestRpc(this.playerId, PLAYER_RPC.queueAddMultiple, { tracks: tracksToAdd }, { signal: context.signal });
			} else {
				await this.bus.requestRpc(this.playerId, PLAYER_RPC.queueAdd, { track: tracksToAdd[0] }, { signal: context.signal });
			}

			const session = this.currentSession();
			const isPlayingOrPaused = session?.status === "playing" || session?.status === "paused";

			if (isPlayingOrPaused && !this.isWaitingForQueue()) {
				if (this.bus.hasRpc(PLAYER_RPC.preloadNext)) {
					void this.bus
						.requestRpc(this.playerId, PLAYER_RPC.preloadNext, {}, { signal: context.signal })
						.catch((error: unknown) => this.debug("[PlaybackPlayController] Preload after queue add error:", error));
				}
				await this.afterPlayHooks({
					success: true,
					query: effectiveRequest.query,
					requestedBy: effectiveRequest.requestedBy,
					tracks: tracksToAdd,
					isPlaylist,
				});
				return true;
			}

			let started = true;
			if (!isPlayingOrPaused) {
				if (this.isWaitingForQueue()) {
					started = true;
				} else {
					await this.skipThroughBus(context);
					started = true;
				}
			}

			await this.afterPlayHooks({
				success: started,
				query: effectiveRequest.query,
				requestedBy: effectiveRequest.requestedBy,
				tracks: tracksToAdd,
				isPlaylist,
			});
			return started;
		} catch (error) {
			this.debug("[PlaybackPlayController] Play error:", error);
			const err = error instanceof Error ? error : new Error(String(error));
			await this.afterPlayHooks({
				success: false,
				query: effectiveRequest.query,
				requestedBy: effectiveRequest.requestedBy,
				tracks: tracksToAdd,
				isPlaylist,
				error: err,
			});
			const session = this.currentSession();
			if (!context.signal.aborted) {
				this.bus.event(this.playerId, {
					type: BUS_EVENT.trackError,
					session: session?.snapshot() ?? {
						id: 0,
						track: null,
						resource: null,
						status: "idle",
						position: null,
						startedAt: null,
					},
					error: err,
				});
			}
			return false;
		}
	}
}
