import type { PlayerBus } from "../structures/PlayerBus";
import type { PluginManager } from "../plugins";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { Track } from "../types";
import type { PluginControllerOptions } from "../types";

/** Owns plugin-related PlayerBus RPC/query registration. */
export class PluginController {
	private readonly detachRpcs: Array<() => void> = [];

	constructor(options: PluginControllerOptions) {
		const { pluginManager, bus } = options;
		this.detachRpcs.push(
			bus.registerQuery("availablePlugins", () => pluginManager.getAll()),
			bus.registerRpc<{ plugin: BasePlugin }, void>("plugin.add", ({ plugin }) => pluginManager.register(plugin)),
			bus.registerRpc<{ name: string }, boolean>("plugin.remove", ({ name }) => pluginManager.unregister(name)),
			bus.registerRpc<{ track: Track; history?: Track[] }, Track[]>("plugin.relatedTracks", async ({ track, history }) => {
				const result = await pluginManager.getRelatedTracks(track, { history });
				return result ?? [];
			}),
		);
	}

	dispose(): void {
		for (const detach of this.detachRpcs.splice(0)) detach();
	}
}
