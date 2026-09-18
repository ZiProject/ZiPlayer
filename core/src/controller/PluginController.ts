import type { GlobalPlayerBus } from "../structures/PlayerBus";
import type { PluginManager } from "../plugins";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";

/** Shared, singleton controller: owns plugin-related PlayerBus RPC/query registration
 *  for every player, routed via `attach`/`detach`. */
export class PluginController {
	private readonly managers = new Map<string, PluginManager>();

	constructor(bus: GlobalPlayerBus) {
		bus.registerQuery("availablePlugins", (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerQuery("plugin.list", (playerId) => this.manager(playerId)?.getAll() ?? []);
		bus.registerRpc<Record<string, never> | undefined, BasePlugin[]>("plugin.list", (_req, ctx) => this.manager(ctx.playerId)?.getAll() ?? []);
		bus.registerRpc<{ name: string }, BasePlugin | undefined>("plugin.get", ({ name }, ctx) => this.manager(ctx.playerId)?.get(name));
		bus.registerRpc<{ plugin: BasePlugin }, void>("plugin.add", ({ plugin }, ctx) => this.manager(ctx.playerId)?.register(plugin));
		bus.registerRpc<{ name: string }, boolean>(
			"plugin.remove",
			({ name }, ctx) => this.manager(ctx.playerId)?.unregister(name) ?? false,
		);
		bus.registerRpc<void, void>("plugin.clear", (_req, ctx) => this.manager(ctx.playerId)?.clear());
		bus.registerRpc<void, object>("plugin.stats", (_req, ctx) => this.manager(ctx.playerId)?.getStats() ?? {});
		bus.registerRpc<{ track: Track; history?: Track[] }, Track[]>(
			"plugin.relatedTracks",
			async ({ track, history }, ctx) => {
				const result = await this.manager(ctx.playerId)?.getRelatedTracks(track, { history });
				return result ?? [];
			},
		);
	}

	attach(playerId: string, pluginManager: PluginManager): void {
		this.managers.set(playerId, pluginManager);
	}
	detach(playerId: string): void {
		this.managers.delete(playerId);
	}
	private manager(playerId: string): PluginManager | undefined {
		return this.managers.get(playerId);
	}
}
