import { Player } from "./Player";
import type { Track, SearchResult } from "../types";

declare module "./Player" {
	interface Player {
		destroyCurrentStream(): void;
		getCachedSearchResult(query: string): SearchResult | null;
		cacheSearchResult(query: string, result: SearchResult): void;
		clearExpiredSearchCache(): void;
		generateWillNext(): Track | null;
		preloadNextTrack(): Promise<void>;
		safeCancelPreload(): Promise<void>;
		preloadNext(): Promise<void>;
		fadeResourceVolume(resource: any, from: number, to: number, durationMs: number): Promise<void>;
		applyCrossfadeIn(resource: any, track: Track): Promise<void>;
		applyCrossfadeOutCurrent(): Promise<void>;
		crossfadeSkipAndStop(): Promise<void>;
		getTrackMetadataValue(track: Track, key: string): any;
		resolveSmartTransitionDuration(track: Track): number;
		maybeAlignToBeatBoundary(track?: Track): Promise<void>;
		getTrackTargetVolume(track: Track): number;
		attemptTrackRecovery(track: Track, session?: any): Promise<any>;
		cancelPreload(): void;
		clearSlot(): void;
		promotePreloadToCurrent(track: Track): any;
		createResource(stream: any, track: Track): any;
		mergeTrackPreserveRef(target: Track, source: Track): Track;
		applyTrackMiddleware(track: Track): Promise<Track>;
		getStream(track: Track): Promise<any>;
		isUnrecoverableStreamError(error: unknown): boolean;
		startTrack(track: Track, ...args: any[]): Promise<any>;
		startFromPreload(track: Track, ...args: any[]): Promise<any>;
		loadFreshStream(track: Track, ...args: any[]): Promise<any>;
		playRemote(track: Track, stream: any, ...args: any[]): Promise<any>;
		ensureTTSPlayer(): any;
		interruptWithTTSTrack(track: Track, ...args: any[]): Promise<any>;
		previous(): any;
		save(track: Track, options?: any): Promise<any>;
		loop(mode?: any): any;
		autoPlay(enabled?: boolean): boolean;
		setVolume(value: number): number;
		shuffle(): void;
		clearQueue(): void;
		remove(index: number): Track | null;
		scheduleLeave(): void;
		refreshPlayerResource(position?: number): Promise<boolean>;
		getExtensions(): any[];
		clearLeaveTimeout(): void;
		setupEventListeners(): void;
		saveSession(options?: any): any;
		exitRemoteMode(): void;
		getSerializableState(): any;
		restoreState(state: any): void;
		getStreamManagerStats(): any;
		readonly previousTrack: Track | null;
		readonly upcomingTracks: Track[];
		readonly previousTracks: Track[];
		readonly availablePlugins: any[];
		readonly relatedTracks: Track[] | null;
	}
}

