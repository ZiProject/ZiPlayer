import { LRUCache } from "lru-cache";
import type { SearchResult, SearchRequest, SearchDebugResult } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { PlayerBus } from "../structures/PlayerBus";

export interface SearchControllerOptions {
	extensionManager: ExtensionManager;
	pluginManager: PluginManager;
	debug: (...args: any[]) => void;
	bus?: PlayerBus;
}

/** Owns search orchestration and its cache so Player remains a facade. */
export class SearchController {
	private static readonly CACHE_TTL = 2 * 60 * 1000;
	public readonly cache: LRUCache<string, SearchResult>;
	private readonly detachRpcs: Array<() => void> = [];

	public constructor(private readonly options: SearchControllerOptions) {
		this.cache = new LRUCache<string, SearchResult>({
			max: 200,
			ttl: SearchController.CACHE_TTL,
			allowStale: false,
			updateAgeOnGet: true,
			dispose: (_value, key, reason) => options.debug(`[SearchCache] Disposed cache entry: ${key}, reason: ${reason}`),
		});

		if (options.bus) {
			this.detachRpcs.push(
				options.bus.registerRpc<SearchRequest, SearchResult>("search", (request, context) =>
					this.search(request.query, request.requestedBy, context.signal),
				),
				options.bus.registerRpc<{ query: string }, SearchResult | null>("search.cache.get", ({ query }) => this.getCached(query)),
				options.bus.registerRpc<{ query: string; result: SearchResult }, void>("search.cache.set", ({ query, result }) =>
					this.cacheResult(query, result),
				),
				options.bus.registerRpc<void, void>("search.cache.clear", () => this.clear()),
				options.bus.registerRpc<void, void>("search.cache.purge", () => this.purgeStale()),
				options.bus.registerRpc<{ query: string }, SearchDebugResult>("search.debug", ({ query }) => this.debug(query)),
			);
		}
	}

	public async search(query: string, requestedBy: string, signal?: AbortSignal): Promise<SearchResult> {
		this.throwIfAborted(signal);
		this.options.debug(`[SearchController] Search called with query: ${query}, requestedBy: ${requestedBy}`);
		const cached = this.cache.get(this.key(query));
		if (cached) {
			this.options.debug(`[SearchCache] Using cached search result for: ${query}`);
			return cached;
		}

		this.throwIfAborted(signal);
		const extensionResult = await this.options.extensionManager.provideSearch(query, requestedBy);
		this.throwIfAborted(signal);
		if (extensionResult?.tracks?.length) {
			this.options.debug(`[SearchController] Extension handled search for query: ${query}`);
			this.cacheResult(query, extensionResult);
			return extensionResult;
		}

		this.throwIfAborted(signal);
		const pluginResult = await this.options.pluginManager.search(query, requestedBy);
		this.throwIfAborted(signal);
		if (pluginResult?.tracks?.length) {
			this.options.debug(
				`[SearchController] Plugin search returned ${pluginResult.tracks.length} tracks (score: ${pluginResult.score?.score}%)`,
			);
			if (pluginResult.score) this.options.debug(`[SearchController] Search evaluation - ${pluginResult.score.reason}`);
			this.cacheResult(query, pluginResult);
			return pluginResult;
		}

		this.options.debug(`[SearchController] No search results for query: ${query}`);
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

	public debug(query: string): SearchDebugResult {
		const isCached = this.cache.has(this.key(query));
		const allPlugins = this.options.pluginManager.getAll();
		const plugins = allPlugins.filter(
			(plugin) => !(plugin.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")),
		);
		return { isCached, cacheAge: undefined, pluginCount: plugins.length, ttsFiltered: allPlugins.length > plugins.length };
	}

	public getCached(query: string): SearchResult | null {
		return this.cache.get(this.key(query)) ?? null;
	}

	public cacheResult(query: string, result: SearchResult): void {
		this.cache.set(this.key(query), result);
		this.options.debug(`[SearchCache] Cached search result for: ${query} (${result.tracks.length} tracks)`);
	}

	public dispose(): void {
		for (const detach of this.detachRpcs.splice(0)) detach();
		this.cache.clear();
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error("Search request was aborted");
	}

	private key(query: string): string {
		return query.toLowerCase().trim();
	}
}
