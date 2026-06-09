import type { Player } from "../structures/Player";
import type { PlayerManager } from "../structures/PlayerManager";
import type {
	ExtensionSearchRequest,
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

export { BaseExtension } from "./BaseExtension";

interface ExtensionCacheEntry<T> {
	data: T;
	timestamp: number;
	expiresAt: number;
}

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
	private extensionMetadata: Map<string, ExtensionMetadata>;
	private player: Player;
	private manager: PlayerManager;
	private extensionContext: ExtensionContext;

	// Caches for different operations
	private searchCache: Map<string, ExtensionCacheEntry<SearchResult>>;
	private streamCache: Map<string, ExtensionCacheEntry<StreamInfo>>;

	// Cache TTLs
	private readonly SEARCH_CACHE_TTL = 60 * 1000; // 1 minute
	private readonly STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly MAX_CACHE_SIZE = 100;

	// Pending requests for deduplication
	private pendingSearches: Map<string, Promise<SearchResult | null>>;
	private pendingStreams: Map<string, Promise<StreamInfo | null>>;
	private cacheCleanupInterval: NodeJS.Timeout | null = null;

	constructor(player: Player, manager: PlayerManager) {
		this.player = player;
		this.manager = manager;
		this.extensions = new Map();
		this.extensionMetadata = new Map();
		this.searchCache = new Map();
		this.streamCache = new Map();
		this.pendingSearches = new Map();
		this.pendingStreams = new Map();
		this.extensionContext = Object.freeze({
			player,
			manager,
			playNext: () => (player as any).playNext?.(),
			skip: () => (player as any).skip?.(),
			emit: (event: string, ...args: any[]) => player.emit(event as any, ...args),
		});
		// Auto-cleanup caches periodically
		this.cacheCleanupInterval = setInterval(() => this.cleanupCaches(), 5 * 60 * 1000);
		if (this.cacheCleanupInterval.unref) {
			this.cacheCleanupInterval.unref();
		}
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[ExtensionManager] ${message}`, ...optionalParams);
		}
	}

	register(extension: BaseExtension): void {
		if (this.extensions.has(extension.name)) {
			this.debug(`Extension ${extension.name} already registered, skipping`);
			return;
		}

		if (!extension.player) {
			extension.player = this.player;
		}

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

	unregister(extension: BaseExtension): boolean {
		const name = extension.name;
		const result = this.extensions.delete(name);
		if (result) {
			this.extensionMetadata.delete(name);
			this.invokeExtensionLifecycle(extension, "onDestroy");
			this.debug(`Unregistered extension: ${name}`);
		}
		return result;
	}

	destroy(): void {
		this.debug(`Destroying all extensions`);
		if (this.cacheCleanupInterval) {
			clearInterval(this.cacheCleanupInterval);
			this.cacheCleanupInterval = null;
		}
		for (const extension of this.extensions.values()) {
			this.unregister(extension);
		}
		this.extensions.clear();
		this.extensionMetadata.clear();
		this.clearAllCaches();
		this.pendingSearches.clear();
		this.pendingStreams.clear();
	}

	get(name: string): BaseExtension | undefined {
		return this.extensions.get(name);
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

	private cleanupCaches(): void {
		const now = Date.now();

		// Clean search cache
		for (const [key, entry] of this.searchCache) {
			if (now >= entry.expiresAt) {
				this.searchCache.delete(key);
			}
		}

		// Clean stream cache
		for (const [key, entry] of this.streamCache) {
			if (now >= entry.expiresAt) {
				this.streamCache.delete(key);
			}
		}

		this.debug(`Cache cleanup completed - Search: ${this.searchCache.size}, Stream: ${this.streamCache.size}`);
	}

	private clearAllCaches(): void {
		this.searchCache.clear();
		this.streamCache.clear();
		this.debug("All caches cleared");
	}

	private getCachedSearch(query: string): SearchResult | null {
		const key = this.getCacheKey("search", query.toLowerCase().trim());
		const cached = this.searchCache.get(key);
		if (cached && Date.now() < cached.expiresAt) {
			this.debug(`[Cache] Search hit for: ${query}`);
			return cached.data;
		}
		return null;
	}

	private setCachedSearch(query: string, result: SearchResult): void {
		if (this.searchCache.size >= this.MAX_CACHE_SIZE) {
			// Remove oldest entries (LRU approximation)
			const oldest = Array.from(this.searchCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
			if (oldest) this.searchCache.delete(oldest[0]);
		}

		const key = this.getCacheKey("search", query.toLowerCase().trim());
		this.searchCache.set(key, {
			data: result,
			timestamp: Date.now(),
			expiresAt: Date.now() + this.SEARCH_CACHE_TTL,
		});
		this.debug(`[Cache] Search stored for: ${query}`);
	}

	private getCachedStream(track: Track): StreamInfo | null {
		const key = this.getCacheKey("stream", track.url || track.id || track.title);
		const cached = this.streamCache.get(key);
		if (cached && Date.now() < cached.expiresAt) {
			this.debug(`[Cache] Stream hit for: ${track.title}`);
			return cached.data;
		}
		return null;
	}

	private setCachedStream(track: Track, stream: StreamInfo): void {
		if (this.streamCache.size >= this.MAX_CACHE_SIZE) {
			const oldest = Array.from(this.streamCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
			if (oldest) this.streamCache.delete(oldest[0]);
		}

		const key = this.getCacheKey("stream", track.url || track.id || track.title);
		this.streamCache.set(key, {
			data: stream,
			timestamp: Date.now(),
			expiresAt: Date.now() + this.STREAM_CACHE_TTL,
		});
		this.debug(`[Cache] Stream stored for: ${track.title}`);
	}

	async provideSearch(query: string, requestedBy: string): Promise<SearchResult | null> {
		if (!query) return null;

		// Check cache first
		const cached = this.getCachedSearch(query);
		if (cached) return cached;

		// Deduplicate concurrent requests
		const cacheKey = this.getCacheKey("search", query.toLowerCase().trim());
		if (this.pendingSearches.has(cacheKey)) {
			this.debug(`[Dedupe] Waiting for pending search: ${query}`);
			return this.pendingSearches.get(cacheKey)!;
		}

		const request: ExtensionSearchRequest = { query, requestedBy };
		const searchPromise = (async () => {
			// Only query extensions that have provideSearch capability
			const searchExtensions = this.findExtensionsByCapability("search");

			for (const extension of searchExtensions) {
				const hook = (extension as any).provideSearch;
				if (typeof hook !== "function") continue;

				try {
					const result = await Promise.resolve(hook.call(extension, this.extensionContext, request));
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
		const cacheKey = this.getCacheKey("stream", track.url || track.id || track.title);
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
						const hasStream = !!(result as StreamInfo).stream;
						const hasHandle = !!(result as StreamInfo).handle;

						this.debug(
							`Extension ${extension.name} returned stream for ${track.title}: remote=${isRemote}, hasStream=${hasStream}, hasHandle=${hasHandle}`,
						);

						if (hasStream || hasHandle) {
							// Only cache if it's a reusable stream (not remote with handle)
							if (!isRemote) {
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
