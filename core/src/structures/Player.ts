import { EventEmitter } from "events";
import { Stream } from "stream";
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
} from "../types";
import { PlaybackMode } from "../types";
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
import { PlayerCapabilities, createPlayerCapabilities } from "../capabilities/PlayerCapabilities";
import type { PlayerQueue } from "../controller/QueueController";

export class Player extends EventEmitter {
	public readonly bus: Bus;
	public readonly actionExecutor: PlayerAction;
	public readonly capabilities: PlayerCapabilities;
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
		this.capabilities = createPlayerCapabilities(this.bus, this.playerId);
		this.bus.publish(this.playerId, "initialized");
		this.bus.publish(this.playerId, "ready");
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

	public get currentTrack(): Track | null {
		return this.bus.querySync(this.playerId, "currentTrack");
	}
	public get audioPlayer() {
		return this.bus.querySync(this.playerId, "audioPlayer");
	}
	public get currentResource(): AudioResource | null {
		return this.bus.querySync(this.playerId, "currentResource") as AudioResource | null;
	}
	public get connection(): VoiceConnection | null {
		return this.bus.querySync(this.playerId, "connection") ?? null;
	}
	public get playbackMode(): PlaybackMode {
		return this.bus.querySync(this.playerId, "playbackMode") ?? PlaybackMode.NATIVE;
	}
	public get forwardLeader(): any {
		return this.bus.querySync(this.playerId, "forwardLeader");
	}
	public get forwardFollowers(): ReadonlySet<any> {
		return this.bus.querySync(this.playerId, "forwardFollowers") ?? new Set();
	}
	/**
	 * Queue of this player (add / insert / remove / move / swap / shuffle / loop / history ...).
	 *
	 * Resolved through the Bus on every access, so it always points at the state the shared
	 * `QueueController` keeps for this `playerId`; the Player never stores a queue of its own.
	 * Throws once the player has been destroyed (its queue state is released).
	 */
	public get queue(): PlayerQueue {
		const queue = this.bus.querySync(this.playerId, "queueState");
		if (!queue) throw new Error(`Queue is not available for player "${this.playerId}" (destroyed or not attached)`);
		return queue;
	}
	public get queueSize(): number {
		return this.bus.querySync(this.playerId, "queue")?.length ?? 0;
	}
	public get isPlaying(): boolean {
		return this.bus.querySync(this.playerId, "isPlaying");
	}
	public get isPaused(): boolean {
		return this.bus.querySync(this.playerId, "isPaused");
	}
	public get isLive(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}
	public get isIdle(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isIdle ?? true;
		return this.bus.querySync(this.playerId, "playerState") === "idle";
	}
	public get isBuffering(): boolean {
		if (this.playbackMode === PlaybackMode.FORWARD) return this.forwardLeader?.isBuffering ?? false;
		return this.bus.querySync(this.playerId, "playerState") === "buffering";
	}
	public get volume(): number {
		return this.bus.querySync(this.playerId, "volume");
	}
	public set volume(value: number) {
		this.bus.requestRpcSync<{ value: number }, number>(this.playerId, "volume.set", { value });
	}
	public get previousTrack(): Track | null {
		return this.bus.querySync(this.playerId, "previousTrack");
	}
	public get upcomingTracks(): Track[] {
		return this.bus.querySync(this.playerId, "queue") ?? [];
	}
	public get previousTracks(): Track[] {
		return this.bus.querySync(this.playerId, "previousTracks") ?? [];
	}
	public get availablePlugins(): string[] {
		return (this.bus.querySync(this.playerId, "availablePlugins") ?? []).map((plugin) => plugin.name);
	}
	public get relatedTracks(): Track[] {
		return this.bus.querySync(this.playerId, "relatedTracks") ?? [];
	}
	public search(query: string, requestedBy: string): Promise<SearchResult> {
		return this.bus.requestRpc(this.playerId, "search", { query, requestedBy });
	}
	public getCachedSearchResult(query: string): Promise<SearchResult | null> {
		return this.bus.requestRpc(this.playerId, "search.cache.get", { query });
	}
	public cacheSearchResult(query: string, result: SearchResult): Promise<void> {
		return this.bus.requestRpc(this.playerId, "search.cache.set", { query, result });
	}
	public clearSearchCache(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "search.cache.clear", {});
	}
	public clearExpiredSearchCache(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "search.cache.purge", {});
	}
	public debugSearchQuery(query: string): Promise<SearchDebugResult> {
		return this.bus.requestRpc(this.playerId, "search.debug", { query });
	}
	public createRelatedTracks(track?: Track | null): Promise<Track[]> {
		return this.bus.requestRpc(this.playerId, "playback.createRelatedTracks", { track });
	}
	public async connect(channel: VoiceChannel): Promise<VoiceConnection> {
		return this.bus
			.request(this.playerId, { type: "[Player]->[Connection]:connect", requestId: createPlayerRequestId(), channel })
			.then((e) => e.connection);
	}
	public async disconnect(): Promise<void> {
		return this.bus
			.request(this.playerId, { type: "[Player]->[Connection]:disconnect", requestId: createPlayerRequestId() })
			.then(() => undefined);
	}
	public async play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean> {
		const generation = ++this.playGeneration;
		const controller = new AbortController();
		this.playAbortController?.abort();
		this.playAbortController = controller;
		const operation = this.playOperation
			.catch(() => false)
			.then(() => {
				if (generation !== this.playGeneration || controller.signal.aborted) return false;
				return this.bus
					.requestRpc(this.playerId, "play", { query, requestedBy }, { signal: controller.signal })
					.then((result) => (generation === this.playGeneration ? result : false));
			});
		this.playOperation = operation;
		return operation.finally(() => {
			if (this.playAbortController === controller) this.playAbortController = null;
		});
	}
	public async playNext(): Promise<boolean> {
		if (this.destroyed) return false;
		return this.action({ type: "SKIP" })
			.then(() => this.isPlaying || this.currentTrack !== null)
			.catch(() => false);
	}
	public pause(): boolean {
		this.invalidatePlay();
		void this.action({ type: "PAUSE" });
		return true;
	}
	public resume(): boolean {
		void this.action({ type: "RESUME" });
		return true;
	}
	public stop(): boolean {
		this.invalidatePlay();
		void this.action({ type: "STOP" });
		return true;
	}
	public async seek(position: number): Promise<boolean> {
		this.invalidatePlay();
		return this.action({ type: "SEEK", position })
			.then(() => true)
			.catch(() => false);
	}
	public skip(): boolean {
		this.invalidatePlay();
		void this.action({ type: "SKIP" });
		return true;
	}
	private invalidatePlay(): void {
		this.playGeneration++;
		this.playAbortController?.abort();
	}
	public destroyCurrentStream(): void {
		void this.bus.action(this.playerId, { type: "STOP" });
	}
	public generateWillNext(): Track | null {
		return this.bus.querySync(this.playerId, "willNext");
	}
	public preloadNextTrack(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "preload.next", undefined);
	}
	public safeCancelPreload(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "preload.cancelSafe", undefined);
	}
	public preloadNext(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "preload.next", undefined);
	}
	public cancelPreload(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, "preload.cancel", undefined);
	}
	public clearSlot(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, "preload.clear", undefined);
	}
	public async fadeResourceVolume(resource: AudioResource, from: number, to: number, durationMs: number): Promise<void> {
		return this.bus.requestRpc(this.playerId, "transition.fade", { resource, from, to, durationMs });
	}
	public async applyCrossfadeIn(resource: AudioResource, track: Track): Promise<void> {
		return this.bus.requestRpc(this.playerId, "transition.fadeIn", { resource, track });
	}
	public async applyCrossfadeOutCurrent(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "transition.fadeOutCurrent", undefined);
	}
	public async crossfadeSkipAndStop(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "transition.skipAndStop", undefined);
	}
	public getTrackMetadataValue(track: Track, key: string): any {
		return track?.metadata?.[key];
	}
	public resolveSmartTransitionDuration(track: Track): number {
		return this.bus.requestRpcSync(this.playerId, "transition.duration", { from: this.currentTrack, to: track });
	}
	public async maybeAlignToBeatBoundary(track?: Track): Promise<void> {
		const wait = this.bus.requestRpcSync<{ track: Track | null; positionMs: number }, number>(
			this.playerId,
			"transition.beatWait",
			{ track: track ?? this.currentTrack, positionMs: this.getTime().current },
		);
		if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
	}
	public getTrackTargetVolume(track: Track): number {
		return this.bus.requestRpcSync<{ track: Track | null }, number>(this.playerId, "transition.targetVolume", { track });
	}
	public attemptTrackRecovery(track: Track, session?: PlaybackSession): Promise<TrackLoadResult> {
		if (!session) return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession"));
		return this.bus.requestRpc(this.playerId, "playback.recover", { track, session });
	}
	public promotePreloadToCurrent(track: Track): AudioResource | null {
		return this.bus.requestRpcSync(this.playerId, "playback.promotePreload", { track });
	}
	public createResource(stream: Stream.Readable, track: Track): AudioResource {
		return this.bus.requestRpcSync(this.playerId, "resource.create", { stream, track });
	}
	public mergeTrackPreserveRef(target: Track, source: Track): Track {
		Object.assign(target, source);
		return target;
	}
	public async applyTrackMiddleware(track: Track): Promise<Track> {
		return this.bus.requestRpc(this.playerId, "track.middleware", { track });
	}
	public async getStream(track: Track): Promise<StreamInfo | TrackLoadResult | null> {
		if (this.bus.querySync(this.playerId, "playbackSession"))
			return this.bus.requestRpc(this.playerId, "playback.loadFreshCurrent", { track });
		return this.bus.requestRpc(this.playerId, "stream.resolve", { track });
	}
	public isUnrecoverableStreamError(error: unknown): boolean {
		const name = error instanceof Error ? error.name : "";
		const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		return name === "AbortError" || /unrecoverable|unsupported|not found|invalid source/.test(message);
	}
	public startTrack(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: "PLAY", track });
	}
	public startFromPreload(track: Track, ..._args: any[]): Promise<void> {
		return this.action({ type: "PLAY", track });
	}
	public loadFreshStream(track: Track, session: PlaybackSession): Promise<TrackLoadResult> {
		return this.bus.requestRpc(this.playerId, "playback.loadFresh", { track, session });
	}
	public async playRemote(_track: Track, stream: any, ..._args: any[]): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, "playback.remote", { track: _track, stream });
	}
	public ensureTTSPlayer(): boolean {
		return this.bus.querySync(this.playerId, "tts.hasPlayer") ?? false;
	}
	public interruptWithTTSTrack(track: Track, ..._args: any[]): Promise<boolean> {
		return this.play(track);
	}
	public async previous(): Promise<boolean> {
		const track = this.bus.requestRpcSync<void, Track | null>(this.playerId, "queue.previous", undefined);
		if (!track) return false;
		await this.startTrack(track);
		return true;
	}
	async save(track: Track, options?: SaveOptions | string): Promise<Stream.Readable> {
		try {
			return await this.bus.requestRpc(this.playerId, "save", { track, options });
		} catch (error) {
			this.debug("[Player] save error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	async saveVideo(track: Track, options?: SaveVideoOptions | string): Promise<Stream.Readable> {
		if (!track) throw new TypeError("A track is required to save video");
		try {
			return await this.bus.requestRpc(this.playerId, "save.video", { track, options });
		} catch (error) {
			this.debug("[Player] saveVideo error:", error);
			this.emit("playerError", error as Error, track);
			throw error;
		}
	}
	public loop(mode?: any): any {
		return mode === undefined ?
				this.bus.querySync(this.playerId, "queueLoop")
			:	this.bus.requestRpcSync(this.playerId, "queue.loop", { mode });
	}
	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ?
				this.bus.querySync(this.playerId, "queueAutoPlay")
			:	this.bus.requestRpcSync(this.playerId, "queue.autoPlay", { enabled });
	}
	public setWillNext(track: Track | null): Track | null {
		return this.bus.requestRpcSync(this.playerId, "queue.willNext", { track });
	}
	public setCurrentTrack(track: Track | null): void {
		void this.action({ type: "QUEUE_SET_CURRENT", track });
	}
	public setVolume(value: number): boolean {
		if (!Number.isFinite(value) || value < 0 || value > 100) return false;
		this.bus.requestRpcSync(this.playerId, "volume.set", { value });
		return true;
	}
	public shuffle(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, "queue.shuffle", undefined);
	}
	public clearQueue(): void {
		this.bus.requestRpcSync<void, void>(this.playerId, "queue.clear", undefined);
	}
	public async insert(query: string | Track | Track[], index = 0, requestedBy?: string): Promise<boolean> {
		return this.bus
			.requestRpc<
				{ query: string | Track | Track[]; index: number; requestedBy?: string },
				boolean
			>(this.playerId, "queue.insert", { query, index, requestedBy })
			.catch(() => false);
	}
	public remove(index: number): Track | null {
		return this.bus.requestRpcSync<{ index: number }, Track | null>(this.playerId, "queue.remove", { index });
	}
	public scheduleLeave(): void {
		this.bus.requestRpcSync(this.playerId, "lifecycle.scheduleLeave", {});
	}
	public clearLeaveTimeout(): void {
		this.bus.requestRpcSync(this.playerId, "lifecycle.clearLeaveTimeout", undefined);
	}
	public refreshPlayerResource(position = 0): Promise<boolean> {
		return this.bus
			.request(this.playerId, { type: "[Player]->[Resource]:refresh", requestId: createPlayerRequestId(), position } as any)
			.then(() => true)
			.catch(() => false);
	}
	public getExtensions(): any[] {
		return this.bus.querySync(this.playerId, "extensions") ?? [];
	}
	public saveSession(_options?: any): any {
		return this.getSerializableState();
	}
	public exitRemoteMode(): void {
		this.unsubscribeForward("remote mode exited");
	}
	public getSerializableState(): any {
		return {
			playerId: this.playerId,
			queue: this.bus.requestRpcSync(this.playerId, "queue.serialize", undefined),
			volume: this.volume,
			playbackMode: this.playbackMode,
		};
	}
	public restoreState(state: any): void {
		if (state?.queue) this.bus.requestRpcSync(this.playerId, "queue.restore", { state: state.queue });
		if (typeof state?.volume === "number") this.setVolume(state.volume);
	}
	public getStreamManagerStats(): any {
		return this.bus.requestRpcSync(this.playerId, "stream.stats", undefined) ?? {};
	}
	public getTime() {
		const session = this.bus.querySync(this.playerId, "playbackSession");
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive) return { current: 0, total: 0, format: "LIVE", formatted: { current: "LIVE", total: "LIVE" } };
		if (!track) return { current: 0, total: 0, format: "00:00", formatted: { current: "00:00", total: "00:00" } };
		const total = Math.floor(track.duration > 1000 ? track.duration : track.duration * 1000) | 0;
		const current = Math.max(0, Math.floor(this.bus.querySync(this.playerId, "position") ?? session?.position ?? 0)) | 0;
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
		const session = this.bus.querySync(this.playerId, "playbackSession");
		const track = session?.track ?? this.currentTrack;
		const isLive = Boolean(track?.isLive);
		if (isLive || !track) return isLive ? "🔴 LIVE" : "";
		const total = track.duration > 1000 ? track.duration : track.duration * 1000;
		const current = Math.max(0, Number(this.bus.querySync(this.playerId, "position") ?? session?.position ?? 0));
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
		this.bus.requestRpcSync<{ plugin: BasePlugin }, void>(this.playerId, "plugin.add", { plugin });
	}
	public removePlugin(name: string): boolean {
		return this.bus.requestRpcSync<{ name: string }, boolean>(this.playerId, "plugin.remove", { name });
	}
	public attachExtension(extension: BaseExtension): void {
		this.bus.requestRpcSync<{ extension: BaseExtension }, void>(this.playerId, "extension.add", { extension });
	}
	public detachExtension(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync<{ extension: BaseExtension }, boolean>(this.playerId, "extension.remove", { extension });
	}
	public subscribeTo(leader: Player | string, options?: { forwardMode?: boolean }): boolean {
		return this.bus.requestRpcSync(this.playerId, "forward.subscribe", { leader, options });
	}
	public unsubscribeForward(reason?: string): boolean {
		return this.bus.requestRpcSync(this.playerId, "forward.unsubscribe", { reason });
	}
	public getForwardHealthStatus() {
		return this.bus.requestRpcSync(this.playerId, "forward.health", undefined);
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
			const exts = this.getExtensions();
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
		this.bus.publish(this.playerId, "destroyed");
		this.bus.disposePlayer(this.playerId);
	}
}
