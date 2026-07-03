import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo, SearchResult, SearchScore } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";
import { StreamManager } from "../structures/StreamManager";

type PluginManagerOptions = {
	extractorTimeout: number | undefined;
	maxFallbackAttempts?: number;
	enableCache?: boolean;
	searchCacheTTL?: number;
	searchMinScore?: number;
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

const OFFICIAL_KEYWORDS = [
	"official video",
	"official audio",
	"official music video",
	"music video",
	"mv",
	"visualizer",
	"lyric video",
	"full song",
	"full track",
];

const MUSIC_KEYWORDS = [
	"official",
	"audio",
	"lyrics",
	"song",
	"track",
	"remix",
	"cover",
	"instrumental",
	"karaoke",
	"nightcore",
	"sped up",
	"slowed",
	"feat",
	"ft",
	"prod",
	"extended",
	"original mix",
];

const BAD_KEYWORDS = [
	"reaction",
	"review",
	"podcast",
	"interview",
	"vlog",
	"livestream",
	"live stream",
	"news",
	"analysis",
	"commentary",
	"tiktok",
	"shorts",
	"funny",
	"meme",
	"tutorial",
	"how to",
	"unboxing",
	"gameplay",
	"walkthrough",
	"highlights",
	"compilation",
	"teaser",
	"trailer",
	"parody",
	"blog",
	"talk show",
];

function getContentQualityScore(track: Track): number {
	const title = normalize(track.title);
	let score = 0;

	// Ưu tiên cực cao cho official content
	for (const k of OFFICIAL_KEYWORDS) {
		if (title.includes(k)) score += 100;
	}

	// Nhạc thường
	for (const k of MUSIC_KEYWORDS) {
		if (title.includes(k)) score += 20;
	}

	// Phạt nặng content không phải nhạc
	for (const k of BAD_KEYWORDS) {
		if (title.includes(k)) score -= 200;
	}

	// Kênh chính thức
	const author = normalize(track?.author || track?.metadata?.author || "");
	if (
		author.includes("vevo") ||
		author.includes("official") ||
		author.includes("topic") ||
		author.includes("records") ||
		author.includes("music")
	) {
		score += 30;
	}

	// Phạt video quá dài hoặc quá ngắn (nhạc thường 2-7p)
	const duration = track.duration || 0;
	if (duration > 12 * 60 * 1000) score -= 150; // Quá dài (podcast/mix)
	if (duration < 60 * 1000 && !title.includes("interlude")) score -= 100; // Quá ngắn (shorts/intro)

	return score;
}

function dedupeTracks(tracks: Track[]): Track[] {
	const unique = new Map<string, Track>();

	for (const track of tracks) {
		const key = normalize(`${track.title} ${track?.author || track?.metadata?.author || ""}`);

		const existing = unique.get(key);

		if (!existing) {
			unique.set(key, track);
			continue;
		}

		const oldScore = getContentQualityScore(existing);
		const newScore = getContentQualityScore(track);

		if (newScore > oldScore) {
			unique.set(key, track);
		}
	}

	return [...unique.values()];
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
	// 1. Độ tương đồng tiêu đề (max ~100)
	score += similarity(titleA, titleB) * 60;
	score += tokenOverlap(titleA, titleB) * 40;

	// 2. Chất lượng nội dung (có thể âm rất nặng)
	const qualityScore = getContentQualityScore(candidate);
	score += qualityScore;

	// 3. Cùng nghệ sĩ (nếu biết)
	const authorA = normalize(base.author || base.metadata?.author || "");
	const authorB = normalize(candidate.author || candidate.metadata?.author || "");
	if (authorA && authorB && (authorA.includes(authorB) || authorB.includes(authorA))) {
		score += 40;
	}

	return score;
}

type ExtractedMediaId = {
	platform: "youtube" | "spotify" | "soundcloud" | "unknown";
	id: string;
	url: string;
};

export function extractMediaId(input: string): ExtractedMediaId | null {
	try {
		const url = new URL(input);

		const host = url.hostname.replace(/^www\./, "").toLowerCase();

		// =====================================================
		// YOUTUBE
		// =====================================================
		if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
			const videoId = url.searchParams.get("v");

			if (videoId) {
				return {
					platform: "youtube",
					id: videoId,
					url: `https://www.youtube.com/watch?v=${videoId}`,
				};
			}
		}

		if (host === "youtu.be") {
			const id = url.pathname.slice(1);

			if (id) {
				return {
					platform: "youtube",
					id,
					url: `https://www.youtube.com/watch?v=${id}`,
				};
			}
		}

		// =====================================================
		// SPOTIFY
		// =====================================================
		if (host === "open.spotify.com") {
			const parts = url.pathname.split("/").filter(Boolean);

			// track/playlist/album/episode/show
			if (parts.length >= 2) {
				const [, id] = parts;

				return {
					platform: "spotify",
					id,
					url: `https://open.spotify.com/${parts[0]}/${id}`,
				};
			}
		}

		// spotify uri
		if (input.startsWith("spotify:")) {
			const parts = input.split(":");

			if (parts.length >= 3) {
				return {
					platform: "spotify",
					id: parts[2],
					url: `https://open.spotify.com/${parts[1]}/${parts[2]}`,
				};
			}
		}

		// =====================================================
		// SOUNDCLOUD
		// =====================================================
		if (host === "soundcloud.com") {
			const path = url.pathname.split("/").filter(Boolean);

			if (path.length >= 2) {
				const id = `${path[0]}/${path[1]}`;

				return {
					platform: "soundcloud",
					id,
					url: `https://soundcloud.com/${id}`,
				};
			}
		}

		return null;
	} catch {
		return null;
	}
}

