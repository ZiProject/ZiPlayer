import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";

type PluginManagerOptions = {
	extractorTimeout: number | undefined;
};

export { BasePlugin } from "./BasePlugin";

// Plugin factory
export class PluginManager {
	private options: PluginManagerOptions;
	private player: Player;
	private manager: PlayerManager;
	private plugins: Map<string, BasePlugin> = new Map();

	constructor(player: Player, manager: PlayerManager, options: PluginManagerOptions) {
		this.player = player;
		this.manager = manager;
		this.options = options;
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[Plugins] ${message}`, ...optionalParams);
		}
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
		const timeoutMs = this.options.extractorTimeout ?? 50000;
		const primary = this.get(track.source) || this.findPlugin(track.url);
		if (!primary) {
			this.debug(`No plugin found for track: ${track.title}`);
			return null;
		}
		try {
			const controller = new AbortController();
			const result = await withTimeout(primary.getStream(track, controller.signal), timeoutMs, "Primary timeout");
			if (result?.stream) return result;
			throw new Error("Primary failed");
		} catch {
			this.debug("Primary failed → fallback parallel");
		}

		// ===== FALLBACK PARALLEL =====
		const plugins = this.getAll()
			.filter((p) => p !== primary)
			.map((p) => {
				p.priority ??= 0;
				return p;
			})
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

		// group by priority
		const groups = new Map<number, BasePlugin[]>();
		for (const p of plugins) {
			if (!groups.has(p.priority ?? 0)) groups.set(p.priority ?? 0, []);
			groups.get(p.priority ?? 0)!.push(p);
		}
		for (const [priority, group] of groups) {
			this.debug(`Running group priority=${priority}`);
			const controller = new AbortController();
			try {
				const promises = group.map((p) => {
					const run = async () => {
						try {
							let result: StreamInfo | null = null;

							if (p.getStream) {
								try {
									result = await withTimeout(p.getStream(track, controller.signal), timeoutMs, `Timeout ${p.name}`);
								} catch (err) {
									// getStream thất bại → log rồi thử getFallback
									this.debug(`getStream failed for ${p.name}, trying getFallback`, err);
								}

								if (result?.stream) {
									this.debug(`Success via ${p.name}`);
									controller.abort();
									return result;
								}
							}

							if (p.getFallback) {
								result = await withTimeout(p.getFallback(track, controller.signal), timeoutMs, `Fallback timeout ${p.name}`);
								if (result?.stream) {
									this.debug(`Fallback via ${p.name}`);
									controller.abort();
									return result;
								}
							}

							throw new Error("No stream");
						} catch (err) {
							if (controller.signal.aborted) throw new Error("Aborted");
							this.debug(`Failed ${p.name}`, err);
							throw err;
						}
					};
					return run();
				});

				const result = await Promise.any(promises);
				if (result?.stream) return result;
			} catch {
				this.debug(`Priority group ${priority} failed`);
				controller.abort();
			}
		}

		throw new Error(`All plugins failed for track: ${track.title}`);
	}

	/**
	 * Get related tracks for a given track
	 * @param {Track} track Track to find related tracks for
	 * @returns {Track[]} Related tracks or empty array
	 * @example
	 * const related = await player.getRelatedTracks(track);
	 * console.log(`Found ${related.length} related tracks`);
	 */
	async getRelatedTracks(track: Track): Promise<Track[]> {
		if (!track) return [];

		const timeoutMs = this.options.extractorTimeout ?? 15000;
		const preferred = this.findPlugin(track.url) || this.get(track.source);

		// ===== THỬ PREFERRED TRƯỚC =====
		if (preferred && typeof preferred.getRelatedTracks === "function") {
			try {
				this.debug(`[RelatedTracks] Trying preferred: ${preferred.name}`);
				const related = await withTimeout(
					preferred.getRelatedTracks(track, {
						limit: 10,
						history: this.player.queue.previousTracks,
					}),
					timeoutMs,
					`getRelatedTracks timed out for ${preferred.name}`,
				);

				if (Array.isArray(related) && related.length > 0) {
					return related;
				}
				this.debug(`[RelatedTracks] ${preferred.name} returned no results → fallback race`);
			} catch (err) {
				this.debug(`[RelatedTracks] ${preferred.name} failed → fallback race`, err);
			}
		}

		// ===== FALLBACK: RACE THEO PRIORITY GROUP =====
		const plugins = this.getAll()
			.filter((p) => p !== preferred && typeof p.getRelatedTracks === "function")
			.map((p) => {
				p.priority ??= 0;
				return p;
			})
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

		// group by priority
		const groups = new Map<number, BasePlugin[]>();
		for (const p of plugins) {
			const key = p.priority ?? 0;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(p);
		}

		for (const [priority, group] of groups) {
			this.debug(`[RelatedTracks] Racing priority=${priority} (${group.map((p) => p.name).join(", ")})`);
			const controller = new AbortController();

			try {
				const promises = group.map((p) =>
					(async () => {
						try {
							const related = await withTimeout(
								p.getRelatedTracks!(track, {
									limit: 10,
									history: this.player.queue.previousTracks,
								}),
								timeoutMs,
								`getRelatedTracks timed out for ${p.name}`,
							);

							if (Array.isArray(related) && related.length > 0) {
								this.debug(`[RelatedTracks] Success via ${p.name}`);
								controller.abort();
								return related;
							}
							throw new Error(`${p.name} returned no results`);
						} catch (err) {
							if (controller.signal.aborted) throw new Error("Aborted");
							this.debug(`[RelatedTracks] ${p.name} failed`, err);
							throw err;
						}
					})(),
				);

				const result = await Promise.any(promises);
				if (result) return result;
			} catch {
				this.debug(`[RelatedTracks] Priority group ${priority} all failed`);
				controller.abort();
			}
		}

		this.debug(`[RelatedTracks] All plugins failed for: ${track.title}`);
		return [];
	}
}
