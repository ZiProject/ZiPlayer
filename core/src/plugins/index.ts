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
	 * Evaluate how well a track matches the search query
	 * @param track Evaluated track
	 * @param query Query default
	 * @returns SearchScore object with score and reason
	 */
	public evaluateTrackMatch(track: Track, query: string): SearchScore {
		const normalizedQuery = normalize(query);
		const normalizedTitle = normalize(track.title);
		const queryLower = query.toLowerCase();
		const urlLower = track.url?.toLowerCase() || "";

		// 1. Evaluate URL match - 100%
		if (urlLower === queryLower || (queryLower.includes(urlLower) && urlLower.length > 10)) {
			return {
				score: 100,
				reason: "URL matches exactly",
				matchedBy: "url",
				exactMatch: true,
			};
		}

		// 2. Evaluate title match exactly - 100%
		if (normalizedTitle === normalizedQuery) {
			return {
				score: 100,
				reason: "Title matches exactly",
				matchedBy: "title",
				exactMatch: true,
			};
		}

		// 3. Evaluate title contains query or vice versa - 70-90%
		if (normalizedTitle.includes(normalizedQuery) && normalizedQuery.length > 5) {
			const ratio = normalizedQuery.length / normalizedTitle.length;
			const score = 70 + Math.min(20, Math.floor(ratio * 20));
			return {
				score,
				reason: `Title contains the query "${query}" (${Math.floor(ratio * 100)}% coverage)`,
				matchedBy: "title",
				exactMatch: false,
			};
		}

		if (normalizedQuery.includes(normalizedTitle) && normalizedTitle.length > 5) {
			const ratio = normalizedTitle.length / normalizedQuery.length;
			const score = 70 + Math.min(20, Math.floor(ratio * 20));
			return {
				score,
				reason: `Query contains the title "${query}" (${Math.floor(ratio * 100)}% overlap)`,
				matchedBy: "title",
				exactMatch: false,
			};
		}

		// 4. Evaluate similarity algorithm - 0-70%
		const simScore = similarity(normalizedTitle, normalizedQuery);
		const tokenScore = tokenOverlap(normalizedTitle, normalizedQuery);
		const contentTypeBonus = detectContentType(track.title);

		// Tính điểm tổng hợp: similarity 60%, token overlap 30%, content type 10%
		let finalScore = simScore * 60 + tokenScore * 30 + (contentTypeBonus / 10) * 10;
		finalScore = Math.min(70, Math.max(0, Math.floor(finalScore)));

		if (finalScore >= 20) {
			let reason = `Similarity ${Math.floor(simScore * 100)}%`;

			if (contentTypeBonus > 0) {
				reason += `, recognized as music content`;
			}

			return {
				score: finalScore,
				reason,
				matchedBy: "partial",
				exactMatch: false,
			};
		}

		// 5. Không match
		return {
			score: 0,
			reason: "No matching results found",
			matchedBy: "none",
			exactMatch: false,
		};
	}

	/**
	 * Evaluate and rank all search results from a plugin
	 * @param tracks List of tracks to evaluate
	 * @param query Original query
	 * @param isPlaylistResult Whether this is a playlist result (skip per-track evaluation)
	 * @returns List of tracks with scores, sorted by score
	 */
	private evaluateAndRankResults(
		tracks: Track[],
		query: string,
		isPlaylistResult: boolean = false,
	): { track: Track; score: SearchScore }[] {
		// 🔥 Nếu là playlist result, giữ nguyên tất cả tracks với điểm 100%
		if (isPlaylistResult && tracks.length > 0) {
			this.debug(`[Evaluation] Playlist detected - keeping all ${tracks.length} tracks`);

			return tracks.map((track) => ({
				track,
				score: {
					score: 100,
					reason: "Part of playlist",
					matchedBy: "playlist",
					exactMatch: false,
				},
			}));
		}

		const evaluated = tracks.map((track) => ({
			track,
			score: this.evaluateTrackMatch(track, query),
		}));

		// Sort by score in descending order (cao xuống thấp)
		evaluated.sort((a, b) => b.score.score - a.score.score);

		// Log evaluation results
		for (const item of evaluated.slice(0, 5)) {
			this.debug(`[Evaluation] "${item.track.title}" -> ${item.score.score}% (${item.score.reason})`);
		}

		return evaluated;
	}
	/**
	 * Select the best result from multiple plugins
	 * @param allResults Results from various plugins
	 * @param query Original query
	 * @returns The best result
	 */
	private selectBestResult(allResults: Map<string, SearchResult>, query: string): SearchResult | null {
		let bestResult: SearchResult | null = null;
		let bestScore = -1;

		for (const [source, result] of allResults) {
			if (!result.tracks || result.tracks.length === 0) continue;

			// Evaluate the first (best) track of this result
			const bestTrackScore = this.evaluateTrackMatch(result.tracks[0], query);

			if (bestTrackScore.score > bestScore) {
				bestScore = bestTrackScore.score;
				bestResult = {
					...result,
					source,
					score: bestTrackScore,
				};
			}

			this.debug(`[Selection] Plugin ${source} -> best match: ${bestTrackScore.score}%`);
		}

		if (bestResult && bestResult.score) {
			this.debug(`[Selection] Selected result from ${bestResult.source} with score ${bestResult.score.score}%`);
		}

		return bestResult;
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
		const minScore = this.options.searchMinScore ?? 30;

		// Get all plugins that support search
		const allSearchPlugins = this.getAll()
			.filter((p) => typeof p.search === "function")
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

		if (allSearchPlugins.length === 0) {
			this.debug(`[Search] No plugins support search`);
			return null;
		}

		const priorityGroups = new Map<number, BasePlugin[]>();
		for (const plugin of allSearchPlugins) {
			const priority = plugin.priority ?? 0;
			if (!priorityGroups.has(priority)) {
				priorityGroups.set(priority, []);
			}
			priorityGroups.get(priority)!.push(plugin);
		}

		const sortedPriorities = Array.from(priorityGroups.keys()).sort((a, b) => b - a);

		this.debug(
			`[Search] Priority groups: ${sortedPriorities.map((p) => `${p} (${priorityGroups.get(p)!.length} plugins)`).join(", ")}`,
		);

		const allResults = new Map<string, SearchResult>();
		const errors: Array<{ plugin: string; error: Error }> = [];

		let foundHighQualityResult = false;
		let bestResultOverall: SearchResult | null = null;
		let bestScoreOverall = -1;

		// 🔥 PROCESS EACH PRIORITY GROUP
		for (const priority of sortedPriorities) {
			const groupPlugins = priorityGroups.get(priority)!;
			this.debug(`[Search] Processing priority group ${priority} with ${groupPlugins.length} plugins`);

			const groupResults = new Map<string, SearchResult>();

			// Process all plugins in current priority group
			for (const plugin of groupPlugins) {
				// Skip if we already found a high-quality result (>=90%) from previous group
				if (foundHighQualityResult) {
					this.debug(`[Search] Skipping plugin ${plugin.name} (priority ${priority}) - already have high-quality result`);
					break;
				}

				try {
					this.debug(`[Search] Trying plugin: ${plugin.name} (priority: ${priority})`);

					const startTime = Date.now();
					const result = await withTimeout(plugin.search(query, requestedBy), timeoutMs, `Search timeout for ${plugin.name}`);

					const duration = Date.now() - startTime;

					if (result && Array.isArray(result.tracks) && result.tracks.length > 0) {
						// 🔥 KIỂM TRA XEM CÓ PLAYLIST HAY KHÔNG
						const hasPlaylist = !!result.playlist;
						const isPlaylistResult = hasPlaylist && result.tracks.length > 1;

						// Evaluate and rank results from this plugin
						const evaluatedTracks = this.evaluateAndRankResults(result.tracks, query, isPlaylistResult);

						const bestScore = evaluatedTracks[0]?.score.score || 0;

						// Filter tracks below minimum score (chỉ áp dụng cho non-playlist)
						let validTracks: Track[];

						if (isPlaylistResult) {
							// 🔥 PLAYLIST: Giữ nguyên tất cả tracks, không lọc theo score
							validTracks = evaluatedTracks.map((item) => item.track);
							this.debug(`[Search] Plugin ${plugin.name} returned playlist with ${validTracks.length} tracks (keeping all)`);
						} else {
							// Single track search: filter by min score
							validTracks = evaluatedTracks.filter((item) => item.score.score >= minScore).map((item) => item.track);
							this.debug(
								`[Search] Plugin ${plugin.name} returned ${validTracks.length}/${result.tracks.length} valid tracks in ${duration}ms (best: ${bestScore}%)`,
							);
						}

						if (validTracks.length > 0) {
							const pluginResult: SearchResult = {
								tracks: validTracks,
								playlist: result.playlist,
								query,
								score: evaluatedTracks[0].score,
								source: plugin.name,
							};

							groupResults.set(plugin.name, pluginResult);
							allResults.set(plugin.name, pluginResult);

							// 🔥 Nếu là playlist hoặc kết quả chất lượng cao, dừng search
							if (isPlaylistResult || bestScore >= 90) {
								foundHighQualityResult = true;
								bestResultOverall = pluginResult;
								bestScoreOverall = bestScore;
								this.debug(`[Search] ${isPlaylistResult ? "Playlist" : "High-quality result"} found, stopping search`);
								break;
							}

							// Track best result overall
							if (bestScore > bestScoreOverall) {
								bestScoreOverall = bestScore;
								bestResultOverall = pluginResult;
							}
						} else {
							this.debug(
								`[Search] Plugin ${plugin.name} returned ${result.tracks.length} tracks but none passed min score ${minScore}`,
							);
						}
					} else {
						this.debug(`[Search] Plugin ${plugin.name} returned no tracks in ${duration}ms`);
					}
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					this.debug(`[Search] Plugin ${plugin.name} failed:`, err.message);
					errors.push({ plugin: plugin.name, error: err });
				}
			}

			// 🔥 AFTER PROCESSING CURRENT GROUP, DECIDE WHETHER TO CONTINUE
			if (foundHighQualityResult) {
				this.debug(`[Search] Found high-quality result (>=90%) in priority group ${priority}, stopping search`);
				break;
			}

			// If current group has at least one valid result, check if we should continue to lower priority groups
			if (groupResults.size > 0) {
				// Get best score from this group
				const bestGroupScore = Math.max(...Array.from(groupResults.values()).map((r) => r.score?.score || 0));

				// If best score in this group is >= 70%, don't try lower priority groups
				if (bestGroupScore >= 70) {
					this.debug(`[Search] Priority group ${priority} has results with score ${bestGroupScore}% (>=70%), stopping search`);
					break;
				}

				// If best score is between 50-70%, continue to lower groups but log it
				if (bestGroupScore >= 50) {
					this.debug(
						`[Search] Priority group ${priority} has results with score ${bestGroupScore}% (50-70%), will try lower priority groups for better results`,
					);
				} else {
					this.debug(
						`[Search] Priority group ${priority} has low quality results (${bestGroupScore}% <50%), trying lower priority groups`,
					);
				}
			} else {
				this.debug(`[Search] Priority group ${priority} produced no valid results, trying lower priority group`);
			}
		}

		// 🔥 SELECT BEST RESULT
		if (bestResultOverall) {
			// Cache the result
			this.setCachedSearch(query, requestedBy, bestResultOverall);

			// Log summary
			const allTracksCount = Array.from(allResults.values()).reduce((sum, r) => sum + r.tracks.length, 0);
			this.debug(
				`[Search] Complete - Best from ${bestResultOverall.source}: ${bestResultOverall.tracks.length} tracks (${bestResultOverall.score?.score || 0}%), Total candidates: ${allTracksCount}`,
			);

			return bestResultOverall;
		}

		// 🔥 FALLBACK: If we have any results that didn't meet min score, return the best one
		if (allResults.size === 0 && errors.length > 0) {
			// Try to get best result from allResults even if below min score
			let fallbackResult: SearchResult | null = null;
			let fallbackScore = -1;

			for (const [source, result] of allResults) {
				const score = result.score?.score || 0;
				if (score > fallbackScore) {
					fallbackScore = score;
					fallbackResult = result;
				}
			}

			if (fallbackResult) {
				this.debug(`[Search] Using fallback result with score ${fallbackScore}% (below minimum ${minScore}%)`);
				return fallbackResult;
			}

			this.debug(`[Search] All ${allSearchPlugins.length} plugins failed for query: ${query}`);
			const lastError = errors[errors.length - 1]?.error;
			if (lastError) throw lastError;
		}

		return null;
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
			if (plugin.getStream) {
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
			if (!unique.has(t.url) && t.url !== currentTrackUrl && !historyUrls.has(t.url)) {
				unique.set(t.url, t);
			}
		}

		const ranked = Array.from(unique.values())
			.map((t) => ({ track: t, score: scoreTrack(track, t) }))
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
