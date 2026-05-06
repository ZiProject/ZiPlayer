import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";

type PluginManagerOptions = {
	extractorTimeout: number | undefined;
	maxFallbackAttempts?: number;
	enableCache?: boolean;
};

export { BasePlugin } from "./BasePlugin";

function levenshtein(a: string, b: string): number {
	const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

	for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
	for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}

	return matrix[a.length][b.length];
}

function similarity(a: string, b: string): number {
	if (!a || !b) return 0;
	const dist = levenshtein(a, b);
	const maxLen = Math.max(a.length, b.length);
	return 1 - dist / maxLen;
}

function normalize(str: string): string {
	return str
		.toLowerCase()
		.replace(/\(.*?\)|\[.*?\]/g, "")
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const MUSIC_KEYWORDS = ["official", "mv", "audio", "lyrics", "remix", "cover", "ft", "feat", "prod", "music video"];
const NON_MUSIC_KEYWORDS = ["reaction", "review", "podcast", "interview", "vlog", "live stream", "news", "tiktok"];

function detectContentType(title: string): number {
	const t = title.toLowerCase();
	let score = 0;
	for (const k of MUSIC_KEYWORDS) if (t.includes(k)) score += 2;
	for (const k of NON_MUSIC_KEYWORDS) if (t.includes(k)) score -= 3;
	return score;
}

function tokenOverlap(a: string, b: string): number {
	const setA = new Set(a.split(" "));
	const setB = new Set(b.split(" "));
	let match = 0;
	for (const word of setA) if (setB.has(word)) match++;
	return match / Math.max(setA.size, setB.size);
}

function scoreTrack(base: Track, candidate: Track): number {
	const titleA = normalize(base.title);
	const titleB = normalize(candidate.title);
	let score = 0;
	score += similarity(titleA, titleB) * 50;
	score += tokenOverlap(titleA, titleB) * 30;
	score += detectContentType(candidate.title);
	return score;
}

// Cache entry for stream results
interface StreamCacheEntry {
	streamInfo: StreamInfo;
	timestamp: number;
	expiresAt: number;
}

export class PluginManager {
	private options: PluginManagerOptions;
	private player: Player;
	private manager: PlayerManager;
	private plugins: Map<string, BasePlugin> = new Map();
	private streamCache: Map<string, StreamCacheEntry> = new Map();
	private readonly STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private pendingStreams: Map<string, Promise<StreamInfo | null>> = new Map(); // Dedupe in-flight requests

	constructor(player: Player, manager: PlayerManager, options: PluginManagerOptions) {
		this.player = player;
		this.manager = manager;
		this.options = {
			maxFallbackAttempts: 3,
			enableCache: true,
			...options,
		};
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[Plugins] ${message}`, ...optionalParams);
		}
	}

	register(plugin: BasePlugin): void {
		if (this.plugins.has(plugin.name)) {
			this.debug(`Overwriting existing plugin: ${plugin.name}`);
		}
		plugin.priority ??= 0;
		this.plugins.set(plugin.name, plugin);
		this.debug(`Registered plugin: ${plugin.name} (priority: ${plugin.priority})`);
	}

	unregister(name: string): boolean {
		const removed = this.plugins.delete(name);
		if (removed) this.debug(`Unregistered plugin: ${name}`);
		return removed;
	}

	get(name: string): BasePlugin | undefined {
		return this.plugins.get(name);
	}

	getAll(): BasePlugin[] {
		return Array.from(this.plugins.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	findPlugin(query: string): BasePlugin | undefined {
		// First try exact match by source
		for (const plugin of this.getAll()) {
			if (plugin.name && query.toLowerCase().includes(plugin.name.toLowerCase())) {
				return plugin;
			}
		}

		// Then try canHandle
		return this.getAll().find((plugin) => plugin.canHandle?.(query) ?? false);
	}

	clear(): void {
		this.plugins.clear();
		this.streamCache.clear();
		this.pendingStreams.clear();
	}

	private getStreamCacheKey(track: Track): string {
		return `${track.source}:${track.url}:${track.id || track.title}`;
	}

	private getCachedStream(track: Track): StreamInfo | null {
		if (!this.options.enableCache) return null;

		const key = this.getStreamCacheKey(track);
		const cached = this.streamCache.get(key);

		if (cached && Date.now() < cached.expiresAt) {
			this.debug(`[Cache] Hit for track: ${track.title}`);
			return cached.streamInfo;
		}

		if (cached) {
			this.debug(`[Cache] Expired for track: ${track.title}`);
			this.streamCache.delete(key);
		}

		return null;
	}

	private setCachedStream(track: Track, streamInfo: StreamInfo): void {
		if (!this.options.enableCache) return;

		const key = this.getStreamCacheKey(track);
		this.streamCache.set(key, {
			streamInfo,
			timestamp: Date.now(),
			expiresAt: Date.now() + this.STREAM_CACHE_TTL,
		});
		this.debug(`[Cache] Stored for track: ${track.title}`);
	}

	private async getStreamWithDedupe(track: Track, primary: BasePlugin): Promise<StreamInfo | null> {
		const key = this.getStreamCacheKey(track);

		// Check if there's already an in-flight request
		if (this.pendingStreams.has(key)) {
			this.debug(`[Dedupe] Waiting for existing request: ${track.title}`);
			return this.pendingStreams.get(key)!;
		}

		// Create new request
		const promise = this.getStreamInternal(track, primary);
		this.pendingStreams.set(key, promise);

		try {
			const result = await promise;
			return result;
		} finally {
			this.pendingStreams.delete(key);
		}
	}

	private async getStreamInternal(track: Track, primary: BasePlugin): Promise<StreamInfo | null> {
		const timeoutMs = this.options.extractorTimeout ?? 50000;

		// Check cache first
		const cached = this.getCachedStream(track);
		if (cached) return cached;

		// Try primary plugin first
		try {
			this.debug(`[Primary] Trying ${primary.name} for track: ${track.title}`);
			const controller = new AbortController();
			const result = await withTimeout(
				primary.getStream(track, controller.signal),
				timeoutMs,
				`Primary timeout: ${primary.name}`,
			);

			if (result?.stream) {
				this.debug(`[Primary] Success via ${primary.name}`);
				this.setCachedStream(track, result);
				return result;
			}
			throw new Error("Primary plugin returned no stream");
		} catch (error) {
			this.debug(`[Primary] Failed: ${primary.name}`, error);
		}

		// Fallback to other plugins
		const fallbackPlugins = this.getAll()
			.filter((p) => p !== primary && p.name !== primary.name)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		if (fallbackPlugins.length === 0) {
			this.debug(`[Fallback] No fallback plugins available`);
			return null;
		}

		this.debug(`[Fallback] Trying ${fallbackPlugins.length} plugins sequentially`);

		// Try plugins sequentially to avoid overwhelming sources
		let attempt = 0;
		for (const plugin of fallbackPlugins) {
			attempt++;
			if (attempt > (this.options.maxFallbackAttempts ?? 3)) {
				this.debug(`[Fallback] Max attempts (${this.options.maxFallbackAttempts}) reached`);
				break;
			}

			try {
				this.debug(`[Fallback] Attempt ${attempt}/${fallbackPlugins.length}: ${plugin.name}`);
				const controller = new AbortController();

				let result: StreamInfo | null = null;

				// Try getStream first
				if (plugin.getStream) {
					result = await withTimeout(plugin.getStream(track, controller.signal), timeoutMs, `Timeout: ${plugin.name}`);
				}

				// Try fallback method if getStream failed
				if (!result?.stream && plugin.getFallback) {
					this.debug(`[Fallback] Trying fallback method for ${plugin.name}`);
					result = await withTimeout(plugin.getFallback(track, controller.signal), timeoutMs, `Fallback timeout: ${plugin.name}`);
				}

				if (result?.stream) {
					this.debug(`[Fallback] Success via ${plugin.name}`);
					this.setCachedStream(track, result);
					return result;
				}
			} catch (error) {
				this.debug(`[Fallback] Failed: ${plugin.name}`, error);
			}
		}

		this.debug(`[Fallback] All plugins failed for track: ${track.title}`);
		return null;
	}

	async getStream(track: Track): Promise<StreamInfo | null> {
		if (!track) {
			this.debug(`[getStream] No track provided`);
			return null;
		}

		// Find the most appropriate plugin
		let primary = this.get(track.source);
		if (!primary) {
			primary = this.findPlugin(track.url);
		}
		if (!primary) {
			this.debug(`[getStream] No plugin found for track: ${track.title} (source: ${track.source})`);
			return null;
		}

		return this.getStreamWithDedupe(track, primary);
	}

	/**
	 * Get related tracks for a given track
	 * @param {Track} track Track to find related tracks for
	 * @returns {Promise<Track[]>} Related tracks or empty array
	 */
	async getRelatedTracks(track: Track): Promise<Track[]> {
		if (!track) return [];

		const timeoutMs = this.options.extractorTimeout ?? 15000;
		const limit = 20;
		const minSimilarityScore = 10; // Minimum score to consider

		const relatedPlugins = this.getAll()
			.filter((p) => typeof p.getRelatedTracks === "function")
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		if (relatedPlugins.length === 0) {
			this.debug(`[RelatedTracks] No plugins support related tracks`);
			return [];
		}

		const history = this.player.queue.previousTracks;
		const historyUrls = new Set(history.map((t) => t.url));
		const currentTrackUrl = track.url;

		const results: Track[] = [];

		// Try plugins in parallel but with limit
		const batchSize = 3;
		for (let i = 0; i < relatedPlugins.length; i += batchSize) {
			const batch = relatedPlugins.slice(i, i + batchSize);
			const batchResults = await Promise.allSettled(
				batch.map(async (plugin) => {
					try {
						this.debug(`[RelatedTracks] Querying ${plugin.name}`);
						const related = await withTimeout(
							plugin.getRelatedTracks!(track, { limit, history }),
							timeoutMs,
							`Timeout ${plugin.name}`,
						);
						return Array.isArray(related) ? related : [];
					} catch (err) {
						this.debug(`[RelatedTracks] ${plugin.name} failed`, err);
						return [];
					}
				}),
			);

			for (const result of batchResults) {
				if (result.status === "fulfilled") {
					results.push(...result.value);
				}
			}
		}

		if (results.length === 0) {
			this.debug(`[RelatedTracks] No results from any plugin`);
			return [];
		}

		// Deduplicate by URL
		const unique = new Map<string, Track>();
		for (const t of results) {
			if (!unique.has(t.url) && t.url !== currentTrackUrl && !historyUrls.has(t.url)) {
				unique.set(t.url, t);
			}
		}

		// Score and sort
		const ranked = Array.from(unique.values())
			.map((t) => ({ track: t, score: scoreTrack(track, t) }))
			.filter((item) => item.score >= minSimilarityScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((x) => x.track);

		this.debug(`[RelatedTracks] Found ${ranked.length} related tracks (filtered from ${results.length})`);
		return ranked;
	}

	/**
	 * Clear stream cache
	 */
	clearStreamCache(): void {
		const size = this.streamCache.size;
		this.streamCache.clear();
		this.debug(`[Cache] Cleared ${size} stream cache entries`);
	}

	/**
	 * Get plugin statistics
	 */
	getStats(): object {
		return {
			totalPlugins: this.plugins.size,
			pluginNames: Array.from(this.plugins.keys()),
			cacheSize: this.streamCache.size,
			pendingRequests: this.pendingStreams.size,
		};
	}
}
