import type { BaseExtension } from "../extensions/BaseExtension";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";
import type { LoopMode } from "../types";
import type { Bus } from "../structures/Bus";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

/** Bus-only capabilities exposed by Player; no controller references escape the runtime. */
export class PlayerCapabilities {
	public readonly queue: QueueCapability;
	public readonly plugins: PluginCapability;
	public readonly extensions: ExtensionCapability;
	public readonly stream: StreamCapability;
	public readonly preload: PreloadCapability;
	public readonly filter: FilterCapability;

	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {
		this.queue = new QueueCapability(bus, playerId);
		this.plugins = new PluginCapability(bus, playerId);
		this.extensions = new ExtensionCapability(bus, playerId);
		this.stream = new StreamCapability(bus, playerId);
		this.preload = new PreloadCapability(bus, playerId);
		this.filter = new FilterCapability(bus, playerId);
	}
}

export function createPlayerCapabilities(bus: Bus, playerId: string): PlayerCapabilities {
	return new PlayerCapabilities(bus, playerId);
}

export class QueueCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public add(track: Track): Promise<number> | number {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.queueAdd, { track });
	}

	public remove(index: number): Promise<Track | null> | Track | null {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.queueRemove, { index });
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.queueClear, undefined as any);
	}

	public get tracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queue) ?? [];
	}

	public get currentTrack(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.currentTrack);
	}

	public get nextTrack(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queueNextTrack);
	}

	public get previousTrack(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.previousTrack);
	}

	public get previousTracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.previousTracks) ?? [];
	}

	public get relatedTracks(): Track[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.relatedTracks) ?? [];
	}

	public get willNext(): Track | null {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.willNext);
	}

	public get length(): number {
		return this.tracks.length;
	}

	public get size(): number {
		return this.tracks.length;
	}

	public get isEmpty(): boolean {
		return this.tracks.length === 0;
	}

	public get loopMode(): LoopMode {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queueLoop);
	}

	public get autoPlayEnabled(): boolean {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.queueAutoPlay);
	}

	public addMultiple(tracks: Track[]): number {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueAddMultiple, { tracks });
	}

	public insert(track: Track, index = this.length): boolean | number {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueInsert, { query: track, index });
	}

	public removeMultiple(indices: number[]): Track[] {
		return [...indices]
			.sort((a, b) => b - a)
			.map((index) => this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueRemove, { index }))
			.filter((track): track is Track => track !== null);
	}

	public shuffle(): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueShuffle, undefined);
	}

	public previous(): Track | null {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queuePrevious, undefined);
	}

	public loop(mode?: LoopMode): LoopMode {
		return mode === undefined ? this.loopMode : this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueLoop, { mode });
	}

	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ?
				this.autoPlayEnabled
			:	this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueAutoPlay, { enabled });
	}

	public setWillNext(track: Track | null): Track | null {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueWillNext, { track });
	}

	public setCurrent(track: Track | null): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueSetCurrent, { track });
	}

	public serialize(): object {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueSerialize, undefined);
	}

	public restore(state: object): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.queueRestore, { state });
	}
}

export class PluginCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public get(name: string): any {
		try {
			return (
				this.bus.querySync(this.playerId, "plugin.get" as any) ??
				this.bus.requestRpcSync(this.playerId, PLAYER_RPC.pluginGet, { name })
			);
		} catch {
			return undefined;
		}
	}

	public list(): any[] {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.pluginList) ??
			this.bus.querySync(this.playerId, PLAYER_QUERY.availablePlugins) ??
			[]
		);
	}

	public get available(): string[] {
		return (this.bus.querySync(this.playerId, PLAYER_QUERY.availablePlugins) ?? []).map((plugin) => plugin.name);
	}

	public add(plugin: BasePlugin): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.pluginAdd, { plugin });
	}

	public register(plugin: BasePlugin): void {
		this.add(plugin);
	}

	public remove(name: string): boolean {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.pluginRemove, { name });
	}

	public clear(): void {
		try {
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.pluginClear, undefined);
		} catch {}
	}

	public getStats(): object {
		try {
			return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.pluginStats, undefined);
		} catch {
			return { totalPlugins: 0, pluginNames: [], streamCacheSize: 0, searchCacheSize: 0, pendingStreams: 0, pendingSearches: 0 };
		}
	}

	public getStream(track: Track): Promise<any> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.streamResolve, { track });
	}
}

export class ExtensionCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public list(): any[] {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.extensionList) ??
			this.bus.querySync(this.playerId, PLAYER_QUERY.extensions) ??
			[]
		);
	}

	public get(name: string): any {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.extensionGet, { name });
	}

	public enable(name: string): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.extensionEnable, { name });
	}

	public disable(name: string): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.extensionDisable, { name });
	}

	public get all(): any[] {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.extensions) ?? [];
	}

	public add(extension: BaseExtension): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.extensionAdd, { extension });
	}

	public remove(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.extensionRemove, { extension });
	}
}

export class StreamCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getState(): any {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.streamState) ??
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.streamState, {})
		);
	}

	public getCurrent(): any {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.streamCurrent) ??
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.streamCurrent, {})
		);
	}

	public stats(): any {
		return this.bus.requestRpcSync(this.playerId, PLAYER_RPC.streamState, undefined) ?? {};
	}
}

export class PreloadCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getState(): any {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.preloadState) ??
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.preloadState, {})
		);
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.preloadClear, undefined);
	}

	public next(): Promise<void> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.preloadNext, undefined);
	}

	public cancel(): void {
		this.bus.requestRpcSync(this.playerId, PLAYER_RPC.preloadCancel, undefined);
	}
}

export class FilterCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getFilters(): any {
		return (
			this.bus.querySync(this.playerId, PLAYER_QUERY.filterList) ??
			this.bus.requestRpcSync(this.playerId, PLAYER_RPC.filterList, {})
		);
	}

	public set(filter: string, value: unknown): Promise<any> {
		return this.bus.requestRpc(this.playerId, PLAYER_RPC.filterSet, { filter, value });
	}

	public state(): any {
		return this.bus.querySync(this.playerId, PLAYER_QUERY.filters) ?? [];
	}
}
