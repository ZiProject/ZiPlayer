import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";
type DebugFn = (message?: any, ...optionalParams: any[]) => void;

type PluginManagerOptions = {
	extractorTimeout: number | undefined;
};

export { BasePlugin } from "./BasePlugin";

// Plugin factory
export class PluginManager {
	private debug: DebugFn;
	private options: PluginManagerOptions;
	private player: Player;
	private manager: PlayerManager;
	private plugins: Map<string, BasePlugin> = new Map();

	constructor(player: Player, manager: PlayerManager, options: PluginManagerOptions) {
		this.player = player;
		this.manager = manager;
		this.options = options;
		this.debug = (message?: any, ...optionalParams: any[]) => {
			if (manager.debugEnabled) {
				manager.emit("debug", `[ExtensionManager] ${message}`, ...optionalParams);
			}
		};
	}

	register(plugin: BasePlugin): void {
		this.plugins.set(plugin.name, plugin);
	}

	unregister(name: string): boolean {
		return this.plugins.delete(name);
	}

	get(name: string): BasePlugin | undefined {
		return this.plugins.get(name);
	}

	getAll(): BasePlugin[] {
		return Array.from(this.plugins.values());
	}

	findPlugin(query: string): BasePlugin | undefined {
		return this.getAll().find((plugin) => plugin.canHandle(query));
	}

	clear(): void {
		this.plugins.clear();
	}

	async getStream(track: Track): Promise<StreamInfo | null> {
		let streamInfo: StreamInfo | null = null;
		const plugin = this.get(track.source) || this.findPlugin(track.url);

		if (!plugin) {
			this.debug(`[Player] No plugin found for track: ${track.title}`);
			return null;
		}

		this.debug(`[Player] Getting stream for track: ${track.title}`);
		this.debug(`[Player] Using plugin: ${plugin.name}`);
		this.debug(`[Track] Track Info:`, track);
		const timeoutMs = this.options.extractorTimeout ?? 50000;
		try {
			streamInfo = await withTimeout(plugin.getStream(track), timeoutMs, "getStream timed out");
			if (!(streamInfo as any)?.stream) {
				throw new Error(`No stream returned from ${plugin.name}`);
			}
		} catch (streamError) {
			this.debug(`[Player] getStream failed, trying getFallback:`, streamError);
			const allplugs = this.getAll();
			for (const p of allplugs) {
				if (typeof (p as any).getFallback !== "function" && typeof (p as any).getStream !== "function") {
					continue;
				}
				try {
					streamInfo = await withTimeout((p as any).getStream(track), timeoutMs, `getStream timed out for plugin ${p.name}`);
					if ((streamInfo as any)?.stream) {
						this.debug(`[Player] getStream succeeded with plugin ${p.name} for track: ${track.title}`);
						break;
					}
					streamInfo = await withTimeout((p as any).getFallback(track), timeoutMs, `getFallback timed out for plugin ${p.name}`);
					if (!(streamInfo as any)?.stream) continue;
					break;
				} catch (fallbackError) {
					this.debug(`[Player] getFallback failed with plugin ${p.name}:`, fallbackError);
				}
			}
			if (!(streamInfo as any)?.stream) {
				throw new Error(`All getFallback attempts failed for track: ${track.title}`);
			}
		}

		return streamInfo as StreamInfo;
	}
}
