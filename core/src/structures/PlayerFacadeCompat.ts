import type { Player } from "./Player";
import type { Track, SearchResult } from "../types";

/**
 * Compatibility surface for the public Player facade.
 *
 * The implementation deliberately delegates to runtime controllers instead of
 * recreating LegacyPlayer state on Player. This keeps the public API stable
 * while ownership remains in the decomposed runtime.
 */
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
		previous(): Promise<any> | any;
		save(track: Track, options?: any): Promise<any>;
		loop(mode?: any): any;
		autoPlay(enabled?: boolean): boolean;
		setVolume(value: number): number;
		shuffle(): void;
		clearQueue(): void;
		insert(track: Track, index?: number): number;
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
		get previousTrack(): Track | null;
		get upcomingTracks(): Track[];
		get previousTracks(): Track[];
		get availablePlugins(): any[];
		get relatedTracks(): Track[] | null;
		get isLive(): boolean;
		get isIdle(): boolean;
		get isBuffering(): boolean;
	}
}

const proto = (Object.getPrototypeOf as any);

function controller(player: Player, ...names: string[]): any {
	const p: any = player;
	for (const name of names) {
		const value = p[name];
		if (value && typeof value === "object") return value;
	}
	return undefined;
}

function call(player: Player, names: string[], args: any[] = []): any {
	const p: any = player;
	for (const owner of [
		controller(player, "runtime"),
		controller(player, "orchestrator"),
		controller(player, "trackLoader"),
		controller(player, "streamController"),
		controller(player, "playbackController"),
		controller(player, "preloadController"),
		controller(player, "transitionController"),
		controller(player, "queueController"),
		controller(player, "filterController"),
		controller(player, "volumeController"),
		controller(player, "connectionController"),
		controller(player, "lifecycleController"),
	]) {
		if (!owner) continue;
		for (const name of names) {
			const fn = owner[name];
			if (typeof fn === "function") return fn.apply(owner, args);
		}
	}
	return undefined;
}

function define(name: string, value: (...args: any[]) => any): void {
	Object.defineProperty((proto as any)(Object.getPrototypeOf(Player.prototype)), name, { value });
}

// Use Player.prototype directly; the helper above only exists to keep the
// implementation readable when this file is bundled/transpiled.
const PlayerPrototype: any = (await import("./Player")).Player.prototype;

