import { LRUCache } from "lru-cache";
import type { SearchResult, SearchRequest, SearchDebugResult } from "../types";
import type { PluginManager } from "../plugins";
import type { ExtensionManager } from "../extensions";
import type { Bus } from "../structures/Bus";
import { PLAYER_RPC } from "../structures/BusContract";

interface SearchControllerOptions {
	pluginManager: PluginManager;
	extensionManager?: ExtensionManager;
	debug: (...args: any[]) => void;
	cacheEnabled?: boolean;
}

interface SearchState {
	options: SearchControllerOptions;
	lifecycleAbort: AbortController;
	disposed: boolean;
	cache: LRUCache<string, SearchResult>;
}

/** Shared search orchestration; player-specific options and cache are keyed by playerId. */
export class SearchController {
	private static readonly CACHE_TTL = 2 * 60 * 1000;
	private readonly states = new Map<string, SearchState>();

	public constructor(private readonly bus: Bus) {
		bus.registerRpc<SearchRequest, SearchResult>(PLAYER_RPC.search, (request, context) =>
			this.search(context.playerId, request.query, request.requestedBy ?? "Unknown", context.signal, request.plugin),
		);
		bus.registerRpc<{ query: string }, SearchResult | null>(PLAYER_RPC.searchCacheGet, ({ query }, ctx) =>
			this.getCached(ctx.playerId, query),
		);
		bus.registerRpc<{ query: string; result: SearchResult }, void>(PLAYER_RPC.searchCacheSet, ({ query, result }, ctx) =>
			this.cacheResult(ctx.playerId, query, result),
		);
		bus.registerRpc<void, void>(PLAYER_RPC.searchCacheClear, (_req, ctx) => this.clear(ctx.playerId));
		bus.registerRpc<void, void>(PLAYER_RPC.searchCachePurge, (_req, ctx) => this.purgeStale(ctx.playerId));
		bus.registerRpc<{ query: string }, SearchDebugResult>(PLAYER_RPC.searchDebug, ({ query }, ctx) =>
			this.debug(ctx.playerId, query),
		);
	}

	attach(playerId: string, options: SearchControllerOptions): void {
		this.detach(playerId);
		const state: SearchState = {
			options,
			lifecycleAbort: new AbortController(),
			disposed: false,
			cache: new LRUCache<string, SearchResult>({
				max: 200,
				ttl: SearchController.CACHE_TTL,
				allowStale: false,
				updateAgeOnGet: true,
				dispose: (_value, key, reason) => options.debug(`[SearchCache] Disposed cache entry: ${key}, reason: ${reason}`),
			}),
		};
		this.states.set(playerId, state);
	}

	detach(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		this.states.delete(playerId);
		state.disposed = true;
		state.lifecycleAbort.abort();
		state.cache.clear();
	}

	public cache(playerId: string): LRUCache<string, SearchResult> | undefined {
		return this.states.get(playerId)?.cache;
	}

	private async search(
		playerId: string,
		query: string,
		requestedBy: string,
		signal?: AbortSignal,
		plugin?: string | string[],
	): Promise<SearchResult> {
		const state = this.states.get(playerId);
		if (!state || state.disposed) throw new Error("SearchController is disposed");
		const { options } = state;
		const operationSignal = signal ? AbortSignal.any([signal, state.lifecycleAbort.signal]) : state.lifecycleAbort.signal;
		this.throwIfAborted(operationSignal);
		options.debug(`[SearchController] Search called with query: ${query}, requestedBy: ${requestedBy}, plugin: ${plugin}`);
		const cacheKey =
			plugin !== undefined ?
				`${this.key(query)}:${Array.isArray(plugin) ? plugin.slice().sort().join(",") : plugin}`
			:	this.key(query);
		const cached = options.cacheEnabled === false ? undefined : state.cache.get(cacheKey);
		if (cached) {
			options.debug(`[SearchCache] Using cached search result for: ${query}`);
			return cached;
		}

		this.throwIfAborted(operationSignal);
		if (plugin === undefined) {
			const extensionResult = await options.extensionManager?.provideSearch(query, requestedBy, operationSignal);
			this.throwIfAborted(operationSignal);
			if (extensionResult?.tracks?.length) {
				options.debug(`[SearchController] Extension handled search for query: ${query}`);
				this.storeResult(state, cacheKey, extensionResult);
				return extensionResult;
			}
		}

		this.throwIfAborted(operationSignal);
		const pluginResult = await options.pluginManager.search(
			query,
			{ requestedBy, plugins: plugin, signal: operationSignal },
			operationSignal,
		);
		this.throwIfAborted(operationSignal);
		if (pluginResult?.tracks?.length) {
			options.debug(
				`[SearchController] Plugin search returned ${pluginResult.tracks.length} tracks (score: ${pluginResult.score?.score}%)`,
			);
			if (pluginResult.score) options.debug(`[SearchController] Search evaluation - ${pluginResult.score.reason}`);
			this.storeResult(state, cacheKey, pluginResult);
			return pluginResult;
		}

		options.debug(`[SearchController] No search results for query: ${query}`);
		throw new Error(`No results found for: ${query}`);
	}

	private clear(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		const size = state.cache.size;
		state.cache.clear();
		state.options.debug(`[SearchCache] Cleared all ${size} search cache entries`);
	}

	private purgeStale(playerId: string): void {
		const state = this.states.get(playerId);
		if (!state) return;
		state.cache.purgeStale();
		state.options.debug(`[SearchCache] Purged stale search cache entries`);
	}

	private debug(playerId: string, query: string): SearchDebugResult {
		const state = this.states.get(playerId);
		if (!state || state.disposed) {
			return { isCached: false, cacheAge: undefined, pluginCount: 0, ttsFiltered: false };
		}
		const isCached = state.options.cacheEnabled !== false && state.cache.has(this.key(query));
		const allPlugins = state.options.pluginManager.getAll();
		const plugins = allPlugins.filter(
			(plugin) => !(plugin.name.toLowerCase() === "tts" && !query.toLowerCase().startsWith("tts:")),
		);
		return { isCached, cacheAge: undefined, pluginCount: plugins.length, ttsFiltered: allPlugins.length > plugins.length };
	}

	private getCached(playerId: string, query: string): SearchResult | null {
		const state = this.states.get(playerId);
		return !state || state.options.cacheEnabled === false ? null : (state.cache.get(this.key(query)) ?? null);
	}

	private cacheResult(playerId: string, query: string, result: SearchResult): void {
		const state = this.states.get(playerId);
		if (state) this.storeResult(state, query, result);
	}

	private storeResult(state: SearchState, query: string, result: SearchResult): void {
		if (state.disposed || state.options.cacheEnabled === false) return;
		state.cache.set(this.key(query), result);
		state.options.debug(`[SearchCache] Cached search result for: ${query} (${result.tracks.length} tracks)`);
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error("Search request was aborted");
	}

	private key(query: string): string {
		return query.toLowerCase().trim();
	}
}
