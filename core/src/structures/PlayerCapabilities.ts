import type { BaseExtension } from "../extensions/BaseExtension";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";
import type { LoopMode } from "../types";
import type { PlayerBus } from "./PlayerBus";

/**
 * Bus-only capabilities exposed by Player.
 *
 * This deliberately contains no controller references. Every operation crosses
 * the PlayerBus boundary and therefore keeps controller ownership in the global
 * runtime.
 */
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

export class QueueCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public get tracks(): Track[] { return this.bus.querySync("queue"); }
	public get currentTrack(): Track | null { return this.bus.querySync("currentTrack"); }
	public get nextTrack(): Track | null { return this.bus.querySync("queueNextTrack"); }
	public get previousTrack(): Track | null { return this.bus.querySync("previousTrack"); }
	public get previousTracks(): Track[] { return this.bus.querySync("previousTracks"); }
	public get relatedTracks(): Track[] { return this.bus.querySync("relatedTracks"); }
	public get willNext(): Track | null { return this.bus.querySync("willNext"); }
	public get length(): number { return this.tracks.length; }
	public get size(): number { return this.tracks.length; }
	public get isEmpty(): boolean { return this.tracks.length === 0; }
	public get loopMode(): LoopMode { return this.bus.querySync("queueLoop"); }
	public get autoPlayEnabled(): boolean { return this.bus.querySync("queueAutoPlay"); }
	public add(track: Track): number { return this.bus.requestRpcSync("queue.add", { track }); }
	public addMultiple(tracks: Track[]): number { return this.bus.requestRpcSync("queue.addMultiple", { tracks }); }
	public insert(track: Track, index = this.length): number { return this.bus.requestRpcSync("queue.insertTrack", { track, index }); }
	public remove(index: number): Track | null { return this.bus.requestRpcSync("queue.remove", { index }); }
	public removeMultiple(indices: number[]): Track[] { return this.bus.requestRpcSync("queue.removeMultiple", { indices }); }
	public shuffle(): void { this.bus.requestRpcSync("queue.shuffle", undefined); }
	public clear(): void { this.bus.requestRpcSync("queue.clear", undefined); }
	public previous(): Track | null { return this.bus.requestRpcSync("queue.previous", undefined); }
	public loop(mode?: LoopMode): LoopMode { return mode === undefined ? this.loopMode : this.bus.requestRpcSync("queue.loop", { mode }); }
	public autoPlay(enabled?: boolean): boolean { return enabled === undefined ? this.autoPlayEnabled : this.bus.requestRpcSync("queue.autoPlay", { enabled }); }
	public setWillNext(track: Track | null): Track | null { return this.bus.requestRpcSync("queue.willNext", { track }); }
	public setCurrent(track: Track | null): void { this.bus.requestRpcSync("queue.setCurrent", { track }); }
	public serialize(): object { return this.bus.requestRpcSync("queue.serialize", undefined); }
	public restore(state: object): void { this.bus.requestRpcSync("queue.restore", { state }); }
}

export class PluginCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public get available(): string[] { return this.bus.querySync("availablePlugins").map((plugin) => plugin.name); }
	public add(plugin: BasePlugin): void { this.bus.requestRpcSync("plugin.add", { plugin }); }
	public remove(name: string): boolean { return this.bus.requestRpcSync("plugin.remove", { name }); }
}

export class ExtensionCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public get all(): any[] { return this.bus.querySync("extensions") ?? []; }
	public add(extension: BaseExtension): void { this.bus.requestRpcSync("extension.add", { extension }); }
	public remove(extension: BaseExtension): boolean { return this.bus.requestRpcSync("extension.remove", { extension }); }
}

export class StreamCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public stats(): any { return this.bus.requestRpcSync("stream.stats", undefined) ?? {}; }
}

export class PreloadCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public next(): Promise<void> { return this.bus.requestRpc("preload.next", undefined); }
	public cancel(): void { this.bus.requestRpcSync("preload.cancel", undefined); }
	public clear(): void { this.bus.requestRpcSync("preload.clear", undefined); }
}

export class FilterCapability {
	public constructor(private readonly bus: PlayerBus) {}
	public state(): any { return this.bus.querySync("filters") ?? []; }
	public apply(filter: any): Promise<any> { return this.bus.requestRpc("filter.apply", { filter }); }
	public remove(filter: any): Promise<any> { return this.bus.requestRpc("filter.remove", { filter }); }
	public clear(): Promise<any> { return this.bus.requestRpc("filter.clear", undefined); }
}
