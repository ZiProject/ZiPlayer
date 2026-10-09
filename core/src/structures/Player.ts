import { EventEmitter } from "events";
import type { Stream } from "stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { PlayerManager } from "./PlayerManager";
import type {
	PlayerOptions,
	StreamInfo,
	Track,
	VoiceChannel,
	SearchResult,
	ProgressBarOptions,
	TrackLoadResult,
	SaveOptions,
	SaveVideoOptions,
	SearchDebugResult,
	LoopMode,
	PlayerSession,
	PlayOptions,
	SearchOptions,
	PlayResult,
} from "../types";
import { PlaybackMode } from "../types";
import type { FilterEngine } from "../controller/FilterController";
import {
	Bus,
	createPlayerRequestId,
	type PlayerAction as PlayerActionMessage,
	type PlayerEvent,
	type PlayerEventType,
	type PlayerQuery,
	type PlayerQueryMap,
} from "./Bus";
import { PlayerAction } from "./PlayerAction";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { BaseExtension } from "../extensions/BaseExtension";
import type { AudioResource } from "@discordjs/voice";
import type { PlaybackSession } from "./PlaybackSession";
import { BUS_EVENT, BUS_REQUEST, CONTROLLER_RPC, PLAYER_ACTION, PLAYER_QUERY, PLAYER_RPC } from "./BusContract";
import type { PlayerQueue } from "../controller/QueueController";

export function assertVoiceChannel(channel: VoiceChannel): asserts channel is VoiceChannel {
	if (
		!channel ||
		typeof channel !== "object" ||
		!("type" in channel) ||
		((channel as any).type !== 2 && (channel as any).type !== "GuildVoice")
	) {
		throw new TypeError("play({ voiceChannel }) requires a Guild VoiceChannel");
	}
}

export class Player extends EventEmitter {
	public readonly bus: Bus;
	public readonly actionExecutor: PlayerAction;
	public readonly playerId: string;
	public readonly manager?: PlayerManager;
	public readonly options: PlayerOptions;
	public userdata?: Record<string, any>;
	public _lastActivity = Date.now();
	public destroyed = false;
	private disposed = false;
	private playOperation: Promise<boolean> = Promise.resolve(false);
	private playGeneration = 0;
	private playAbortController: AbortController | null = null;

	public constructor(playerId: string, bus: Bus, options: PlayerOptions = {}, manager?: PlayerManager) {
		super();
		this.playerId = playerId;
		this.bus = bus;
		this.options = {
			leaveOnEnd: true,
			leaveOnEmpty: true,
			pauseOnEmpty: false,
			leaveTimeout: 100000,
			volume: 100,
			quality: "high",
			extractorTimeout: 50000,
			selfDeaf: true,
			selfMute: false,
			...options,
			tts: { createPlayer: false, interrupt: true, volume: 100, maxTimeTts: 60_000, ...(options.tts || {}) },
		};
		this.manager = manager;
		this.userdata = this.options.userdata;
		this.actionExecutor = new PlayerAction(this.bus, this.playerId);
		this.bus.publish(this.playerId, BUS_EVENT.initialized);
		this.bus.publish(this.playerId, BUS_EVENT.ready);
	}

	public get id(): string {
		return this.playerId;
	}

