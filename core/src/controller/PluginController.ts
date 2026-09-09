import type { PlayerBus } from "../structures/PlayerBus";
import type { PluginManager } from "../plugins";
import type { BasePlugin } from "../plugins/BasePlugin";

export interface PluginControllerOptions {
	pluginManager: PluginManager;
	bus: PlayerBus;
}

/** Owns plugin-related PlayerBus RPC/query registration. */
export class PluginController {
	private readonly detachRpcs: Array<() => void> = [];

	constructor(options: PluginControllerOptions) {
		const { pluginManager, bus } = options;
		this.detachRpcs.push(
			bus.registerQuery("availablePlugins", () => pluginManager.getAll()),
			bus.registerRpc<{ plugin: BasePlugin }, void>("plugin.add", ({ plugin }) => pluginManager.register(plugin)),
			bus.registerRpc<{ name: string }, boolean>("plugin.remove", ({ name }) => pluginManager.unregister(name)),
		);
	}

	dispose(): void {
		for (const detach of this.detachRpcs.splice(0)) detach();
	}
}
