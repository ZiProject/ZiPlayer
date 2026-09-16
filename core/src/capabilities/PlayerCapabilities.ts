import type { BaseExtension } from "../extensions/BaseExtension";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";
import type { LoopMode } from "../types";
import type { PlayerBus } from "../structures/PlayerBus";

/** Bus-only capabilities exposed by Player; no controller references escape the runtime. */
export class PlayerCapabilities {
	public readonly queue: QueueCapability;
	public readonly plugins: PluginCapability;
	public readonly extensions: ExtensionCapability;
	public readonly stream: StreamCapability;
	public readonly preload: PreloadCapability;
	public readonly filter: FilterCapability;

	public constructor(private readonly bus: PlayerBus) {
		this.queue = new QueueCapability(bus);
		this.plugins = new PluginCapability(bus);
		this.extensions = new ExtensionCapability(bus);
		this.stream = new StreamCapability(bus);
		this.preload = new PreloadCapability(bus);
		this.filter = new FilterCapability(bus);
	}
}

export function createPlayerCapabilities(bus: PlayerBus): PlayerCapabilities {
	return new PlayerCapabilities(bus);
}

export class QueueCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public add(track: Track): Promise<number> | number {
		return this.bus.requestRpc("queue.add", { track });
	}

	public remove(index: number): Promise<Track | null> | Track | null {
		return this.bus.requestRpc("queue.remove", { index });
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc("queue.clear", undefined as any);
	}

	public get tracks(): Track[] {
		return this.bus.querySync("queue") ?? [];
	}

	public get currentTrack(): Track | null {
		return this.bus.querySync("currentTrack");
	}

	public get nextTrack(): Track | null {
		return this.bus.querySync("queueNextTrack");
	}

	public get previousTrack(): Track | null {
		return this.bus.querySync("previousTrack");
	}

	public get previousTracks(): Track[] {
		return this.bus.querySync("previousTracks") ?? [];
	}

	public get relatedTracks(): Track[] {
		return this.bus.querySync("relatedTracks") ?? [];
	}

	public get willNext(): Track | null {
		return this.bus.querySync("willNext");
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
		return this.bus.querySync("queueLoop");
	}

	public get autoPlayEnabled(): boolean {
		return this.bus.querySync("queueAutoPlay");
	}

	public addMultiple(tracks: Track[]): number {
		return this.bus.requestRpcSync("queue.addMultiple", { tracks });
	}

	public insert(track: Track, index = this.length): boolean | number {
		return this.bus.requestRpcSync("queue.insert", { query: track, index });
	}

	public removeMultiple(indices: number[]): Track[] {
		return [...indices]
			.sort((a, b) => b - a)
			.map((index) => this.bus.requestRpcSync("queue.remove", { index }))
			.filter((track): track is Track => track !== null);
	}

	public shuffle(): void {
		this.bus.requestRpcSync("queue.shuffle", undefined);
	}

	public previous(): Track | null {
		return this.bus.requestRpcSync("queue.previous", undefined);
	}

	public loop(mode?: LoopMode): LoopMode {
		return mode === undefined ? this.loopMode : this.bus.requestRpcSync("queue.loop", { mode });
	}

	public autoPlay(enabled?: boolean): boolean {
		return enabled === undefined ? this.autoPlayEnabled : this.bus.requestRpcSync("queue.autoPlay", { enabled });
	}

	public setWillNext(track: Track | null): Track | null {
		return this.bus.requestRpcSync("queue.willNext", { track });
	}

	public setCurrent(track: Track | null): void {
		this.bus.requestRpcSync("queue.setCurrent", { track });
	}

	public serialize(): object {
		return this.bus.requestRpcSync("queue.serialize", undefined);
	}

	public restore(state: object): void {
		this.bus.requestRpcSync("queue.restore", { state });
	}
}

export class PluginCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public get(name: string): any {
		try {
			return this.bus.querySync("plugin.get" as any) ?? this.bus.requestRpcSync("plugin.get", { name });
		} catch {
			return undefined;
		}
	}

	public list(): any[] {
		return this.bus.querySync("plugin.list") ?? this.bus.querySync("availablePlugins") ?? [];
	}

	public get available(): string[] {
		return (this.bus.querySync("availablePlugins") ?? []).map((plugin) => plugin.name);
	}

	public add(plugin: BasePlugin): void {
		this.bus.requestRpcSync("plugin.add", { plugin });
	}

	public register(plugin: BasePlugin): void {
		this.add(plugin);
	}

	public remove(name: string): boolean {
		return this.bus.requestRpcSync("plugin.remove", { name });
	}

	public clear(): void {
		try {
			this.bus.requestRpcSync("plugin.clear", undefined);
		} catch {}
	}

	public getStats(): object {
		try {
			return this.bus.requestRpcSync("plugin.stats", undefined);
		} catch {
			return { totalPlugins: 0, pluginNames: [], streamCacheSize: 0, searchCacheSize: 0, pendingStreams: 0, pendingSearches: 0 };
		}
	}

	public getStream(track: Track): Promise<any> {
		return this.bus.requestRpc("stream.resolve", { track });
	}
}

export class ExtensionCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public list(): any[] {
		return this.bus.querySync("extension.list") ?? this.bus.querySync("extensions") ?? [];
	}

	public get(name: string): any {
		return this.bus.requestRpcSync("extension.get", { name });
	}

	public enable(name: string): Promise<boolean> {
		return this.bus.requestRpc("extension.enable", { name });
	}

	public disable(name: string): Promise<boolean> {
		return this.bus.requestRpc("extension.disable", { name });
	}

	public get all(): any[] {
		return this.bus.querySync("extensions") ?? [];
	}

	public add(extension: BaseExtension): void {
		this.bus.requestRpcSync("extension.add", { extension });
	}

	public remove(extension: BaseExtension): boolean {
		return this.bus.requestRpcSync("extension.remove", { extension });
	}
}

export class StreamCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public getState(): any {
		return this.bus.querySync("stream.state") ?? this.bus.requestRpcSync("stream.state", {});
	}

	public getCurrent(): any {
		return this.bus.querySync("stream.current") ?? this.bus.requestRpcSync("stream.current", {});
	}

	public stats(): any {
		return this.bus.requestRpcSync("stream.stats", undefined) ?? {};
	}
}

export class PreloadCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public getState(): any {
		return this.bus.querySync("preload.state") ?? this.bus.requestRpcSync("preload.state", {});
	}

	public clear(): Promise<void> | void {
		return this.bus.requestRpc("preload.clear", undefined);
	}

	public next(): Promise<void> {
		return this.bus.requestRpc("preload.next", undefined);
	}

	public cancel(): void {
		this.bus.requestRpcSync("preload.cancel", undefined);
	}
}

export class FilterCapability {
	public constructor(private readonly bus: PlayerBus) {}

	public getFilters(): any {
		return this.bus.querySync("filter.list") ?? this.bus.requestRpcSync("filter.list", {});
	}

	public set(filter: string, value: unknown): Promise<any> {
		return this.bus.requestRpc("filter.set", { filter, value });
	}

	public state(): any {
		return this.bus.querySync("filters") ?? [];
	}
}