/** Transitional compatibility layer for facade methods not yet migrated. */
const P: any = new Proxy(Player.prototype, {
	set(target, property, value) { if (property in target) return true; Reflect.set(target, property, value); return true; },
	defineProperty(target, property, descriptor) { if (property in target) return true; Reflect.defineProperty(target, property, descriptor); return true; },
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

P.destroyCurrentStream = function (this: Player) { this.streamController.abortCurrent(); this.playbackController.stop(); };
P.getCachedSearchResult = function (this: Player, q: string) { return (this.searchController as any).cache?.get?.(q.toLowerCase().trim()) ?? null; };
P.cacheSearchResult = function (this: Player, q: string, r: SearchResult) { (this.searchController as any).cacheResult?.(q, r); };
P.clearExpiredSearchCache = function (this: Player) { this.searchController.purgeStale(); };
P.generateWillNext = function (this: Player) { return this.queueController.willNext; };
P.preloadNextTrack = function (this: Player) { return this.trackLoader.preloadNext(); };
P.safeCancelPreload = function (this: Player) { return this.preloadController.cancelSafely(); };
P.preloadNext = function (this: Player) { return this.preloadController.preload(); };
P.fadeResourceVolume = async function (this: Player, resource: any, from: number, to: number, durationMs: number) { if (!resource?.volume) return; const duration = Math.max(0, durationMs); if (!duration) { resource.volume.setVolume(to); return; } const start = Date.now(); for (;;) { const p = Math.min(1, (Date.now() - start) / duration); resource.volume.setVolume(from + (to - from) * p); if (p >= 1) return; await sleep(25); } };
P.applyCrossfadeIn = async function (this: Player, resource: any, track: Track) { if (!resource?.volume) return; const target = this.getTrackTargetVolume(track); resource.volume.setVolume(0); await this.fadeResourceVolume(resource, 0, target, this.resolveSmartTransitionDuration(track)); };
P.applyCrossfadeOutCurrent = async function (this: Player) { const r = this.currentResource ?? this.playbackController.activeResource; if (!r?.volume) return; await this.fadeResourceVolume(r, r.volume.volume ?? this.getTrackTargetVolume(this.currentTrack as Track), 0, this.resolveSmartTransitionDuration(this.currentTrack as Track)); };
P.crossfadeSkipAndStop = async function (this: Player) { await this.applyCrossfadeOutCurrent(); this.playbackController.stop(); };
P.getTrackMetadataValue = function (this: Player, track: Track, key: string) { return (track as any)?.metadata?.[key]; };
P.resolveSmartTransitionDuration = function (this: Player, track: Track) { return this.transitionController.plan(this.currentTrack, track).durationMs; };
P.maybeAlignToBeatBoundary = async function (this: Player, track?: Track) { const wait = this.transitionController.beatWaitMs(track ?? this.currentTrack, this.getTime().current); if (wait > 0) await sleep(wait); };
P.getTrackTargetVolume = function (this: Player, track: Track) { const s = this.volumeController.settings; const lufs = Number((track as any)?.metadata?.lufs); if (!s.enabled || !Number.isFinite(lufs)) return this.volume / 100; const correctionDb = Math.max(-s.maxCutDb, Math.min(s.maxBoostDb, s.targetLUFS - lufs)); const gain = Math.pow(10, correctionDb / 20); const ceiling = Math.pow(10, s.limiterCeiling / 20); return Math.min((this.volume / 100) * gain, ceiling); };
P.attemptTrackRecovery = function (this: Player, track: Track, session?: any) { if (!session) return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession")); return this.trackLoader.loadWithRecovery(track, session); };
P.cancelPreload = function (this: Player) { this.preloadController.cancel(); };
P.clearSlot = function (this: Player) { this.preloadController.clear(); this.streamController.abortCurrent(); };
P.promotePreloadToCurrent = function (this: Player, track: Track) { const s = this.orchestrator.currentSession; if (!s) return null; return this.preloadController.promote(track, { resource: null, track: null, streamId: null, processedStreamId: null, abortController: null, isValid: false, isLoading: false, loadPromise: null } as any); };
P.createResource = function (this: Player, stream: any, track: Track) { return this.playbackController.createResource(stream, track); };
P.mergeTrackPreserveRef = function (this: Player, target: Track, source: Track) { Object.assign(target, source); return target; };
P.applyTrackMiddleware = async function (this: Player, track: Track) { const m: any = this.options?.trackMiddleware; if (Array.isArray(m)) for (const fn of m) { const r = await fn(track, { player: this, manager: this.manager }); if (r && r !== track) Object.assign(track, r); } return track; };
P.getStream = async function (this: Player, track: Track) { const session = this.orchestrator.currentSession; if (session) return this.trackLoader.load(track, session); const e = await (this.extensionManager as any)?.provideStream?.(track); return e ?? (this.pluginManager as any)?.getStream?.(track); };
P.isUnrecoverableStreamError = function (this: Player, error: unknown) { const n = error instanceof Error ? error.name : ""; const m = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(); return n === "AbortError" || /unrecoverable|unsupported|not found|invalid source/.test(m); };
P.startTrack = function (this: Player, track: Track) { return this.action({ type: "PLAY", track } as any); };
P.startFromPreload = function (this: Player, track: Track) { return this.action({ type: "PLAY", track } as any); };
P.loadFreshStream = function (this: Player, track: Track, session?: any) { return this.trackLoader.load(track, session ?? this.orchestrator.currentSession); };
P.playRemote = async function (_this: Player, _track: Track, stream: any) { if (stream?.handle?.play) await stream.handle.play(); return true; };
P.ensureTTSPlayer = function (this: Player) { return !!this.ttsController?.ttsPlayer; };
P.interruptWithTTSTrack = function (this: Player, track: Track) { return this.play(track); };
P.previous = function (this: Player) { return this.queueController.previous(); };
P.save = async function (this: Player, track: Track, options?: any) { const e = await (this.extensionManager as any)?.save?.(track, options); if (e) return e; const p = (this.pluginManager as any)?.save; if (typeof p === "function") return p.call(this.pluginManager, track, options); throw new Error("No save provider is available for this track"); };
P.loop = function (this: Player, mode?: any) { return mode === undefined ? this.queueController.loop : this.queueController.setLoop(mode); };
P.autoPlay = function (this: Player, enabled?: boolean) { return enabled === undefined ? this.queueController.autoPlay : this.queueController.setAutoPlay(enabled); };
P.setVolume = function (this: Player, value: number) { return this.volumeController.setVolume(value); };
P.shuffle = function (this: Player) { this.queue.shuffle(); this.bus.publish("queueChanged", this.queueController.snapshot()); };
P.clearQueue = function (this: Player) { this.queueController.clear(); };
P.insert = function (this: Player, track: Track, index = 0) { return this.queueController.insert(track, index); };
P.remove = function (this: Player, index: number) { return this.queueController.remove(index); };
P.scheduleLeave = function (this: Player) { (this.lifecycleController as any).scheduleLeave?.(); };
P.refreshPlayerResource = function (this: Player, position = 0) { return this.bus.request({ type: "[Player]->[Resource]:refresh", requestId: `${this.guildId}:${Date.now()}`, position } as any).then(() => true).catch(() => false); };
P.getExtensions = function (this: Player) { return (this.extensionManager as any)?.getAll?.() ?? []; };
P.clearLeaveTimeout = function (this: Player) { (this.lifecycleController as any).clearLeaveTimeout?.(); };
P.setupEventListeners = function (_this: Player) {};
P.saveSession = function (this: Player) { return this.getSerializableState(); };
P.exitRemoteMode = function (this: Player) { this.playbackMode = "NATIVE"; };
P.getSerializableState = function (this: Player) { return { guildId: this.guildId, queue: this.queue.toJSON?.(), volume: this.volume, playbackMode: this.playbackMode }; };
P.restoreState = function (this: Player, state: any) { if (state?.queue) this.queue.fromJSON?.(state.queue); if (typeof state?.volume === "number") this.setVolume(state.volume); if (state?.playbackMode !== undefined) this.playbackMode = state.playbackMode; };
P.getStreamManagerStats = function (this: Player) { return this.streamManager?.getStats?.() ?? {}; };

const toMilliseconds = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
P.formatTime = function (this: Player, ms: number) { const totalSeconds = Math.floor(toMilliseconds(ms) / 1000); const hours = Math.floor(totalSeconds / 3600); const minutes = Math.floor((totalSeconds % 3600) / 60); const seconds = totalSeconds % 60; return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`; };
P.formatTimeCompact = function (this: Player, ms: number) { const totalSeconds = Math.floor(toMilliseconds(ms) / 1000); const hours = Math.floor(totalSeconds / 3600); const minutes = Math.floor((totalSeconds % 3600) / 60); const seconds = totalSeconds % 60; return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`; };
P.getTime = function (this: Player) { const track = this.currentTrack; const resource = this.currentResource ?? this.playbackController?.activeResource; if (track?.isLive) return { current: 0, total: 0, format: "LIVE", formatted: { current: "LIVE", total: "LIVE" } }; const total = toMilliseconds(track?.duration); const current = Math.min(total || Number.MAX_SAFE_INTEGER, toMilliseconds(resource?.playbackDuration)); const safeCurrent = Number.isSafeInteger(current) ? current : 0; return { current: safeCurrent, total, format: this.formatTime(safeCurrent), formatted: { current: this.formatTimeCompact(safeCurrent), total: this.formatTimeCompact(total) } }; };
P.getProgressBar = function (this: Player, options: any = {}) { const { size = 20, barChar = "▬", progressChar = "🔘", timeFormat = "compact", showPercentage = false, showTime = true, hideProgressChar = false } = options; const length = Math.max(1, Math.floor(Number(size) || 20)); const track = this.currentTrack; if (track?.isLive) return "🔴 LIVE"; if (!track) return ""; const total = toMilliseconds(track.duration); const resource = this.currentResource ?? this.playbackController?.activeResource; const current = Math.min(total, toMilliseconds(resource?.playbackDuration)); const ratio = total > 0 ? current / total : 0; const cursorIndex = Math.min(length - 1, Math.floor(ratio * (length - 1))); const bar = hideProgressChar || progressChar === "none" ? barChar.repeat(length) : barChar.repeat(cursorIndex) + progressChar + barChar.repeat(length - cursorIndex - 1); const format = timeFormat === "full" ? this.formatTime : this.formatTimeCompact; let result = showTime ? `${format(current)} ${bar} ${format(total)}` : bar; if (showPercentage) result += ` (${Math.round(ratio * 100)}%)`; return result; };

Object.defineProperties(P, {
	previousTrack: { configurable: true, get(this: Player) { return this.queue?.previousTracks?.at?.(-1) ?? null; } },
	upcomingTracks: { configurable: true, get(this: Player) { return this.queueController?.snapshot?.() ?? []; } },
	previousTracks: { configurable: true, get(this: Player) { return this.queue?.previousTracks ?? []; } },
	availablePlugins: { configurable: true, get(this: Player) { return this.pluginManager?.getAll?.() ?? []; } },
	relatedTracks: { configurable: true, get(this: Player) { return this.queueController?.relatedTracks ?? null; } },
});
