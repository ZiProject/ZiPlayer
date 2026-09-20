import type { BaseExtension } from "../extensions/BaseExtension";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";
import type { LoopMode } from "../types";
import type { Bus } from "../structures/Bus";

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
		return this.bus.requestRpc(this.playerId, "queue.add", { track });
	}

	public remove(index: number): Promise<Track | null> | Track | null {
		return this.bus.requestRpc(this.playerId, "queue.remove", { index });
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc(this.playerId, "queue.clear", undefined as any);
	}

	public get tracks(): Track[] {
		return this.bus.querySync(this.playerId, "queue") ?? [];
	}

	public get currentTrack(): Track | null {
		return this.bus.querySync(this.playerId, "currentTrack");
	}

	public get nextTrack(): Track | null {
		return this.bus.querySync(this.playerId, "queueNextTrack");
	}

	public get previousTrack(): Track | null {
		return this.bus.querySync(this.playerId, "previousTrack");
	}

	public get previousTracks(): Track[] {
		return this.bus.querySync(this.playerId, "previousTracks") ?? [];
	}

	public get relatedTracks(): Track[] {
		return this.bus.querySync(this.playerId, "relatedTracks") ?? [];
	}

	public get willNext(): Track | null {
		return this.bus.querySync(this.playerId, "willNext");
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
		return this.bus.querySync(this.playerId, "queueLoop");
	}

	public get autoPlayEnabled(): boolean {
		return this.bus.querySync(this.playerId, "queueAutoPlay");
	}

	public addMultiple(tracks: Track[]): number {
		return this.bus.requestRpcSync(this.playerId, "queue.addMultiple", { tracks });
	}

	public insert(track: Track, index = this.length): boolean | number {
		return this.bus.requestRpcSync(this.playerId, "queue.insert", { query: track, index });
	}

	public removeMultiple(indices: number[]): Track[] {
		return [...indices]
			.sort((a, b) => b - a)
			.map((index) => this.bus.requestRpcSync(this.playerId, "queue.remove", { index }))
			.filter((track): track is Track => track !== null);
	}

	public shuffle(): void {
		this.bus.requestRpcSync(this.playerId, "queue.shuffle", undefined);
	}

	public previous(): Track | null {
		return this.bus.requestRpcSync(this.playerId, "queue.previous", undefined);
	}

	public loop(mode?: LoopMode): LoopMode {
		return mode === undefined ? this.loopMode : this.bus.requestRpcSync(this.playerId, "queue.loop", { mode });
	}

	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ? this.autoPlayEnabled : this.bus.requestRpcSync(this.playerId, "queue.autoPlay", { enabled });
	}

	public setWillNext(track: Track | null): Track | null {
		return this.bus.requestRpcSync(this.playerId, "queue.willNext", { track });
	}

	public setCurrent(track: Track | null): void {
		this.bus.requestRpcSync(this.playerId, "queue.setCurrent", { track });
	}

	public serialize(): object {
		return this.bus.requestRpcSync(this.playerId, "queue.serialize", undefined);
	}

	public restore(state: object): void {
		this.bus.requestRpcSync(this.playerId, "queue.restore", { state });
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
				this.bus.querySync(this.playerId, "plugin.get" as any) ?? this.bus.requestRpcSync(this.playerId, "plugin.get", { name })
			);
		} catch {
			return undefined;
		}
	}

	public list(): any[] {
		return this.bus.querySync(this.playerId, "plugin.list") ?? this.bus.querySync(this.playerId, "availablePlugins") ?? [];
	}

	public get available(): string[] {
		return (this.bus.querySync(this.playerId, "availablePlugins") ?? []).map((plugin) => plugin.name);
	}

	public add(plugin: BasePlugin): void {
		this.bus.requestRpcSync(this.playerId, "plugin.add", { plugin });
	}

	public register(plugin: BasePlugin): void {
		this.add(plugin);
	}

	public remove(name: string): boolean {
		return this.bus.requestRpcSync(this.playerId, "plugin.remove", { name });
	}

	public clear(): void {
		try {
			this.bus.requestRpcSync(this.playerId, "plugin.clear", undefined);
		} catch {}
	}

	public getStats(): object {
		try {
			return this.bus.requestRpcSync(this.playerId, "plugin.stats", undefined);
		} catch {
			return { totalPlugins: 0, pluginNames: [], streamCacheSize: 0, searchCacheSize: 0, pendingStreams: 0, pendingSearches: 0 };
		}
	}

	public getStream(track: Track): Promise<any> {
		return this.bus.requestRpc(this.playerId, "stream.resolve", { track });
	}
}

export class ExtensionCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public list(): any[] {
		return this.bus.querySync(this.playerId, "extension.list") ?? this.bus.querySync(this.playerId, "extensions") ?? [];
	}

	public get(name: string): any {
		return this.bus.requestRpcSync(this.playerId, "extension.get", { name });
	}

	public enable(name: string): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, "extension.enable", { name });
	}

	public disable(name: string): Promise<boolean> {
		return this.bus.requestRpc(this.playerId, "extension.disable", { name });
	}

	public get all(): any[] {
		return this.bus.querySync(this.playerId, "extensions") ?? [];
	}

	public add(extension: BaseExtension): void {
		this.bus.requestRpcSync(this.playerId, "extension.add", { extension });
	}

	public remove(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync(this.playerId, "extension.remove", { extension });
	}
}

export class StreamCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getState(): any {
		return this.bus.querySync(this.playerId, "stream.state") ?? this.bus.requestRpcSync(this.playerId, "stream.state", {});
	}

	public getCurrent(): any {
		return this.bus.querySync(this.playerId, "stream.current") ?? this.bus.requestRpcSync(this.playerId, "stream.current", {});
	}

	public stats(): any {
		return this.bus.requestRpcSync(this.playerId, "stream.stats", undefined) ?? {};
	}
}

export class PreloadCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getState(): any {
		return this.bus.querySync(this.playerId, "preload.state") ?? this.bus.requestRpcSync(this.playerId, "preload.state", {});
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc(this.playerId, "preload.clear", undefined);
	}

	public next(): Promise<void> {
		return this.bus.requestRpc(this.playerId, "preload.next", undefined);
	}

	public cancel(): void {
		this.bus.requestRpcSync(this.playerId, "preload.cancel", undefined);
	}
}

export class FilterCapability {
	public constructor(
		private readonly bus: Bus,
		private readonly playerId: string,
	) {}

	public getFilters(): any {
		return this.bus.querySync(this.playerId, "filter.list") ?? this.bus.requestRpcSync(this.playerId, "filter.list", {});
	}

	public set(filter: string, value: unknown): Promise<any> {
		return this.bus.requestRpc(this.playerId, "filter.set", { filter, value });
	}

	public state(): any {
		return this.bus.querySync(this.playerId, "filters") ?? [];
	}
}