interface SearchCacheEntry {
	result: SearchResult;
	timestamp: number;
	expiresAt: number;
}

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
	private searchCache: Map<string, SearchCacheEntry> = new Map();
	private readonly STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private pendingStreams: Map<string, Promise<StreamInfo | null>> = new Map(); // Dedupe in-flight requests
	private pendingSearches: Map<string, Promise<SearchResult | null>> = new Map(); // Dedupe search requests
	private streamManager?: StreamManager;

	constructor(player: Player, manager: PlayerManager, options: PluginManagerOptions) {
		this.player = player;
		this.manager = manager;
		this.options = {
			maxFallbackAttempts: 3,
			enableCache: true,
			searchMinScore: 30,
			searchCacheTTL: 2 * 60 * 1000, // 2 minutes
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
		for (const plugin of this.getAll()) {
			if (plugin.name && query.toLowerCase().includes(plugin.name.toLowerCase())) {
				return plugin;
			}
		}
		return this.getAll().find((plugin) => plugin.canHandle?.(query) ?? false);
	}

	clear(): void {
		this.plugins.clear();
		this.streamCache.clear();
		this.searchCache.clear();
		this.pendingStreams.clear();
		this.pendingSearches.clear();
	}

	setStreamManager(manager: StreamManager): void {
		this.streamManager = manager;
	}
	//#region Search advanced scoring

	private getSearchCacheKey(query: string, requestedBy: string): string {
		return `${query.toLowerCase().trim()}:${requestedBy}`;
	}

	private getCachedSearch(query: string, requestedBy: string): SearchResult | null {
		if (!this.options.enableCache) return null;

		const key = this.getSearchCacheKey(query, requestedBy);
		const cached = this.searchCache.get(key);

		if (cached && Date.now() < cached.expiresAt) {
			this.debug(`[SearchCache] Hit for query: ${query}`);
			return cached.result;
		}

		if (cached) {
			this.debug(`[SearchCache] Expired for query: ${query}`);
			this.searchCache.delete(key);
		}

		return null;
	}

	private setCachedSearch(query: string, requestedBy: string, result: SearchResult): void {
		if (!this.options.enableCache) return;

		const key = this.getSearchCacheKey(query, requestedBy);
		this.searchCache.set(key, {
			result,
			timestamp: Date.now(),
			expiresAt: Date.now() + (this.options.searchCacheTTL ?? 2 * 60 * 1000),
		});
		this.debug(`[SearchCache] Stored for query: ${query}, tracks: ${result.tracks.length}`);
	}

	/**
	 * Search with deduplication and evaluation of results
	 * @param query Search query
	 * @param requestedBy User who requested the search
	 * @returns Evaluated search result
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult | null> {
		if (!query || !query.trim()) {
			this.debug(`[Search] Empty query provided`);
			return null;
		}

		const trimmedQuery = query.trim();
		this.debug(`[Search] Called with query: "${trimmedQuery}", requestedBy: ${requestedBy}`);

		// Check cache
		const cached = this.getCachedSearch(trimmedQuery, requestedBy);
		if (cached) {
			this.debug(`[Search] Returning cached result for: ${trimmedQuery}`);
			return cached;
		}

		// Check in-flight request
		const dedupeKey = this.getSearchCacheKey(trimmedQuery, requestedBy);
		if (this.pendingSearches.has(dedupeKey)) {
			this.debug(`[Search] Waiting for in-flight request: ${trimmedQuery}`);
			return this.pendingSearches.get(dedupeKey)!;
		}

		// Create new search request
		const searchPromise = this.searchInternal(trimmedQuery, requestedBy);
		this.pendingSearches.set(dedupeKey, searchPromise);

		try {
			const result = await searchPromise;

			return result;
		} finally {
			this.pendingSearches.delete(dedupeKey);
		}
	}

	private async searchInternal(query: string, requestedBy: string): Promise<SearchResult | null> {
		const timeoutMs = this.options.extractorTimeout ?? 15000;

		const plugins = this.getAll().filter((p) => typeof p.search === "function");

		if (!plugins.length) return null;

		const settled = await Promise.allSettled(
			plugins.map(async (plugin) => {
				try {
					const result = await withTimeout(plugin.search(query, requestedBy), timeoutMs, `Search timeout for ${plugin.name}`);

					if (!result?.tracks?.length) {
						return null;
					}

					// giữ nguyên playlist
					if (result.playlist) {
						return {
							...result,
							tracks: result.tracks.map((track) => ({
								...track,
								source: plugin.name,
							})),
						};
					}

					return {
						...result,
						tracks: result.tracks.map((track) => ({
							...track,
							source: plugin.name,
						})),
					};
				} catch (e) {
					this.debug(`[Search] ${plugin.name} failed`, e);
					return null;
				}
			}),
		);

		const results: SearchResult[] = [];

		for (const result of settled) {
			if (result.status === "fulfilled" && result.value) {
				results.push(result.value);
			}
		}

		if (!results.length) {
			return null;
		}

		const playlistResult = results.find((r) => r.playlist);

		if (playlistResult) {
			this.setCachedSearch(query, requestedBy, playlistResult);

			this.debug(`[Search] Returning playlist: ${playlistResult.playlist?.name} (${playlistResult.tracks.length} tracks)`);

			return playlistResult;
		}

		const allTracks = results.flatMap((r) => r.tracks);

		const deduped = dedupeTracks(allTracks);

		const queryMedia = extractMediaId(query);

		const prioritized: Track[] = [];
		const normal: Track[] = [];

		for (const track of deduped) {
			let shouldPrioritize = false;

			// exact url
			if (track.url?.toLowerCase() === query.toLowerCase()) {
				shouldPrioritize = true;
			}

			// exact media id
			const media = extractMediaId(track.url || "");

			if (!shouldPrioritize && queryMedia && media && queryMedia.platform === media.platform && queryMedia.id === media.id) {
				shouldPrioritize = true;
			}

			if (shouldPrioritize) {
				prioritized.push(track);
			} else {
				normal.push(track);
			}
		}

		const tracks = [...prioritized, ...normal];

		const finalResult: SearchResult = {
			query,
			tracks,
			source: "multi-search",
		};

		this.setCachedSearch(query, requestedBy, finalResult);

		this.debug(`[Search] Aggregated ${tracks.length} tracks from ${plugins.length} plugins`);
		return finalResult;
	}
	/**
	 * Get plugin priority groups info for debugging
	 */
	getPriorityGroupsInfo(): { priority: number; plugins: string[]; count: number }[] {
		const groups = new Map<number, string[]>();

		for (const plugin of this.getAll()) {
			const priority = plugin.priority ?? 0;
			if (!groups.has(priority)) {
				groups.set(priority, []);
			}
			groups.get(priority)!.push(plugin.name);
		}

		return Array.from(groups.entries())
			.map(([priority, plugins]) => ({
				priority,
				plugins,
				count: plugins.length,
			}))
			.sort((a, b) => b.priority - a.priority);
	}

	/**
	 * Clear search cache
	 */
	clearSearchCache(): void {
		const size = this.searchCache.size;
		this.searchCache.clear();
		this.debug(`[SearchCache] Cleared ${size} entries`);
	}

	/**
	 * Get search cache stats
	 */
	getSearchCacheStats(): { size: number; keys: string[] } {
		return {
			size: this.searchCache.size,
			keys: Array.from(this.searchCache.keys()),
		};
	}

	//#endregion

	//#region Stream methods (giữ nguyên)

	private getStreamCacheKey(track: Track): string {
		return `${track.source}:${track.url}:${track.id || track.title}`;
	}

	private getCachedStream(track: Track): StreamInfo | null {
		if (!this.options.enableCache) return null;

		const key = this.getStreamCacheKey(track);
		const cached = this.streamCache.get(key);

		if (cached && Date.now() < cached.expiresAt) {
			const s = cached.streamInfo?.stream;
			if (!s || s.destroyed || (s as any).readable === false) {
				this.debug(`[StreamCache] Dead stream detected, evicting: ${track.title}`);
				this.streamCache.delete(key);
				return null;
			}
			this.debug(`[StreamCache] Hit for track: ${track.title}`);
			return cached.streamInfo;
		}

		if (cached) {
			this.debug(`[StreamCache] Expired for track: ${track.title}`);
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
		this.debug(`[StreamCache] Stored for track: ${track.title}`);
	}

	private async getStreamWithDedupe(track: Track, primary: BasePlugin): Promise<StreamInfo | null> {
		const key = this.getStreamCacheKey(track);

		if (this.pendingStreams.has(key)) {
			this.debug(`[StreamDedupe] Waiting for existing request: ${track.title}`);
			return this.pendingStreams.get(key)!;
		}

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
		// Reuse existing stream from StreamManager
		if (this.streamManager) {
			const existingStream = this.streamManager.getStreamByTrack(track.id || track.title);

			if (existingStream) {
				this.debug(`[Stream] Using existing stream from manager`);

				return {
					stream: existingStream,
					type: "arbitrary",
				};
			}
		}

		const timeoutMs = this.options.extractorTimeout ?? 50000;

		// Cache
		const cached = this.getCachedStream(track);

		if (cached) {
			this.debug(`[Stream] Using cached stream for: ${track.title}`);
			return cached;
		}

		/**
		 * Try resolve stream from plugin
		 * Flow:
		 *   1. plugin.getStream()
		 *   2. validate stream
		 *   3. if failed -> plugin.getFallback()
		 */
		const tryPlugin = async (
			plugin: BasePlugin,
			isPrimary: boolean = false,
		): Promise<{ result: StreamInfo | null; similarity: number }> => {
			const controller = new AbortController();

			let result: StreamInfo | null = null;

			// =========================================================
			// 1. TRY DIRECT STREAM
			// =========================================================
			if (plugin?.getStream && plugin.validate?.(track.url ?? "")) {
				try {
					this.debug(`[Stream] ${plugin.name} trying direct stream`);

					result = await withTimeout(plugin.getStream(track, controller.signal), timeoutMs, `${plugin.name} getStream timeout`);

					if (result?.stream) {
						const valid = await this.validateStreamMatchesTrack(result, track);

						if (valid) {
							this.debug(`[Stream] ${plugin.name} direct stream success`);

							return {
								result,
								similarity: 1,
							};
						}

						this.debug(`[Stream] ${plugin.name} returned invalid stream`);
					} else {
						this.debug(`[Stream] ${plugin.name} no direct stream returned`);
					}
				} catch (error) {
					this.debug(`[Stream] ${plugin.name} getStream failed:`, error instanceof Error ? error.message : error);
				}
			}

			// =========================================================
			// 2. TRY FALLBACK SEARCH
			// =========================================================
			if (plugin.getFallback) {
				try {
					this.debug(`[Stream] ${plugin.name} trying fallback resolver`);

					result = await withTimeout(plugin.getFallback(track, controller.signal), timeoutMs, `${plugin.name} fallback timeout`);

					if (result?.stream) {
						const similarity = this.calculateTrackSimilarity(track, {
							title: result.metadata?.title || result.metadata?.originalTitle || track.title,
						});

						this.debug(`[Stream] ${plugin.name} fallback success (${similarity})`);

						return {
							result,
							similarity,
						};
					}

					this.debug(`[Stream] ${plugin.name} fallback returned no stream`);
				} catch (error) {
					this.debug(`[Stream] ${plugin.name} fallback failed:`, error instanceof Error ? error.message : error);
				}
			}

			return {
				result: null,
				similarity: 0,
			};
		};

		// =========================================================
		// PRIMARY PLUGIN
		// =========================================================
		const primaryResult = await tryPlugin(primary, true);

		if (primaryResult.result?.stream) {
			this.setCachedStream(track, primaryResult.result);

			return primaryResult.result;
		}

		// =========================================================
		// FALLBACK PLUGINS
		// =========================================================
		const fallbackPlugins = this.getAll()
			.filter((p) => p !== primary && p.name !== primary.name)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		if (fallbackPlugins.length === 0) {
			this.debug(`[Stream] No fallback plugins available`);
			return null;
		}

		this.debug(`[Stream] Trying ${fallbackPlugins.length} fallback plugins`);

		const validResults: Array<{
			plugin: string;
			streamInfo: StreamInfo;
			score: number;
		}> = [];

		let attempt = 0;

		for (const plugin of fallbackPlugins) {
			attempt++;

			if (attempt > (this.options.maxFallbackAttempts ?? 3)) {
				this.debug(`[Stream] Max fallback attempts reached`);
				break;
			}

			const { result, similarity } = await tryPlugin(plugin);

			if (!result?.stream) {
				continue;
			}

			// Perfect / good match
			if (similarity >= 0.7) {
				this.debug(`[Stream] Success via fallback ${plugin.name} (score: ${similarity})`);

				this.setCachedStream(track, result);

				return result;
			}

			// Keep low similarity result as backup
			validResults.push({
				plugin: plugin.name,
				streamInfo: result,
				score: similarity,
			});

			this.debug(`[Stream] ${plugin.name} low similarity match (${similarity})`);
		}

		// =========================================================
		// BEST AVAILABLE MATCH
		// =========================================================
		if (validResults.length > 0) {
			const bestMatch = validResults.sort((a, b) => b.score - a.score)[0];

			this.debug(`[Stream] Using best available match from ${bestMatch.plugin} (${bestMatch.score})`);

			this.setCachedStream(track, bestMatch.streamInfo);

			return bestMatch.streamInfo;
		}

		this.debug(`[Stream] All plugins failed for: ${track.title}`);

		return null;
	}
	async getStream(track: Track): Promise<StreamInfo | null> {
		if (!track) {
			this.debug(`[getStream] No track provided`);
			return null;
		}

		let primary = this.get(track.source);
		if (!primary) {
			primary = this.findPlugin(track.url);
		}
		if (!primary) {
			this.debug(`[getStream] No plugin found for track: ${track.title}`);
			return null;
		}

		return this.getStreamWithDedupe(track, primary);
	}

	hasStreamCandidate(track: Track): boolean {
		if (!track) return false;
		if (this.get(track.source)) return true;
		const query = track.url || track.title || track.source;
		if (!query) return false;
		return !!this.findPlugin(query);
	}

	async getRelatedTracks(track: Track): Promise<Track[]> {
		if (!track) return [];

		const timeoutMs = this.options.extractorTimeout ?? 15000;
		const limit = 20;
		const minSimilarityScore = 10;

		const relatedPlugins = this.getAll()
			.filter((p) => typeof p.getRelatedTracks === "function")
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		if (relatedPlugins.length === 0) {
			return [];
		}

		const history = this.player?.queue?.previousTracks || [];
		const historyUrls = new Set(history.map((t) => t.url));
		const recentAuthors = new Set(
			history
				.slice(-5)
				.map((t) => normalize(t.author || t.metadata?.author || ""))
				.filter(Boolean),
		);
		const currentTrackUrl = track.url;

		const results: Track[] = [];

		const batchSize = 3;
		for (let i = 0; i < relatedPlugins.length; i += batchSize) {
			const batch = relatedPlugins.slice(i, i + batchSize);
			const batchResults = await Promise.allSettled(
				batch.map(async (plugin) => {
					try {
						const related = await withTimeout(
							plugin.getRelatedTracks!(track, { limit, history }),
							timeoutMs,
							`Timeout ${plugin.name}`,
						);
						return Array.isArray(related) ? related : [];
					} catch (err) {
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

		if (results.length === 0) return [];

		const unique = new Map<string, Track>();
		for (const t of results) {
			const author = normalize(t.author || t.metadata?.author || "");
			// Tránh lặp lại bài hát trong lịch sử HOẶC lặp lại nghệ sĩ vừa phát (nếu có nhiều lựa chọn khác)
			const isRecentlyPlayedAuthor = author && recentAuthors.has(author);

			if (!unique.has(t.url) && t.url !== currentTrackUrl && !historyUrls.has(t.url)) {
				// Nếu là nghệ sĩ vừa phát, gắn flag để giảm điểm hoặc xử lý sau
				(t as any)._isRecentAuthor = isRecentlyPlayedAuthor;
				unique.set(t.url, t);
			}
		}

		const ranked = Array.from(unique.values())
			.map((t) => {
				let score = scoreTrack(track, t);
				// Phạt điểm nếu cùng nghệ sĩ vừa phát
				if ((t as any)._isRecentAuthor) score -= 50;
				return { track: t, score };
			})
			.filter((item) => item.score >= minSimilarityScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((x) => x.track);

		this.debug(`[RelatedTracks] Found ${ranked.length} related tracks`);
		return ranked;
	}

	//#endregion

	//#region Utility methods

	clearStreamCache(): void {
		const size = this.streamCache.size;
		this.streamCache.clear();
		this.debug(`[StreamCache] Cleared ${size} entries`);
	}

	getStats(): object {
		return {
			totalPlugins: this.plugins.size,
			pluginNames: Array.from(this.plugins.keys()),
			streamCacheSize: this.streamCache.size,
			searchCacheSize: this.searchCache.size,
			pendingStreams: this.pendingStreams.size,
			pendingSearches: this.pendingSearches.size,
		};
	}

	private async validateStreamMatchesTrack(streamInfo: StreamInfo, expectedTrack: Track): Promise<boolean> {
		const actualTitle = streamInfo.metadata?.title || streamInfo.metadata?.originalTitle;

		if (!actualTitle) {
			return true;
		}

		const similarity = this.calculateTrackSimilarity(expectedTrack, { title: actualTitle } as Track);
		return similarity > 0.6;
	}

	private calculateTrackSimilarity(track1: Track, track2: Partial<Track>): number {
		const normalize = (str: string) =>
			str
				.toLowerCase()
				.replace(/\(.*?\)|\[.*?\]/g, "")
				.replace(/[^a-z0-9\s]/g, "")
				.replace(/\s+/g, " ")
				.trim();

		const title1 = normalize(track1.title);
		const title2 = normalize(track2.title || "");

		if (title1 === title2) return 1.0;
		if (title1.includes(title2) || title2.includes(title1)) return 0.8;

		const words1 = new Set(title1.split(" "));
		const words2 = new Set(title2.split(" "));
		const intersection = new Set([...words1].filter((x) => words2.has(x)));
		const union = new Set([...words1, ...words2]);

		return intersection.size / union.size;
	}

	//#endregion
}
