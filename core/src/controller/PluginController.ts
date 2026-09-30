import type { Bus } from "../structures/Bus";
import type { PluginManager } from "../plugins";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track, StreamInfo, SearchResult } from "../types";
import { normalizeStreamInfo } from "../types";
import { PLAYER_QUERY, PLAYER_RPC } from "../structures/BusContract";

/** Shared, singleton controller: owns plugin-related Bus RPC/query registration
 *  for every player, routed via `attach`/`detach`. */
export class PluginController {
	private readonly managers = new Map<string, PluginManager>();

	constructor(bus: Bus) {
		bus.registerQuery(PLAYER_QUERY.availablePlugins, (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerQuery(PLAYER_QUERY.pluginList, (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerRpc<Record<string, never> | undefined, BasePlugin[]>(
			PLAYER_RPC.pluginList,
			(_req, ctx) => this.manager(ctx.playerId)?.getAll() ?? [],
		);
		bus.registerRpc<{ name: string }, BasePlugin | undefined>(PLAYER_RPC.pluginGet, ({ name }, ctx) =>
			this.manager(ctx.playerId)?.get(name),
		);
		bus.registerRpc<{ plugin: BasePlugin }, void>(PLAYER_RPC.pluginAdd, ({ plugin }, ctx) =>
			this.manager(ctx.playerId)?.register(plugin),
		);
		bus.registerRpc<{ name: string }, boolean>(
			PLAYER_RPC.pluginRemove,
			({ name }, ctx) => this.manager(ctx.playerId)?.unregister(name) ?? false,
		);
		bus.registerRpc<void, void>(PLAYER_RPC.pluginClear, (_req, ctx) => this.manager(ctx.playerId)?.clear());
		bus.registerRpc<void, object>(PLAYER_RPC.pluginStats, (_req, ctx) => {
			const manager = this.manager(ctx.playerId);
			if (!manager) throw new Error("PluginController has no manager for this player");
			return manager.getStats();
		});
		bus.registerRpc<{ track: Track; history?: Track[] }, Track[]>(
			PLAYER_RPC.pluginRelatedTracks,
			async ({ track, history }, ctx) => {
				const result = await this.manager(ctx.playerId)?.getRelatedTracks(track, { history });
				return result ?? [];
			},
		);
		bus.registerRpc<{ plugin?: string | string[]; query: string; requestedBy?: string }, SearchResult | null>(
			PLAYER_RPC.pluginSearch,
			async ({ plugin, query, requestedBy }, ctx) => {
				const mgr = this.manager(ctx.playerId);
				if (!mgr) return null;
				return mgr.search(query, { plugins: plugin, requestedBy: requestedBy ?? "Unknown", signal: ctx.signal }, ctx.signal);
			},
		);
		bus.registerRpc<{ plugin?: string; track: Track }, StreamInfo | null>(
			PLAYER_RPC.pluginGetStream,
			async ({ plugin, track }, ctx) => {
				const mgr = this.manager(ctx.playerId);
				if (!mgr) return null;
				if (plugin) {
					const p = mgr.get(plugin);
					if (p && typeof p.getStream === "function") {
						const raw = await p.getStream(track, ctx.signal);
						return raw ? normalizeStreamInfo(track, raw) : null;
					}
				}
				const info = await mgr.getStream(track, { context: { signal: ctx.signal } });
				return info ? normalizeStreamInfo(track, info) : null;
			},
		);
	}

	attach(playerId: string, pluginManager: PluginManager): void {
		if (this.managers.has(playerId)) this.detach(playerId);
		this.managers.set(playerId, pluginManager);
	}
	detach(playerId: string): void {
		this.managers.delete(playerId);
	}
	private manager(playerId: string): PluginManager | undefined {
		return this.managers.get(playerId);
	}
}
