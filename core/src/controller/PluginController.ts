import type { Bus } from "../structures/Bus";
import { PluginManager } from "../plugins";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { PlayerManager } from "../structures/PlayerManager";
import type { StreamManager } from "../structures/StreamManager";
import type { SourcePlugin, SourcePluginLike, Track, StreamInfo, SearchResult } from "../types";
import type { PluginManagerOptions } from "../types";
import { normalizeStreamInfo } from "../types";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

/** Owns one shared PluginManager and routes its player-scoped runtime through attach/detach. */
export class PluginController {
	private readonly playerIds = new Set<string>();
	private readonly pluginManager: PluginManager;

	constructor(
		bus: Bus,
		private readonly owner?: PlayerManager,
		plugins: readonly SourcePluginLike[] = [],
		debug?: (message?: any, ...optionalParams: any[]) => void,
		options: Omit<PluginManagerOptions, "debug"> = {},
	) {
		this.pluginManager = new PluginManager(null, owner, { ...options, debug });
		for (const pluginOption of plugins) {
			try {
				let plugin: SourcePlugin | null = null;
				if (pluginOption && typeof pluginOption === "object") {
					plugin = pluginOption;
				} else if (typeof pluginOption === "function") {
					plugin = new pluginOption();
				}
				if (plugin) this.registerSharedPlugin(plugin);
				debug?.(`Registered plugin: ${pluginOption.name || "unnamed"}`);
			} catch (error) {
				debug?.("Failed to init plugin:", error);
			}
		}

		bus.registerQuery(PLAYER_QUERY.availablePlugins, (playerId) => this.manager(playerId)?.getAll(playerId) ?? []);
		bus.registerQuery(PLAYER_QUERY.pluginList, (playerId) => this.manager(playerId)?.getAll(playerId) ?? []);
		bus.registerRpc<Record<string, never> | undefined, BasePlugin[]>(
			PLAYER_RPC.pluginList,
			(_req, ctx) => this.manager(ctx.playerId)?.getAll(ctx.playerId) ?? [],
		);
		bus.registerRpc<{ name: string }, BasePlugin | undefined>(PLAYER_RPC.pluginGet, ({ name }, ctx) =>
			this.manager(ctx.playerId)?.get(name, ctx.playerId),
		);
		bus.registerRpc<{ plugin: BasePlugin }, void>(PLAYER_RPC.pluginAdd, ({ plugin }, ctx) =>
			this.registerPlugin(ctx.playerId, plugin),
		);
		bus.registerRpc<{ name: string }, boolean>(
			PLAYER_RPC.pluginRemove,
			({ name }, ctx) => this.manager(ctx.playerId)?.unregisterPlayerPlugin(ctx.playerId, name) ?? false,
		);
		bus.registerRpc<void, void>(PLAYER_RPC.pluginClear, (_req, ctx) =>
			this.manager(ctx.playerId)?.clearPlayerPlugins(ctx.playerId),
		);
		bus.registerRpc<void, object>(PLAYER_RPC.pluginStats, (_req, ctx) => {
			const manager = this.manager(ctx.playerId);
			if (!manager) throw new Error("PluginController has no manager for this player");
			return manager.getStats(ctx.playerId);
		});
		bus.registerRpc<{ track: Track; history?: Track[] }, Track[]>(
			PLAYER_RPC.pluginRelatedTracks,
			async ({ track, history }, ctx) => {
				const result = await this.manager(ctx.playerId)?.getRelatedTracks(track, { history, playerId: ctx.playerId });
				return result ?? [];
			},
		);
		bus.registerRpc<{ plugin?: string | string[]; query: string; requestedBy?: string }, SearchResult | null>(
			PLAYER_RPC.pluginSearch,
			async ({ plugin, query, requestedBy }, ctx) => {
				const mgr = this.manager(ctx.playerId);
				if (!mgr) return null;
				return mgr.search(
					query,
					{ plugins: plugin, requestedBy: requestedBy ?? "Unknown", signal: ctx.signal, playerId: ctx.playerId },
					ctx.signal,
				);
			},
		);
		bus.registerRpc<{ plugin?: string; track: Track }, StreamInfo | null>(
			PLAYER_RPC.pluginGetStream,
			async ({ plugin, track }, ctx) => {
				const mgr = this.manager(ctx.playerId);
				if (!mgr) return null;
				if (plugin) {
					const p = mgr.get(plugin, ctx.playerId);
					if (p && typeof p.getStream === "function") {
						const raw = await p.getStream(track, ctx.signal);
						return raw ? normalizeStreamInfo(track, raw) : null;
					}
				}
				const info = await mgr.getStream(track, { context: { signal: ctx.signal, playerId: ctx.playerId } });
				return info ? normalizeStreamInfo(track, info) : null;
			},
		);
	}

	attach(playerId: string, streamManager: StreamManager, options: { extractorTimeout?: number } = {}): PluginManager {
		if (this.playerIds.has(playerId)) this.detach(playerId);
		this.pluginManager.attachPlayer(playerId, streamManager, options.extractorTimeout);
		this.playerIds.add(playerId);
		return this.pluginManager;
	}
	registerPlugin(playerId: string, plugin: BasePlugin): void {
		const manager = this.manager(playerId);
		if (!manager) throw new Error(`PluginController has no manager for player "${playerId}"`);
		manager.registerPlayerPlugin(playerId, plugin);
	}
	registerSharedPlugin(plugin: BasePlugin): void {
		this.pluginManager.register(plugin);
	}
	unregisterSharedPlugin(name: string): boolean {
		return this.pluginManager.unregister(name);
	}
	getPlugins(): BasePlugin[] {
		return this.pluginManager.getAll();
	}
	getSharedManager(): PluginManager {
		return this.pluginManager;
	}
	detach(playerId: string): void {
		if (!this.playerIds.delete(playerId)) return;
		this.pluginManager.detachPlayer(playerId);
	}
	public getManager(playerId: string): PluginManager | undefined {
		return this.playerIds.has(playerId) ? this.pluginManager : undefined;
	}
	public has(playerId: string): boolean {
		return this.playerIds.has(playerId);
	}
	dispose(): void {
		this.playerIds.clear();
		this.pluginManager.destroy();
	}
	private manager(playerId: string): PluginManager | undefined {
		return this.getManager(playerId);
	}
}
