import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type {
	ExtensionSearchRequest,
	ExtensionMethod,
	SearchResult,
	StreamInfo,
	Track,
	ExtensionContext,
	ExtensionPlayRequest,
	ExtensionPlayResponse,
	ExtensionAfterPlayPayload,
	ExtensionStreamRequest,
} from "../types";

import { BaseExtension } from "./BaseExtension";
import { withTimeout } from "../utils/timeout";
import { TtlCache } from "../utils/cache";
import { CACHE_CLEANUP_INTERVAL_MS, MAX_CACHE_ENTRIES, SEARCH_CACHE_TTL_MS, STREAM_CACHE_TTL_MS } from "../utils/constants";

export { BaseExtension } from "./BaseExtension";

const invokableExtensionMethods = new Set<ExtensionMethod>(["beforePlay", "afterPlay", "provideSearch", "provideStream"]);

interface ExtensionMetadata {
	name: string;
	priority: number;
	registeredAt: number;
	hasSearch: boolean;
	hasStream: boolean;
	hasBeforePlay: boolean;
	hasAfterPlay: boolean;
}

export class ExtensionManager {
	private extensions: Map<string, BaseExtension>;
	private disabledExtensions: Map<string, BaseExtension>;
	private extensionMetadata: Map<string, ExtensionMetadata>;
	private player: Player;
	private manager: PlayerManager;
	private extensionContext: ExtensionContext;

	// Caches for different operations
	private readonly searchCache = new TtlCache<SearchResult>(SEARCH_CACHE_TTL_MS, MAX_CACHE_ENTRIES);
	private readonly streamCache = new TtlCache<StreamInfo>(STREAM_CACHE_TTL_MS, MAX_CACHE_ENTRIES);

	// Pending requests for deduplication
	private pendingSearches: Map<string, Promise<SearchResult | null>>;
	private pendingStreams: Map<string, Promise<StreamInfo | null>>;
	private cacheCleanupInterval: NodeJS.Timeout | null = null;
	private destroyed = false;

