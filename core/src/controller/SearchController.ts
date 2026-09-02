import { LRUCache } from "lru-cache";
import type { SearchResult } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";

export interface SearchControllerOptions {
	extensionManager: ExtensionManager;
	pluginManager: PluginManager;
	debug: (...args: any[]) => void;
}

/** Owns search orchestration and its cache so Player remains a facade. */
export class SearchController {
	private static readonly CACHE_TTL = 2 * 60 * 1000;
	public readonly cache: LRUCache<string, SearchResult>;

	public constructor(private readonly options: SearchControllerOptions) {
		this.cache = new LRUCache<string, SearchResult>({
			max: 200,
			ttl: SearchController.CACHE_TTL,
			allowStale: false,
			updateAgeOnGet: true,
			dispose: (_value, key, reason) => options.debug(`[SearchCache] Disposed cache entry: ${key}, reason: ${reason}`),
		});
	}

	public async search(query: string, requestedBy: string): Promise<SearchResult> {
		this.options.debug(`[Player] Search called with query: ${query}, requestedBy: ${requestedBy}`);
		const cached = this.cache.get(this.key(query));
		if (cached) {
			this.options.debug(`[SearchCache] Using cached search result for: ${query}`);
			return cached;
		}

		const extensionResult = await this.options.extensionManager.provideSearch(query, requestedBy);
		if (extensionResult?.tracks?.length) {
			this.options.debug(`[Player] Extension handled search for query: ${query}`);
			this.cacheResult(query, extensionResult);
			return extensionResult;
		}

		const pluginResult = await this.options.pluginManager.search(query, requestedBy);
		if (pluginResult?.tracks?.length) {
			this.options.debug(
				`[Player] Plugin search returned ${pluginResult.tracks.length} tracks (score: ${pluginResult.score?.score}%)`,
			);
			if (pluginResult.score) this.options.debug(`[Player] Search evaluation - ${pluginResult.score.reason}`);
			this.cacheResult(query, pluginResult);
			return pluginResult;
		}

		this.options.debug(`[Player] No search results for query: ${query}`);
		throw new Error(`No results found for: ${query}`);
	}

	public clear(): void {
		const size = this.cache.size;
		this.cache.clear();
		this.options.debug(`[SearchCache] Cleared all ${size} search cache entries`);
	}

	public purgeStale(): void {
		this.cache.purgeStale();
		this.options.debug(`[SearchCache] Purged stale search cache entries`);
	}

	public debug(query: string): {
		isCached: boolean;
		cacheAge?: number;
		pluginCount: number;
		ttsFiltered: boolean;
	} {
		const isCached = this.cache.has(this.key(query));
		const allPlugins = this.options.pluginManager.getAll();
		const plugins = allPlugins.filter(
			(plugin) => !(plugin.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")),
		);
		return { isCached, cacheAge: undefined, pluginCount: plugins.length, ttsFiltered: allPlugins.length > plugins.length };
	}

	private key(query: string): string {
		return query.toLowerCase().trim();
	}
	public cacheResult(query: string, result: SearchResult): void {
		this.cache.set(this.key(query), result);
		this.options.debug(`[SearchCache] Cached search result for: ${query} (${result.tracks.length} tracks)`);
	}
}
