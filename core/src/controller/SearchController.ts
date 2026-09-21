import { LRUCache } from "lru-cache";
import type { SearchResult, SearchRequest, SearchDebugResult } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { Bus } from "../structures/Bus";
import { PLAYER_RPC } from "../structures/BusContract";

interface SearchWorkerOptions {
	pluginManager: PluginManager;
	extensionManager: ExtensionManager;
	debug: (...args: any[]) => void;
}

/** Per-player search orchestration + cache, owned by the shared `SearchController` below. */
class SearchWorker {
	private static readonly CACHE_TTL = 2 * 60 * 1000;
	private readonly lifecycleAbort = new AbortController();
	private disposed = false;
	public readonly cache: LRUCache<string, SearchResult>;

	public constructor(private readonly options: SearchWorkerOptions) {
		this.cache = new LRUCache<string, SearchResult>({
			max: 200,
			ttl: SearchWorker.CACHE_TTL,
			allowStale: false,
			updateAgeOnGet: true,
			dispose: (_value, key, reason) => options.debug(`[SearchCache] Disposed cache entry: ${key}, reason: ${reason}`),
		});
	}

	public async search(query: string, requestedBy: string, signal?: AbortSignal): Promise<SearchResult> {
		if (this.disposed) throw new Error("SearchController is disposed");
		const operationSignal = signal ? AbortSignal.any([signal, this.lifecycleAbort.signal]) : this.lifecycleAbort.signal;
		this.throwIfAborted(operationSignal);
		this.options.debug(`[SearchController] Search called with query: ${query}, requestedBy: ${requestedBy}`);
		const cached = this.cache.get(this.key(query));
		if (cached) {
			this.options.debug(`[SearchCache] Using cached search result for: ${query}`);
			return cached;
		}

		this.throwIfAborted(operationSignal);
		const extensionResult = await this.options.extensionManager.provideSearch(query, requestedBy, operationSignal);
		this.throwIfAborted(operationSignal);
		if (extensionResult?.tracks?.length) {
			this.options.debug(`[SearchController] Extension handled search for query: ${query}`);
			this.cacheResult(query, extensionResult);
			return extensionResult;
		}

		this.throwIfAborted(operationSignal);
		const pluginResult = await this.options.pluginManager.search(query, requestedBy, operationSignal);
		this.throwIfAborted(operationSignal);
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
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.cache.clear();
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error("Search request was aborted");
	}

	private key(query: string): string {
		return query.toLowerCase().trim();
	}
}

/** Shared, singleton controller: owns search orchestration and its cache per player so
 *  Player remains a facade. */
export class SearchController {
	private readonly workers = new Map<string, SearchWorker>();

	public constructor(bus: Bus) {
		bus.registerRpc<SearchRequest, SearchResult>(PLAYER_RPC.search, (request, context) => {
			const worker = this.workers.get(context.playerId);
			if (!worker) throw new Error("SearchController is disposed");
			return worker.search(request.query, request.requestedBy, context.signal);
		});
		bus.registerRpc<{ query: string }, SearchResult | null>(
			PLAYER_RPC.searchCacheGet,
			({ query }, ctx) => this.workers.get(ctx.playerId)?.getCached(query) ?? null,
		);
		bus.registerRpc<{ query: string; result: SearchResult }, void>(PLAYER_RPC.searchCacheSet, ({ query, result }, ctx) =>
			this.workers.get(ctx.playerId)?.cacheResult(query, result),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.searchCacheClear, (_req, ctx) => this.workers.get(ctx.playerId)?.clear());
		bus.registerRpc<void, void>(PLAYER_RPC.searchCachePurge, (_req, ctx) => this.workers.get(ctx.playerId)?.purgeStale());
		bus.registerRpc<{ query: string }, SearchDebugResult>(
			PLAYER_RPC.searchDebug,
			({ query }, ctx) =>
				this.workers.get(ctx.playerId)?.debug(query) ?? {
					isCached: false,
					cacheAge: undefined,
					pluginCount: 0,
					ttsFiltered: false,
				},
		);
	}

	attach(playerId: string, options: SearchWorkerOptions): void {
		this.workers.set(playerId, new SearchWorker(options));
	}
	detach(playerId: string): void {
		this.workers.get(playerId)?.dispose();
		this.workers.delete(playerId);
	}
	public cache(playerId: string): LRUCache<string, SearchResult> | undefined {
		return this.workers.get(playerId)?.cache;
	}
}