PlayerPrototype.destroyCurrentStream = function(this: Player): void {
	this.playbackController.stop();
	this.streamController.abortCurrent();
};
PlayerPrototype.getCachedSearchResult = function(this: Player, query: string): SearchResult | null {
	return (this.searchController as any).cache?.get?.(query.toLowerCase().trim()) ?? null;
};
PlayerPrototype.cacheSearchResult = function(this: Player, query: string, result: SearchResult): void {
	(this.searchController as any).cacheResult?.(query, result);
};
PlayerPrototype.clearExpiredSearchCache = function(this: Player): void {
	this.searchController.purgeStale();
};
PlayerPrototype.generateWillNext = function(this: Player): Track | null { return this.queueController.willNext; };
PlayerPrototype.preloadNextTrack = function(this: Player): Promise<void> { return this.trackLoader.preloadNext(); };
PlayerPrototype.safeCancelPreload = function(this: Player): Promise<void> { return this.preloadController.cancelSafely(); };
PlayerPrototype.preloadNext = function(this: Player): Promise<void> { return this.preloadController.preload(); };
PlayerPrototype.fadeResourceVolume = async function(this: Player, resource: any, from: number, to: number, durationMs: number): Promise<void> {
	if (!resource?.volume) return;
	const duration = Math.max(0, durationMs);
	if (!duration) { resource.volume.setVolume(to); return; }
	const start = Date.now();
	while (true) {
		const p = Math.min(1, (Date.now() - start) / duration);
		resource.volume.setVolume(from + (to - from) * p);
		if (p >= 1) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
};
PlayerPrototype.applyCrossfadeIn = async function(this: Player, resource: any, track: Track): Promise<void> {
	if (!resource?.volume) return;
	const target = this.getTrackTargetVolume(track);
	resource.volume.setVolume(0);
	await this.fadeResourceVolume(resource, 0, target, this.resolveSmartTransitionDuration(track));
};
PlayerPrototype.applyCrossfadeOutCurrent = async function(this: Player): Promise<void> {
	const resource = this.currentResource ?? this.playbackController.activeResource;
	if (!resource?.volume) return;
	const current = resource.volume.volume ?? this.getTrackTargetVolume(this.currentTrack as Track);
	await this.fadeResourceVolume(resource, current, 0, this.resolveSmartTransitionDuration(this.currentTrack as Track));
};
PlayerPrototype.crossfadeSkipAndStop = async function(this: Player): Promise<void> {
	await this.applyCrossfadeOutCurrent();
	this.playbackController.stop();
};
PlayerPrototype.getTrackMetadataValue = function(this: Player, track: Track, key: string): any {
	return (track as any)?.metadata?.[key];
};
PlayerPrototype.resolveSmartTransitionDuration = function(this: Player, track: Track): number {
	const transition = this.transitionController;
	const plan = transition?.plan?.(this.currentTrack, track);
	return plan?.durationMs ?? transition?.settings?.durationMs ?? 0;
};
PlayerPrototype.maybeAlignToBeatBoundary = async function(this: Player, track?: Track): Promise<void> {
	const t = track ?? this.currentTrack;
	const position = Number((this as any).getTime?.().current ?? 0);
	const wait = this.transitionController?.beatWaitMs?.(t, position) ?? 0;
	if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
};
PlayerPrototype.getTrackTargetVolume = function(this: Player, track: Track): number {
	const measured = Number((track as any)?.metadata?.loudnessGain);
	const settings = this.volumeController.settings;
	if (settings?.enabled && Number.isFinite(measured) && measured > 0) return Math.min(settings.max, Math.max(settings.min, settings.target / measured));
	return this.volume / 100;
};
PlayerPrototype.attemptTrackRecovery = function(this: Player, track: Track, session?: any): Promise<any> {
	if (session) return this.trackLoader.loadWithRecovery(track, session);
	return Promise.reject(new Error("attemptTrackRecovery requires an active PlaybackSession"));
};
PlayerPrototype.cancelPreload = function(this: Player): void { this.preloadController.cancel(); };
PlayerPrototype.clearSlot = function(this: Player): void { this.preloadController.clear(); this.streamController.abortCurrent(); };
PlayerPrototype.promotePreloadToCurrent = function(this: Player, track: Track): any {
	const session = this.orchestrator.currentSession;
	if (!session) return null;
	return this.preloadController.promote(track, { resource: null, track: null, streamId: null, processedStreamId: null, abortController: null, isValid: false, isLoading: false, loadPromise: null } as any);
};
PlayerPrototype.createResource = function(this: Player, stream: any, track: Track): any { return this.playbackController.createResource(stream, track); };
PlayerPrototype.mergeTrackPreserveRef = function(this: Player, target: Track, source: Track): Track { Object.assign(target, source); return target; };
PlayerPrototype.applyTrackMiddleware = async function(this: Player, track: Track): Promise<Track> {
	const middleware = (this as any).options?.trackMiddleware;
	if (Array.isArray(middleware)) for (const fn of middleware) { const result = await fn(track, { player: this, manager: this.manager }); if (result && result !== track) Object.assign(track, result); }
	return track;
};
PlayerPrototype.getStream = async function(this: Player, track: Track): Promise<any> {
	const resolver = (this.trackLoader as any).resolvers?.[0];
	if (typeof resolver === "function") return resolver(track, this.orchestrator.currentSession);
	const extension = await (this.extensionManager as any)?.provideStream?.(track);
	if (extension) return extension;
	return (this.pluginManager as any)?.getStream?.(track);
};
PlayerPrototype.isUnrecoverableStreamError = function(this: Player, error: unknown): boolean {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return name === "AbortError" || /unrecoverable|unsupported|not found|invalid source/.test(message);
};
PlayerPrototype.startTrack = function(this: Player, track: Track, ...args: any[]): Promise<any> { return call(this, ["start"], [track, ...args]) ?? this.action({ type: "PLAY", track } as any); };
PlayerPrototype.startFromPreload = function(this: Player, track: Track, ...args: any[]): Promise<any> { return call(this, ["startFromPreload"], [track, ...args]) ?? this.startTrack(track, ...args); };
PlayerPrototype.loadFreshStream = function(this: Player, track: Track, ...args: any[]): Promise<any> { return this.trackLoader.load(track, args[0] ?? this.orchestrator.currentSession); };
PlayerPrototype.playRemote = async function(this: Player, track: Track, stream: any, ..._args: any[]): Promise<any> { if (stream?.handle?.play) await stream.handle.play(); return true; };
PlayerPrototype.ensureTTSPlayer = function(this: Player): any { return (this as any).runtime?.ttsController?.ensurePlayer?.() ?? (this as any).ttsPlayer ?? null; };
PlayerPrototype.interruptWithTTSTrack = function(this: Player, track: Track, ..._args: any[]): Promise<any> { return this.play(track); };
PlayerPrototype.previous = function(this: Player): any { return this.queueController.previous(); };
PlayerPrototype.save = async function(this: Player, track: Track, options?: any): Promise<any> {
	const result = await (this.extensionManager as any)?.save?.(track, options);
	if (result) return result;
	const plugin = (this.pluginManager as any)?.save;
	if (typeof plugin === "function") return plugin.call(this.pluginManager, track, options);
	throw new Error("No save provider is available for this track");
};
PlayerPrototype.loop = function(this: Player, mode?: any): any { return this.queueController.setLoop(mode); };
PlayerPrototype.autoPlay = function(this: Player, enabled?: boolean): boolean { return this.queueController.setAutoPlay(enabled ?? this.queueController.autoPlay); };
PlayerPrototype.setVolume = function(this: Player, value: number): number { return this.volumeController.setVolume(value); };
PlayerPrototype.shuffle = function(this: Player): void { this.queue.shuffle(); this.queueController.snapshot(); };
PlayerPrototype.clearQueue = function(this: Player): void { this.queueController.clear(); };
PlayerPrototype.insert = function(this: Player, track: Track, index = 0): number { return this.queueController.insert(track, index); };
PlayerPrototype.remove = function(this: Player, index: number): Track | null { return this.queueController.remove(index); };
PlayerPrototype.scheduleLeave = function(this: Player): void { this.lifecycleController.scheduleLeave?.(); };
PlayerPrototype.refreshPlayerResource = function(this: Player, position = 0): Promise<boolean> { return this.bus.request({ type: "[Player]->[Resource]:refresh", requestId: `${this.guildId}:${Date.now()}`, position } as any).then(() => true).catch(() => false); };
PlayerPrototype.getExtensions = function(this: Player): any[] { return (this.extensionManager as any)?.getAll?.() ?? []; };
PlayerPrototype.clearLeaveTimeout = function(this: Player): void { this.lifecycleController.clearLeaveTimeout?.(); };
PlayerPrototype.setupEventListeners = function(this: Player): void { /* listeners are owned by runtime/event bridge */ };
PlayerPrototype.saveSession = function(this: Player, options?: any): any { return this.getSerializableState(options); };
PlayerPrototype.exitRemoteMode = function(this: Player): void { (this as any).playbackMode = "NATIVE"; };
PlayerPrototype.getSerializableState = function(this: Player): any {
	return { guildId: this.guildId, queue: this.queue.toJSON?.(), volume: this.volume, playbackMode: (this as any).playbackMode };
};
PlayerPrototype.restoreState = function(this: Player, state: any): void {
	if (state?.queue) this.queue.fromJSON?.(state.queue);
	if (typeof state?.volume === "number") this.setVolume(state.volume);
	if (state?.playbackMode !== undefined) (this as any).playbackMode = state.playbackMode;
};
PlayerPrototype.getStreamManagerStats = function(this: Player): any { return (this.streamManager as any)?.getStats?.() ?? {}; };
Object.defineProperties(PlayerPrototype, {
	previousTrack: { configurable: true, get() { return this.queue?.previousTracks?.at?.(-1) ?? null; } },
	upcomingTracks: { configurable: true, get() { return this.queueController?.snapshot?.() ?? []; } },
	previousTracks: { configurable: true, get() { return this.queue?.previousTracks ?? []; } },
	availablePlugins: { configurable: true, get() { return this.pluginManager?.getAll?.() ?? []; } },
	relatedTracks: { configurable: true, get() { return this.queueController?.relatedTracks ?? null; } },
	isLive: { configurable: true, get() { return Boolean(this.currentTrack?.isLive); } },
	isIdle: { configurable: true, get() { return this.playbackController?.status === "idle"; } },
	isBuffering: { configurable: true, get() { return this.playbackController?.status === "buffering"; } },
});

export {};