	public debug(message?: any, ...optionalParams: any[]): void {
		const manager = this.manager;
		if (manager && (manager.listenerCount("debug") > 0 || manager.debugEnabled)) {
			manager.emit("debug", message, ...optionalParams);
		}
	}
	public get guildId(): string {
		this.debug("Player.guildId is deprecated soon, use Player.id instead");
		return this.playerId;
	}
	public get currentTrack(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.currentTrack);
	}
	public get audioPlayer() {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.audioPlayer);
	}
	public get currentResource(): AudioResource | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.currentResource) as AudioResource | null;
	}
	public get connection(): VoiceConnection | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.connection) ?? null;
	}
	public get playbackMode(): PlaybackMode {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playbackMode) ?? PlaybackMode.NATIVE;
	}
	public get forwardLeader(): any {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.forwardLeader);
	}
	public get forwardFollowers(): ReadonlySet<any> {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.forwardFollowers) ?? new Set();
	}
	/**
	 * Queue of this player (add / insert / remove / move / swap / shuffle / loop / history ...).
	 *
	 * Resolved through the Bus on every access, so it always points at the state the shared
	 * `QueueController` keeps for this `playerId`; the Player never stores a queue of its own.
	 * Throws once the player has been destroyed (its queue state is released).
	 */
	public get queue(): PlayerQueue {
		const queue = this.bus.querySync(this.playerId, PLAYER_QUERY.queueState);
		if (!queue) throw new Error(`Queue is not available for player "${this.playerId}" (destroyed or not attached)`);
		return queue;
	}
	public get filter(): FilterEngine {
		const engine = this.bus.querySync(this.playerId, PLAYER_QUERY.filterState);
		if (!engine) throw new Error(`Filter engine is not available for player "${this.playerId}" (destroyed or not attached)`);
		return engine;
	}
	public get queueSize(): number {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queue)?.length ?? 0;
	}
	public get isPlaying(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isPlaying ?? false;
		if (this.playbackMode === PlaybackMode.REMOTE) return this.currentTrack !== null && !this.isPaused;
		return this.bus.querySync(this.playerId, PLAYER_QUERY.isPlaying);
	}
	public get isPaused(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isPaused ?? false;
		if (this.playbackMode === PlaybackMode.REMOTE) {
			return (this.bus.querySync(this.playerId, PLAYER_QUERY.remotePaused) as boolean | null) ?? false;
		}
		return this.bus.querySync(this.playerId, PLAYER_QUERY.isPaused);
	}
	public get isLive(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}
	public get isIdle(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isIdle ?? true;
		if (this.playbackMode === PlaybackMode.REMOTE) return this.currentTrack === null;
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playerState) === "idle";
	}
	public get isBuffering(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isBuffering ?? false;
		return this.bus.querySync(this.playerId, PLAYER_QUERY.playerState) === "buffering";
	}
	public get volume(): number {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.volume);
	}
	public set volume(value: number) {
		this.bus.requestRpcSync<{ value: number }, number>(this.playerId, PLAYER_RPC.volumeSet, { value });
	}
	public get previousTrack(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.previousTrack);
	}
	public get upcomingTracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queue) ?? [];
	}
	public get previousTracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.previousTracks) ?? [];
	}
	public get availablePlugins(): string[] {
		return (this.bus.querySync(this.playerId, PLAYER_QUERY.availablePlugins) ?? []).map((plugin) => plugin.name);
	}
	public get pluginNames(): string[] {
		return (this.bus.querySync(this.playerId, PLAYER_QUERY.availablePlugins) ?? []).map((plugin: any) => plugin.name ?? plugin);
	}
	public get extensionNames(): string[] {
		return (this.bus.querySync(this.playerId, PLAYER_QUERY.extensions) ?? []).map((ext: any) => ext.name ?? ext);
	}
	public get relatedTracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.relatedTracks) ?? [];
	}
	public search(query: string, optionsOrRequestedBy?: SearchOptions | string): Promise<SearchResult> {
		const options =
			typeof optionsOrRequestedBy === "string" ? { requestedBy: optionsOrRequestedBy } : (optionsOrRequestedBy ?? {});
		const requestedBy =
			typeof options.requestedBy === "string" ?
				options.requestedBy
			:	(options.requestedBy?.id ??
				options.requestedBy?.username ??
				(options.requestedBy ? String(options.requestedBy) : undefined));
		return this.bus.requestRpc(
			this.playerId,
			PLAYER_RPC.search,
			{ query, requestedBy: requestedBy ?? "Unknown", plugin: options.plugin },
			{ signal: options.signal },
		);
	}
	public getCachedSearchResult(query: string): Promise<SearchResult | null> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.searchCacheGet, { query });
	}
	public cacheSearchResult(query: string, result: SearchResult): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.searchCacheSet, { query, result });
	}
	public clearExpiredSearchCache(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.searchCachePurge, {});
	}
	public debugSearchQuery(query: string): Promise<SearchDebugResult> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.searchDebug, { query });
	}
	public createRelatedTracks(track?: Track | null): Promise<Track[]> {
		return this.bus.requestRpc(this.playerId, CONTROLLER_RPC.playbackCreateRelatedTracks, { track });
	}
	public async connect(
		channel: VoiceChannel,
		options?: { group?: string; selfDeaf?: boolean; selfMute?: boolean; deaf?: boolean; mute?: boolean },
	): Promise<VoiceConnection> {
		assertVoiceChannel(channel);
		const request = {
			type: BUS_REQUEST.connectionConnect,
			requestId: createPlayerRequestId(),
			channel,
			options:
				options ?
					{
						group: options.group,
						deaf: options.deaf ?? options.selfDeaf,
						mute: options.mute ?? options.selfMute,
					}
				:	undefined,
		} as const;
		return (this.bus.request(this.playerId, request as any) as Promise<{ connection: VoiceConnection }>).then(
			(e) => e.connection,
		);
	}
	public async disconnect(): Promise<void> {
		return this.bus
			.request(this.playerId, { type: BUS_REQUEST.connectionDisconnect, requestId: createPlayerRequestId() })
			.then(() => undefined);
	}
	public async play(
		query: string | Track | SearchResult | null,
		optionsOrRequestedBy?: PlayOptions | string,
	): Promise<PlayResult | false> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot play while subscribed to another player. Call unsubscribeForward() first.");
			return false;
		}

		let options: PlayOptions;
		if (!optionsOrRequestedBy) {
			options = {};
		} else if (typeof optionsOrRequestedBy === "string") {
			options = { requestedBy: optionsOrRequestedBy };
		} else if (
			typeof optionsOrRequestedBy === "object" &&
			("voiceChannel" in optionsOrRequestedBy ||
				"plugin" in optionsOrRequestedBy ||
				"signal" in optionsOrRequestedBy ||
				"requestedBy" in optionsOrRequestedBy)
		) {
			options = optionsOrRequestedBy;
		} else {
			options = { requestedBy: optionsOrRequestedBy };
		}

		if (options.signal?.aborted) return false;

		if (options.voiceChannel !== undefined) {
			const connection = this.connection;
			const isReady = connection && (connection.state?.status === "ready" || (connection.state as any)?.status === 0);
			const currentChannelId = (connection as any)?.joinConfig?.channelId;
			if (!isReady || (currentChannelId && currentChannelId !== options.voiceChannel.id)) {
				assertVoiceChannel(options.voiceChannel);
				await this.connect(options.voiceChannel);
			}
		}

		if (options.signal?.aborted) return false;

		const generation = ++this.playGeneration;
		const controller = new AbortController();
		this.playAbortController?.abort();
		this.playAbortController = controller;

		const combinedSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

		const reqBy =
			typeof options.requestedBy === "string" ?
				options.requestedBy
			:	(options.requestedBy?.id ??
				options.requestedBy?.username ??
				(options.requestedBy ? String(options.requestedBy) : undefined));

		const operation = this.playOperation
			.catch(() => false as const)
			.then(async () => {
				if (generation !== this.playGeneration || combinedSignal.aborted) return false;
				const rpcResult = await this.bus.requestRpc<
					{ query: string | Track | SearchResult | null; requestedBy?: string; plugin?: string | string[] },
					{ ok: boolean; track: Track | null } | boolean
				>(this.playerId, PLAYER_RPC.play, { query, requestedBy: reqBy, plugin: options.plugin }, { signal: combinedSignal });

				if (generation !== this.playGeneration || combinedSignal.aborted) return false;

				const ok = typeof rpcResult === "object" ? rpcResult.ok : Boolean(rpcResult);
				if (!ok) return false;

				const track = typeof rpcResult === "object" && rpcResult.track ? rpcResult.track : this.currentTrack;
				if (!track) return false;

				const queryStr = typeof query === "string" ? query : (track.title ?? track.url ?? "");

				const playResult: PlayResult = {
					track,
					query: queryStr,
					requestedBy: options.requestedBy,
					voiceConnection: this.connection ?? undefined,
					player: this,
				};
				return playResult;
			});

		this.playOperation = operation.then((res) => Boolean(res));
		return operation.finally(() => {
			if (this.playAbortController === controller) this.playAbortController = null;
		});
	}
	public async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot playNext while subscribed to another player");
			return false;
		}
		return this.action({ type: PLAYER_ACTION.skip })
			.then(() => this.isPlaying || this.currentTrack !== null)
			.catch(() => false);
	}
	public async pause(): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot pause while subscribed to another player");
			return false;
		}
		if (!this.isPlaying || this.isPaused) return false;
		this.invalidatePlay();
		return this.action({ type: PLAYER_ACTION.pause })
			.then(() => this.isPaused)
			.catch(() => false);
	}
	public async resume(): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot resume while subscribed to another player");
			return false;
		}
		if (!this.isPaused) return false;
		return this.action({ type: PLAYER_ACTION.resume })
			.then(() => !this.isPaused)
			.catch(() => false);
	}
	public async stop(): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot stop while subscribed to another player");
			return false;
		}
		this.invalidatePlay();
		return this.action({ type: PLAYER_ACTION.stop })
			.then(() => true)
			.catch(() => false);
	}
	public async seek(position: number): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot seek while subscribed to another player");
			return false;
		}
		const track = this.currentTrack;
		if (!track) {
			this.debug("[Player] No current track to seek");
			return false;
		}
		const totalDuration = track.duration > 1000 ? track.duration : track.duration * 1000;
		if (position < 0 || position > totalDuration) {
			this.debug(`[Player] Invalid seek position: ${position}ms (track duration: ${totalDuration}ms)`);
			return false;
		}
		this.invalidatePlay();
		return this.action({ type: PLAYER_ACTION.seek, position })
			.then(() => true)
			.catch(() => false);
	}
	public async skip(
		indexOrOptions?: number | { index?: number; signal?: AbortSignal },
		maybeOptions?: { signal?: AbortSignal },
	): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot skip while subscribed to another player");
			return false;
		}
		let index: number | undefined;
		let signal: AbortSignal | undefined;
		if (typeof indexOrOptions === "number") {
			index = indexOrOptions;
			signal = maybeOptions?.signal;
		} else if (indexOrOptions && typeof indexOrOptions === "object") {
			index = indexOrOptions.index;
			signal = indexOrOptions.signal;
		} else if (maybeOptions && typeof maybeOptions === "object") {
			signal = maybeOptions.signal;
		}
		if (signal?.aborted) return false;
		if (typeof index === "number") {
			if (index < 0 || index >= this.queueSize) {
				this.debug(`[Player] No track found at index ${index}`);
				return false;
			}
		}
		this.invalidatePlay();
		return this.action({ type: PLAYER_ACTION.skip, index, signal } as any)
			.then(() => !signal?.aborted)
			.catch(() => false);
	}
	private invalidatePlay(): void {
		this.playGeneration++;
		this.playAbortController?.abort();
	}
	public destroyCurrentStream(): void {
		void this.bus.action(this.playerId, { type: PLAYER_ACTION.stop });
	}
	public generateWillNext(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.willNext);
	}
	public preloadNextTrack(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.preloadNext, undefined);
	}
	public safeCancelPreload(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.preloadCancelSafe, undefined);
	}
	public preloadNext(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.preloadNext, undefined);
	}
	public cancelPreload(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, PLAYER_RPC.preloadCancel, undefined);
	}
	public clearSlot(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, PLAYER_RPC.preloadClear, undefined);
	}
	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.transitionFade, { resource, from, to, durationMs });
	}
	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.transitionFadeIn, { resource, track });
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.transitionFadeOutCurrent, undefined);
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.transitionSkipAndStop, undefined);
	}
	public getTrackMetadataValue(track: Track, key: string): any {
		return track?.metadata?.[key];
	}
	public resolveSmartTransitionDuration(track: Track): number {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.transitionDuration, { from: this.currentTrack, to: track });
	}
	public async maybeAlignToBeatBoundary(track?: Track): Promise<void> {
		const wait = this.bus.requestRpcSync<{ track: Track | null; positionMs: number }, number>(
			this.playerId,
			PLAYER_RPC.transitionBeatWait,
			{ track: track ?? this.currentTrack, positionMs: this.getTime().current },
		);
		if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
	}
	public getTrackTargetVolume(track: Track): number {
		return this.bus.requestRpcSync<{ track: Track | null }, number>(this.playerId, PLAYER_RPC.transitionTargetVolume, { track });
	}
	public attemptTrackRecovery(track: Track, session?: PlaybackSession): Promise<TrackLoadResult> {
		if (!session) return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession"));
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.playbackRecover, { track, session });
	}
	public promotePreloadToCurrent(track: Track): AudioResource | null {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.playbackPromotePreload, { track });
	}
	public createResource(stream: Stream.Readable, track: Track): AudioResource {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.resourceCreate, { stream, track });
	}
	public mergeTrackPreserveRef(target: Track, source: Track): Track {
		Object.assign(target, source);
		return target;
	}
	public async applyTrackMiddleware(track: Track): Promise<Track> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.trackMiddleware, { track });
	}
	public async getStream(track: Track): Promise<StreamInfo | TrackLoadResult | null> {
		if (this.bus.querySync(this.playerId, PLAYER_QUERY.playbackSession))
			return this.bus.requestRpc(this.playerId, PLAYER_RPC.playbackLoadFreshCurrent, { track });
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.streamResolve, { track });
	}
	public isUnrecoverableStreamError(error: unknown): boolean {
		const name = error instanceof Error ? error.name : "";
		const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		return name === "AbortError" || /unrecoverable|unsupported|not found|invalid source/.test(message);
	}
	public startTrack(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: PLAYER_ACTION.play, track });
	}
	public startFromPreload(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: PLAYER_ACTION.play, track });
	}
	public loadFreshStream(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.playbackLoadFresh, { track, session });
	}
	public async playRemote(_track: Track, stream: any, ..._args: any[]): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.playbackRemote, { track: _track, stream });
	}
	public ensureTTSPlayer(): boolean {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.ttsHasPlayer) ?? false;
	}
	public interruptWithTTSTrack(track: Track, ..._args: any[]): Promise<boolean> {
		return this.play(track).then((res) => Boolean(res));
	}
	public async previous(): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot previous while subscribed to another player");
			return false;
		}
		const track = this.bus.requestRpcSync<void, Track | null>(this.playerId, PLAYER_RPC.queuePrevious, undefined);
		if (!track) return false;
		this.clearLeaveTimeout();
		return this.startTrack(track)
			.then(() => true)
			.catch(() => false);
	}
	async save(track: Track, options?: SaveOptions | string): Promise<Stream.Readable> {
		try {
			return await this.bus.requestRpc(this.playerId, PLAYER_RPC.save, { track, options });
		} catch (error) {
			this.debug("[Player] save error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	async saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Stream.Readable> {
		if (!track) throw new TypeError("A track is required to save video");
		try {
			return await this.bus.requestRpc(this.playerId, PLAYER_RPC.saveVideo, { track, options });
		} catch (error) {
			this.debug("[Player] saveVideo error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	public loop(mode?: LoopMode | number): any {
		return mode === undefined ?
				this.bus.querySync(this.playerId, PLAYER_QUERY.queueLoop)
			:	this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueLoop, { mode });
	}
	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ?
				this.bus.querySync(this.playerId, PLAYER_QUERY.queueAutoPlay)
			:	this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueAutoPlay, { enabled });
	}
	public setWillNext(track: Track | null): Track | null {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track });
	}
	public setCurrentTrack(track: Track | null): void {
		void this.action({ type: PLAYER_ACTION.queueSetCurrent, track });
	}
	public setVolume(value: number): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot setVolume while subscribed to another player");
			return false;
		}
		if (!Number.isFinite(value) || value < 0 || value > 200) return false;
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.volumeSet, { value });
		return true;
	}
	public shuffle(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, PLAYER_RPC.queueShuffle, undefined);
	}
	public clearQueue(): void {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot clearQueue while subscribed to another player");
			return;
		}
		this.bus.requestRpcSync<void, void>(this.playerId, PLAYER_RPC.queueClear, undefined);
	}
	public async insert(query: string | Track | Track[], index = 0, requestedBy?: string): Promise<boolean> {
		if (this.playbackMode === PlaybackMode.FORWARD) {
			this.debug("[Player] Cannot insert while subscribed to another player");
			return false;
		}
		return this.bus
			.requestRpc<{ query: string | Track | Track[]; index: number; requestedBy?: string }, boolean>(
				this.playerId,
				PLAYER_RPC.queueInsert,
				{ query, index, requestedBy },
			)
			.catch(() => false);
	}
	public remove(index: number): Track | null {
		return this.bus.requestRpcSync<{ index: number }, Track | null>(this.playerId, PLAYER_RPC.queueRemove, { index });
	}
	public scheduleLeave(): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.lifecycleScheduleLeave, {});
	}
	public clearLeaveTimeout(): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.lifecycleClearLeaveTimeout, undefined);
	}
	public refreshPlayerResource(position = 0): Promise<boolean> {
		return this.bus
			.request(this.playerId, { type: BUS_REQUEST.resourceRefresh, requestId: createPlayerRequestId(), position } as any)
			.then(() => true)
			.catch(() => false);
	}
	private getExtensionInstances(): BaseExtension[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.extensions) ?? [];
	}
	public saveSession(_options?: any): PlayerSession {
		const plugins = (this.bus.querySync(this.playerId, PLAYER_QUERY.pluginList) as any[] | null) ?? [];
		return {
			guildId: this.guildId,
			currentTrack: this.currentTrack,
			position: this.currentResource?.playbackDuration || null,
			volume: this.volume,
			queue: this.queue.getTracks(),
			loopMode: this.queue.loop(),
			autoPlay: this.queue.autoPlay(),
			extensions: this.extensionNames,
			plugins: plugins.map((plugin: any) => plugin.name ?? plugin),
		};
	}
	public exitRemoteMode(): void {
		if (this.playbackMode !== PlaybackMode.REMOTE) return;
		this.debug("[Player] Exiting REMOTE mode, restoring native playback");
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.playbackExitRemote, undefined);
	}
	public getSerializableState(): object {
		return {
			guildId: this.guildId,
			queue: this.queue.getTracks(),
			currentTrack: this.currentTrack,
			volume: this.volume,
			isPlaying: this.isPlaying,
			isPaused: this.isPaused,
			loopMode: this.queue.loop(),
			autoPlay: this.queue.autoPlay(),
			filters: this.filter.getFilterString(),
			timestamp: Date.now(),
		};
	}
	public async restoreState(state: any): Promise<boolean> {
		try {
			if (typeof state?.volume === "number") this.setVolume(state.volume);
			if (state?.loopMode) this.queue.loop(state.loopMode);
			if (typeof state?.autoPlay === "boolean") this.queue.autoPlay(state.autoPlay);
			if (state?.filters) {
				const filterList = typeof state.filters === "string" ? state.filters.split(",").filter(Boolean) : state.filters;
				if (Array.isArray(filterList) && filterList.length > 0) {
					await this.filter.applyFilters(filterList);
				}
			}

			// Restore queue
			if (state?.queue && Array.isArray(state.queue)) {
				this.queue.clear();
				this.queue.addMultiple(state.queue);
			}

			this.debug("[Player] State restored");
			return true;
		} catch (error) {
			this.debug("[Player] Failed to restore state:", error);
			return false;
		}
	}
	public getStreamManagerStats(): any {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.streamStats) ?? {};
	}
	public getTime() {
		const session = this.bus.querySync(this.playerId, PLAYER_QUERY.playbackSession);
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive) return { current: 0, total: 0, format: "LIVE", formatted: { current: "LIVE", total: "LIVE" } };
		if (!track) return { current: 0, total: 0, format: "00:00", formatted: { current: "00:00", total: "00:00" } };
		const total = Math.floor(track.duration > 1000 ? track.duration : track.duration * 1000) | 0;
		const current =
			Math.max(0, Math.floor(this.bus.querySync(this.playerId, PLAYER_QUERY.position) ?? session?.position ?? 0)) | 0;
		return {
			current,
			total,
			format: this.formatTime(current),
			formatted: { current: this.formatTimeCompact(current), total: this.formatTimeCompact(total) },
		};
	}
	public getProgressBar(options: ProgressBarOptions = {}): string {
		const {
			size = 20,
			barChar = "▬",
			progressChar = "🔘",
			timeFormat = "compact",
			showPercentage = false,
			showTime = true,
		} = options;
		const session = this.bus.querySync(this.playerId, PLAYER_QUERY.playbackSession);
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive || !track) return isLive ? "🔴 LIVE" : "";
		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Math.max(0, Number(this.bus.querySync(this.playerId, PLAYER_QUERY.position) ?? session?.position ?? 0));
		if (!total) return this.formatTimeCompact(current);
		const ratio = Math.min(Math.max(current / total, 0), 1);
		const progress = Math.round(ratio * size);
		const filled = barChar.repeat(progress);
		const empty = barChar.repeat(Math.max(0, size - progress));
		const bar = progressChar === "none" || options.hideProgressChar ? filled + empty : filled + progressChar + empty;
		const formatTimeFn = timeFormat === "compact" ? this.formatTimeCompact.bind(this) : this.formatTime.bind(this);
		let result = showTime ? `${formatTimeFn(current)} ${bar} ${formatTimeFn(total)}` : bar;
		if (showPercentage) result += ` (${Math.round(ratio * 100)}%)`;
		return result;
	}
	public formatTime(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = totalSeconds % 60;
		const parts: string[] = [];
		if (hours > 0) {
			parts.push(String(hours));
			parts.push(String(minutes).padStart(2, "0"));
		} else parts.push(String(minutes));
		parts.push(String(seconds).padStart(2, "0"));
		return parts.join(":");
	}
	public formatTimeCompact(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000) | 0;
		const hours = Math.floor(totalSeconds / 3600) | 0;
		const minutes = Math.floor((totalSeconds % 3600) / 60) | 0;
		const seconds = totalSeconds % 60;
		if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}
	public action(action: PlayerActionMessage): Promise<void> {
		return this.actionExecutor.enqueue(action);
	}
	public query<K extends PlayerQuery>(query: K): Promise<PlayerQueryMap[K]> {
		return this.bus.query(this.playerId, query);
	}
	public subscribe<K extends PlayerEventType>(type: K, listener: (event: Extract<PlayerEvent, { type: K }>) => void): () => void {
		return this.bus.subscribe(this.playerId, type, listener);
	}
	public addPlugin(plugin: BasePlugin): void {
		this.bus.requestRpcSync<{ plugin: BasePlugin }, void>(this.playerId, PLAYER_RPC.pluginAdd, { plugin });
	}
	public removePlugin(name: string): boolean {
		return this.bus.requestRpcSync<{ name: string }, boolean>(this.playerId, PLAYER_RPC.pluginRemove, { name });
	}
	public attachExtension(extension: BaseExtension): void {
		this.bus.requestRpcSync<{ extension: BaseExtension }, void>(this.playerId, PLAYER_RPC.extensionAdd, { extension });
	}
	public detachExtension(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync<{ extension: BaseExtension }, boolean>(this.playerId, PLAYER_RPC.extensionRemove, {
			extension,
		});
	}
	public subscribeTo(leader: Player | string, options?: { forwardMode?: boolean }): boolean {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.forwardSubscribe, { leader, options });
	}
	public unsubscribeForward(reason?: string): boolean {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.forwardUnsubscribe, { reason });
	}
	public getForwardHealthStatus() {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.forwardHealth, undefined);
	}
	/**
	 * Teardown step 1 — abort workflow. Marks the player destroyed and cancels everything the facade
	 * itself owns (pending `play()` calls, queued/running actions) so nothing new reaches the
	 * controllers while `PlayerManager` detaches them. Idempotent.
	 */
	public abortWorkflow(): void {
		this.destroyed = true;
		this.invalidatePlay();
		this.actionExecutor.dispose();
	}
	/**
	 * Destroys the player.
	 *
	 * A managed player is torn down by `PlayerManager.destroy(playerId)` so the order is always
	 * abort workflow -> controllers detach -> `completeDestroy()` (bus disposal last). Only a player
	 * without a manager (or one the manager no longer tracks) finishes the teardown itself.
	 */
	public destroy(): void {
		if (this.destroyed) return;
		if (this.manager?.requestDestroy(this)) return;
		this.abortWorkflow();
		this.completeDestroy();
	}
	/**
	 * Final teardown step: releases extension back-references, publishes "destroyed" and drops this
	 * player's bus subscriptions. `PlayerManager` calls it after every controller has detached;
	 * call `destroy()` instead of this method.
	 */
	public completeDestroy(): void {
		if (this.disposed) return;
		this.destroyed = true;
		try {
			const exts = this.getExtensionInstances();
			for (const ext of exts) {
				if (ext && (ext as any).player === this) {
					(ext as any).player = null;
				}
			}
		} catch {
			// ignore
		}
		this.disposeBus();
		this.emit("playerDestroy");
		this.removeAllListeners();
	}
	/**
	 * Alias of {@link destroy}. It used to publish "destroyed" and drop the bus subscriptions on its
	 * own, which skipped the controller detach that `PlayerManager` performs first.
	 */
	public dispose(): void {
		this.destroy();
	}
	private disposeBus(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.invalidatePlay();
		this.actionExecutor.dispose();
		this.bus.publish(this.playerId, BUS_EVENT.destroyed);
		this.bus.disposePlayer(this.playerId);
	}
}