	constructor(
		player: Player,
		manager: PlayerManager,
		private readonly debugChannel?: (message?: any, ...optionalParams: any[]) => void,
	) {
		this.player = player;
		this.manager = manager;
		this.extensions = new Map();
		this.disabledExtensions = new Map();
		this.extensionMetadata = new Map();
		this.pendingSearches = new Map();
		this.pendingStreams = new Map();
		this.extensionContext = this.createExtensionContext(player, manager);
		// Auto-cleanup caches periodically
		this.cacheCleanupInterval = setInterval(() => this.cleanupCaches(), CACHE_CLEANUP_INTERVAL_MS);
		if (this.cacheCleanupInterval.unref) {
			this.cacheCleanupInterval.unref();
		}
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.debugChannel) {
			this.debugChannel(message, ...optionalParams);
		} else if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[ExtensionManager] ${message}`, ...optionalParams);
		}
	}

	attachPlayer(player: Player): void {
		this.player = player;
		this.extensionContext = this.createExtensionContext(player, this.manager);
	}

	private createExtensionContext(
		player?: Player | null,
		manager?: PlayerManager | null,
		extra?: Partial<ExtensionContext>,
	): ExtensionContext {
		const p = player ?? this.player;
		const m = manager ?? this.manager;
		const bus = extra?.bus ?? (p as any)?.bus ?? (m as any)?.bus;
		const playerId = extra?.playerId ?? p?.playerId ?? "unknown";
		return Object.freeze({
			playerId,
			bus,
			signal: extra?.signal ?? new AbortController().signal,
			track: extra?.track,
			query: extra?.query,
			requestedBy: extra?.requestedBy,
			player: p ?? null,
			manager: m ?? null,
			playNext: () => (p as any)?.playNext?.(),
			skip: () => (p as any)?.skip?.(),
			emit: (event: string, ...args: any[]) => p?.emit(event as any, ...args),
		});
	}

	register(extension: BaseExtension): void {
		if (this.extensions.has(extension.name)) {
			this.debug(`Extension ${extension.name} already registered, skipping`);
			return;
		}
		this.disabledExtensions.delete(extension.name);

		extension.player = this.player;

		// Set default priority if not set
		extension.priority ??= 0;

		// Store metadata for optimization
		const metadata: ExtensionMetadata = {
			name: extension.name,
			priority: extension.priority,
			registeredAt: Date.now(),
			hasSearch: typeof (extension as any).provideSearch === "function",
			hasStream: typeof (extension as any).provideStream === "function",
			hasBeforePlay: typeof (extension as any).beforePlay === "function",
			hasAfterPlay: typeof (extension as any).afterPlay === "function",
		};

		this.extensions.set(extension.name, extension);
		this.extensionMetadata.set(extension.name, metadata);
		this.invokeExtensionLifecycle(extension, "onRegister");
		this.debug(`Registered extension: ${extension.name} (priority: ${extension.priority})`);
	}

	async attach(extension: BaseExtension): Promise<boolean> {
		const existing = this.extensions.get(extension.name);
		if (existing) return existing === extension;

		this.register(extension);
		if (this.extensions.get(extension.name) !== extension) return false;

		try {
			const activated = await withTimeout(
				Promise.resolve(extension.active({ manager: this.manager, player: this.player })),
				this.player.options.extractorTimeout ?? 15000,
				`Extension ${extension.name} activation timed out`,
			);
			if (this.extensions.get(extension.name) !== extension) return false;
			if (activated === false) {
				this.unregister(extension);
				return false;
			}
			return true;
		} catch (error) {
			this.debug(`Extension activation error for ${extension.name}:`, error);
			this.unregister(extension);
			return false;
		}
	}

	unregister(extension: BaseExtension): boolean {
		const name = extension.name;
		const result = this.extensions.delete(name);
		if (result) {
			this.extensionMetadata.delete(name);
			this.invokeExtensionLifecycle(extension, "onDestroy");
			extension.releaseBusSubscriptions?.(this.player);
			if (!this.player || extension.player === this.player) extension.player = null;
			this.debug(`Unregistered extension: ${name}`);
		}
		return result;
	}

	enable(name: string): boolean {
		const extension = this.disabledExtensions.get(name);
		if (!extension) return this.extensions.has(name);
		this.register(extension);
		return this.extensions.has(name);
	}

	disable(name: string): boolean {
		const extension = this.extensions.get(name);
		if (!extension) return this.disabledExtensions.has(name);
		const disabled = this.unregister(extension);
		if (disabled) this.disabledExtensions.set(name, extension);
		return disabled;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.debug(`Destroying all extensions`);
		if (this.cacheCleanupInterval) {
			clearInterval(this.cacheCleanupInterval);
			this.cacheCleanupInterval = null;
		}
		for (const extension of this.extensions.values()) {
			this.unregister(extension);
		}
		this.extensions.clear();
		this.disabledExtensions.clear();
		this.extensionMetadata.clear();
		this.clearAllCaches();
		this.pendingSearches.clear();
		this.pendingStreams.clear();
		this.player = null as unknown as Player;
		this.manager = null as unknown as PlayerManager;
		this.extensionContext = null as unknown as ExtensionContext;
	}

	get(name: string): BaseExtension | undefined {
		return this.extensions.get(name);
	}

	resolve(name: string): BaseExtension | undefined {
		return this.get(name);
	}

	async invoke(name: string, method: ExtensionMethod, context: ExtensionContext, payload?: unknown): Promise<unknown> {
		if (!invokableExtensionMethods.has(method)) return undefined;
		const ext = this.get(name);
		if (!ext) return undefined;
		const fn = (ext as any)[method];
		if (typeof fn !== "function") return undefined;
		return Promise.resolve(fn.call(ext, context, payload));
	}

	async beforePlay(
		name: string,
		context: ExtensionContext,
		request: ExtensionPlayRequest,
	): Promise<ExtensionPlayResponse | void> {
		const ext = this.get(name);
		if (!ext || typeof (ext as any).beforePlay !== "function") return;
		return Promise.resolve((ext as any).beforePlay.call(ext, context, request));
	}

	async afterPlay(name: string, context: ExtensionContext, payload: ExtensionAfterPlayPayload): Promise<void> {
		const ext = this.get(name);
		if (!ext || typeof (ext as any).afterPlay !== "function") return;
		return Promise.resolve((ext as any).afterPlay.call(ext, context, payload));
	}

	getAll(): BaseExtension[] {
		// Sort by priority (higher first)
		return Array.from(this.extensions.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	getMetadata(name: string): ExtensionMetadata | undefined {
		return this.extensionMetadata.get(name);
	}

	getAllMetadata(): ExtensionMetadata[] {
		return Array.from(this.extensionMetadata.values()).sort((a, b) => b.priority - a.priority);
	}

	findExtension(query: unknown): BaseExtension | undefined {
		return this.getAll().find((extension) => extension.active?.(query) ?? false);
	}

	findExtensionsByCapability(capability: "search" | "stream" | "beforePlay" | "afterPlay"): BaseExtension[] {
		const capabilityMap = {
			search: "hasSearch",
			stream: "hasStream",
			beforePlay: "hasBeforePlay",
			afterPlay: "hasAfterPlay",
		};

		const metaKey = capabilityMap[capability];
		return this.getAll().filter((ext) => {
			const meta = this.extensionMetadata.get(ext.name);
			return meta?.[metaKey as keyof ExtensionMetadata] ?? false;
		});
	}

	clear(): void {
		this.extensions.clear();
		this.disabledExtensions.clear();
		this.extensionMetadata.clear();
		this.clearAllCaches();
	}

	private invokeExtensionLifecycle(extension: BaseExtension | undefined, hook: "onRegister" | "onDestroy"): void {
		if (!extension) return;
		const fn = (extension as any)[hook];
		if (typeof fn !== "function") return;
		try {
			const result = fn.call(extension, this.extensionContext);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((err) => this.debug(`Extension ${extension.name} ${hook} error:`, err));
			}
		} catch (err) {
			this.debug(`Extension ${extension.name} ${hook} error:`, err);
		}
	}

	private getCacheKey(prefix: string, ...parts: string[]): string {
		return `${prefix}:${parts.join(":")}`;
	}

	private searchKey(query: string): string {
		return this.getCacheKey("search", query.toLowerCase().trim());
	}

	private streamKey(track: Track): string {
		return this.getCacheKey("stream", track.url || track.id || track.title);
	}

	private cleanupCaches(): void {
		this.searchCache.pruneExpired();
		this.streamCache.pruneExpired();
		this.debug(`Cache cleanup completed - Search: ${this.searchCache.size}, Stream: ${this.streamCache.size}`);
	}

	private clearAllCaches(): void {
		this.searchCache.clear();
		this.streamCache.clear();
		this.debug("All caches cleared");
	}

	private getCachedSearch(query: string): SearchResult | null {
		const cached = this.searchCache.get(this.searchKey(query));
		if (!cached) return null;
		this.debug(`[Cache] Search hit for: ${query}`);
		return cached;
	}

	private setCachedSearch(query: string, result: SearchResult): void {
		this.searchCache.set(this.searchKey(query), result);
		this.debug(`[Cache] Search stored for: ${query}`);
	}

	private getCachedStream(track: Track): StreamInfo | null {
		const cached = this.streamCache.get(this.streamKey(track));
		if (!cached) return null;
		this.debug(`[Cache] Stream hit for: ${track.title}`);
		return cached;
	}

	private setCachedStream(track: Track, stream: StreamInfo): void {
		this.streamCache.set(this.streamKey(track), stream);
		this.debug(`[Cache] Stream stored for: ${track.title}`);
	}

	async provideSearch(query: string, requestedBy: string, signal?: AbortSignal): Promise<SearchResult | null> {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (!query) return null;

		// Check cache first
		const cached = this.getCachedSearch(query);
		if (cached) return cached;

		// Deduplicate concurrent requests
		const cacheKey = this.searchKey(query);
		if (this.pendingSearches.has(cacheKey)) {
			this.debug(`[Dedupe] Waiting for pending search: ${query}`);
			return this.pendingSearches.get(cacheKey)!;
		}

		const request: ExtensionSearchRequest = { query, requestedBy, signal };
		const searchPromise = (async () => {
			// Only query extensions that have provideSearch capability
			const searchExtensions = this.findExtensionsByCapability("search");

			for (const extension of searchExtensions) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const hook = (extension as any).provideSearch;
				if (typeof hook !== "function") continue;

				try {
					const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
					if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
					if (result && Array.isArray(result.tracks) && result.tracks.length > 0) {
						this.debug(`Extension ${extension.name} handled search for: ${query}`);
						this.setCachedSearch(query, result as SearchResult);
						return result as SearchResult;
					}
				} catch (err) {
					this.debug(`Extension ${extension.name} provideSearch error:`, err);
				}
			}
			return null;
		})();

		this.pendingSearches.set(cacheKey, searchPromise);

		try {
			return await searchPromise;
		} finally {
			this.pendingSearches.delete(cacheKey);
		}
	}

	async provideStream(track: Track): Promise<StreamInfo | null> {
		if (!track) return null;

		// Check cache first
		const cached = this.getCachedStream(track);
		if (cached) {
			this.debug(`[Cache] Stream hit for: ${track.title}`);
			return cached;
		}

		// Deduplicate concurrent requests
		const cacheKey = this.streamKey(track);
		if (this.pendingStreams.has(cacheKey)) {
			this.debug(`[Dedupe] Waiting for pending stream: ${track.title}`);
			return this.pendingStreams.get(cacheKey)!;
		}

		const request: ExtensionStreamRequest = { track };
		const streamPromise = (async () => {
			// Only query extensions that have provideStream capability
			const streamExtensions = this.findExtensionsByCapability("stream");

			for (const extension of streamExtensions) {
				const hook = (extension as any).provideStream;
				if (typeof hook !== "function") continue;

				try {
					this.debug(`Trying extension ${extension.name} for stream: ${track.title}`);
					const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));

					if (result) {
						const isRemote = (result as StreamInfo).remote;
						const hasStream = Boolean(
							(result as StreamInfo).stream || (result as StreamInfo).url || (result as StreamInfo).recreate,
						);
						const hasHandle = !!(result as StreamInfo).handle;

						this.debug(
							`Extension ${extension.name} returned stream for ${track.title}: remote=${isRemote}, hasStream=${hasStream}, hasHandle=${hasHandle}`,
						);

						if (hasStream || hasHandle) {
							// Only cache reusable streams (not remote handles, not streams that opt out with cacheable: false)
							if (!isRemote && (result as StreamInfo).cacheable !== false) {
								this.setCachedStream(track, result as StreamInfo);
							}
							return result as StreamInfo;
						}
					}
				} catch (err) {
					this.debug(`Extension ${extension.name} provideStream error:`, err);
				}
			}
			this.debug(`No extension provided stream for: ${track.title}`);
			return null;
		})();

		this.pendingStreams.set(cacheKey, streamPromise);

		try {
			return await streamPromise;
		} finally {
			this.pendingStreams.delete(cacheKey);
		}
	}

	async beforePlayHooks(
		initial: ExtensionPlayRequest,
	): Promise<{ request: ExtensionPlayRequest; response: ExtensionPlayResponse }> {
		const request: ExtensionPlayRequest = { ...initial };
		const response: ExtensionPlayResponse = {};

		// Only query extensions that have beforePlay capability
		const beforePlayExtensions = this.findExtensionsByCapability("beforePlay");

		for (const extension of beforePlayExtensions) {
			const hook = (extension as any).beforePlay;
			if (typeof hook !== "function") continue;

			try {
				const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
				if (!result) continue;

				// Merge results
				if (result.query !== undefined) {
					request.query = result.query;
					response.query = result.query;
				}
				if (result.requestedBy !== undefined) {
					request.requestedBy = result.requestedBy;
					response.requestedBy = result.requestedBy;
				}
				if (Array.isArray(result.tracks)) {
					response.tracks = result.tracks;
				}
				if (typeof result.isPlaylist === "boolean") {
					response.isPlaylist = result.isPlaylist;
				}
				if (typeof result.success === "boolean") {
					response.success = result.success;
				}
				if (result.error instanceof Error) {
					response.error = result.error;
				}
				if (typeof result.handled === "boolean") {
					response.handled = result.handled;
					if (result.handled) break;
				}
			} catch (err) {
				this.debug(`Extension ${extension.name} beforePlay error:`, err);
			}
		}

		return { request, response };
	}

	async afterPlayHooks(payload: ExtensionAfterPlayPayload): Promise<void> {
		const afterPlayExtensions = this.findExtensionsByCapability("afterPlay");
		if (afterPlayExtensions.length === 0) return;

		// Create immutable payload
		const safeTracks = payload.tracks ? [...payload.tracks] : undefined;
		if (safeTracks) {
			Object.freeze(safeTracks);
		}
		const immutablePayload = Object.freeze({ ...payload, tracks: safeTracks });

		// Execute hooks in parallel for better performance
		const hooks = afterPlayExtensions.map(async (extension) => {
			const hook = (extension as any).afterPlay;
			if (typeof hook !== "function") return;

			try {
				await Promise.resolve(hook.call(extension, this.extensionContext, immutablePayload));
			} catch (err) {
				this.debug(`Extension ${extension.name} afterPlay error:`, err);
			}
		});

		await Promise.allSettled(hooks);
	}

	/**
	 * Get extension statistics
	 */
	getStats(): object {
		const metadata = this.getAllMetadata();
		return {
			totalExtensions: this.extensions.size,
			extensions: metadata.map((m) => ({
				name: m.name,
				priority: m.priority,
				capabilities: {
					search: m.hasSearch,
					stream: m.hasStream,
					beforePlay: m.hasBeforePlay,
					afterPlay: m.hasAfterPlay,
				},
			})),
			cacheStats: {
				searchCacheSize: this.searchCache.size,
				streamCacheSize: this.streamCache.size,
				pendingSearches: this.pendingSearches.size,
				pendingStreams: this.pendingStreams.size,
			},
		};
	}

	/**
	 * Clear specific cache
	 */
	clearCache(type?: "search" | "stream"): void {
		if (!type || type === "search") {
			this.searchCache.clear();
			this.debug("Search cache cleared");
		}
		if (!type || type === "stream") {
			this.streamCache.clear();
			this.debug("Stream cache cleared");
		}
	}
}
