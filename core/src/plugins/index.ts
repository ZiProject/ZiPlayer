import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo, SearchResult, VideoResolveOptions, TrackResolveContext, PluginManagerOptions } from "../types";
import { normalizeStreamInfo } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";
import { StreamManager } from "../structures/StreamManager";

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
		const media = extractMediaId(track.url || "");
		const normalizedUrl = track.url?.trim().replace(/\/+$/, "").toLowerCase();
		const key =
			media ? `media:${media.platform}:${media.id}`
			: normalizedUrl ? `url:${normalizedUrl}`
			: `title:${normalize(`${track.title} ${track?.author || track?.metadata?.author || ""}`)}`;

		const existing = unique.get(key);

		if (!existing) {
			unique.set(key, track);
			continue;
		}

		if (!key.startsWith("title:")) continue;

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

interface PluginRuntime {
	streamManager?: StreamManager;
	extractorTimeout?: number;
	destroyed: boolean;
	plugins: Map<string, BasePlugin>;
	pluginRegistrationIndex: Map<string, number>;
	disabledPlugins: Set<string>;
	streamCache: Map<string, StreamCacheEntry>;
	pendingStreams: Map<string, Promise<StreamInfo | null>>;
}

const createPluginRuntime = (): PluginRuntime => ({
	destroyed: false,
	plugins: new Map(),
	pluginRegistrationIndex: new Map(),
	disabledPlugins: new Set(),
	streamCache: new Map(),
	pendingStreams: new Map(),
});

export class PluginManager {
	private options: PluginManagerOptions;
	private player?: Player;
	private manager?: PlayerManager;
	private plugins: Map<string, BasePlugin> = new Map();
	private pluginRegistrationIndex: Map<string, number> = new Map();
	private registrationCounter = 0;
	private readonly runtimes = new Map<string, PluginRuntime>();
	private readonly defaultRuntime = createPluginRuntime();
	private searchCache: Map<string, SearchCacheEntry> = new Map();
	private readonly STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private pendingSearches: Map<string, Promise<SearchResult | null>> = new Map(); // Dedupe search requests
	private destroyed = false;

	constructor(options?: PluginManagerOptions);
	constructor(player?: Player | null, manager?: PlayerManager | null, options?: PluginManagerOptions);
	constructor(
		playerOrOptions?: Player | PluginManagerOptions | null,
		manager?: PlayerManager | null,
		options?: PluginManagerOptions,
	) {
		const isLegacyCall =
			manager !== undefined ||
			Boolean(
				playerOrOptions &&
				typeof playerOrOptions === "object" &&
				("guildId" in (playerOrOptions as any) || "bus" in (playerOrOptions as any)),
			);

		if (isLegacyCall) {
			this.player = (playerOrOptions as Player) ?? undefined;
			this.manager = manager ?? undefined;
			this.options = {
				maxFallbackAttempts: 3,
				enableCache: true,
				searchMinScore: 30,
				searchCacheTTL: 2 * 60 * 1000, // 2 minutes
				...options,
			};
		} else {
			const opts = (playerOrOptions as PluginManagerOptions) || {};
			this.player = undefined;
			this.manager = undefined;
			this.options = {
				maxFallbackAttempts: 3,
				enableCache: true,
				searchMinScore: 30,
				searchCacheTTL: 2 * 60 * 1000, // 2 minutes
				...opts,
			};
		}
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.options.debug) {
			this.options.debug(message, ...optionalParams);
		} else if (this.manager?.debugEnabled) {
			this.manager.emit("debug", `[Plugins] ${message}`, ...optionalParams);
		}
	}

	register(plugin: BasePlugin): void {
		if (this.plugins.has(plugin.name)) {
			this.debug(`Overwriting existing plugin: ${plugin.name}`);
		} else {
			this.pluginRegistrationIndex.set(plugin.name, this.registrationCounter++);
		}
		plugin.priority ??= 0;
		this.plugins.set(plugin.name, plugin);
		for (const runtime of this.runtimes.values()) runtime.disabledPlugins.delete(plugin.name);
		this.clearSearchCache();
		this.debug(`Registered plugin: ${plugin.name} (priority: ${plugin.priority})`);
	}

	registerPlayerPlugin(playerId: string, plugin: BasePlugin): void {
		const runtime = this.runtimes.get(playerId);
		if (!runtime) throw new Error(`PluginManager has no runtime for player "${playerId}"`);
		if (!runtime.plugins.has(plugin.name)) runtime.pluginRegistrationIndex.set(plugin.name, this.registrationCounter++);
		runtime.disabledPlugins.delete(plugin.name);
		plugin.priority ??= 0;
		runtime.plugins.set(plugin.name, plugin);
		this.clearSearchCache(playerId);
		this.debug(`Registered player plugin: ${plugin.name} (${playerId})`);
	}

	unregister(name: string): boolean {
		const removed = this.plugins.delete(name);
		this.pluginRegistrationIndex.delete(name);
		this.clearSearchCache();
		if (removed) this.debug(`Unregistered plugin: ${name}`);
		return removed;
	}

	unregisterPlayerPlugin(playerId: string, name: string): boolean {
		const runtime = this.runtimes.get(playerId);
		if (!runtime) return false;
		const removed = runtime.plugins.delete(name) || (this.plugins.has(name) && !runtime.disabledPlugins.has(name));
		if (!removed) return false;
		runtime.pluginRegistrationIndex.delete(name);
		runtime.disabledPlugins.add(name);
		this.clearSearchCache(playerId);
		this.debug(`Unregistered player plugin: ${name} (${playerId})`);
		return true;
	}

	get(name: string, playerId?: string): BasePlugin | undefined {
		const runtime = playerId ? this.runtimes.get(playerId) : undefined;
		if (runtime?.plugins.has(name)) return runtime.plugins.get(name);
		if (runtime?.disabledPlugins.has(name)) return undefined;
		return this.plugins.get(name);
	}

	getAll(playerId?: string): BasePlugin[] {
		const runtime = playerId ? this.runtimes.get(playerId) : undefined;
		const available = new Map(this.plugins);
		if (runtime) {
			for (const name of runtime.disabledPlugins) available.delete(name);
			for (const [name, plugin] of runtime.plugins) available.set(name, plugin);
		}
		return Array.from(available.values()).sort((a, b) => {
			const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
			if (priorityDiff !== 0) return priorityDiff;
			const indexA = runtime?.pluginRegistrationIndex.get(a.name) ?? this.pluginRegistrationIndex.get(a.name) ?? 0;
			const indexB = runtime?.pluginRegistrationIndex.get(b.name) ?? this.pluginRegistrationIndex.get(b.name) ?? 0;
			return indexA - indexB;
		});
	}

	findPlugin(query: string, playerId?: string): BasePlugin | undefined {
		if (!query || typeof query !== "string") return undefined;
		for (const plugin of this.getAll(playerId)) {
			if (plugin.name && query.toLowerCase().includes(plugin.name.toLowerCase())) {
				return plugin;
			}
		}
		return this.getAll(playerId).find((plugin) => plugin.canHandle?.(query) ?? false);
	}

	clear(): void {
		this.plugins.clear();
		this.pluginRegistrationIndex.clear();
		this.registrationCounter = 0;
		this.searchCache.clear();
		this.pendingSearches.clear();
		this.clearRuntime(this.defaultRuntime, true);
		for (const runtime of this.runtimes.values()) this.clearRuntime(runtime, true);
		this.runtimes.clear();
	}

	private clearRuntime(runtime: PluginRuntime, destroyStreams: boolean): void {
		if (destroyStreams) {
			for (const entry of runtime.streamCache.values()) {
				const stream = entry.streamInfo?.stream as { destroy?: () => void; destroyed?: boolean } | undefined;
				if (stream && typeof stream.destroy === "function" && !stream.destroyed) {
					try {
						stream.destroy();
					} catch {}
				}
			}
		}
		runtime.plugins.clear();
		runtime.pluginRegistrationIndex.clear();
		runtime.disabledPlugins.clear();
		runtime.streamCache.clear();
		runtime.pendingStreams.clear();
	}

	attachPlayer(playerId: string, streamManager: StreamManager, extractorTimeout?: number): void {
		if (this.runtimes.has(playerId)) this.detachPlayer(playerId);
		const runtime = createPluginRuntime();
		runtime.streamManager = streamManager;
		runtime.extractorTimeout = extractorTimeout;
		this.runtimes.set(playerId, runtime);
	}

	hasPlayerRuntime(playerId: string): boolean {
		return this.runtimes.has(playerId);
	}

	detachPlayer(playerId: string): void {
		const runtime = this.runtimes.get(playerId);
		if (!runtime) return;
		runtime.destroyed = true;
		this.clearRuntime(runtime, true);
		this.runtimes.delete(playerId);
		this.clearPlayerSearchState(playerId);
	}

	private clearPlayerSearchState(playerId: string): void {
		const prefix = `${playerId}:`;
		for (const key of this.searchCache.keys()) if (key.startsWith(prefix)) this.searchCache.delete(key);
		for (const key of this.pendingSearches.keys()) if (key.startsWith(prefix)) this.pendingSearches.delete(key);
	}

	clearPlayerPlugins(playerId: string): void {
		const runtime = this.runtimes.get(playerId);
		if (!runtime) return;
		runtime.plugins.clear();
		runtime.pluginRegistrationIndex.clear();
		runtime.disabledPlugins = new Set(this.plugins.keys());
		runtime.streamCache.clear();
		runtime.pendingStreams.clear();
		this.clearPlayerSearchState(playerId);
	}

	/**
	 * Full teardown hook so PlayerManager's generic `.dispose()`/`.destroy()`
	 * duck-typed resolver can find and call this. `clear()` alone is never invoked by
	 * that resolver (it only looks for `dispose`/`destroy`), and even `clear()` only
	 * drops the Map entries without closing the underlying streams. Without this method,
	 * every cached `StreamInfo.stream` handle (up to STREAM_CACHE_TTL = 5 minutes old)
	 * survives player destroy as a live, unreferenced-by-anyone-but-us stream.
	 */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.clear();
	}

	setStreamManager(manager: StreamManager): void {
		this.defaultRuntime.streamManager = manager;
	}
	//#region Search advanced scoring

	private getSearchCacheKey(query: string, requestedBy: string, pluginsKey?: string, playerId?: string): string {
		return `${playerId ?? "global"}:${query.toLowerCase().trim()}:${requestedBy}:${pluginsKey ?? "all"}`;
	}

	private getCachedSearch(query: string, requestedBy: string, pluginsKey?: string, playerId?: string): SearchResult | null {
		if (!this.options.enableCache) return null;

		const key = this.getSearchCacheKey(query, requestedBy, pluginsKey, playerId);
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

	private setCachedSearch(
		query: string,
		requestedBy: string,
		result: SearchResult,
		pluginsKey?: string,
		playerId?: string,
	): void {
		if (!this.options.enableCache || this.destroyed || (playerId && !this.runtimes.has(playerId))) return;

		const key = this.getSearchCacheKey(query, requestedBy, pluginsKey, playerId);
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
	 * @param requestedByOrOptions User who requested the search, or an options object
	 * @returns Evaluated search result
	 */
	async search(
		query: string,
		requestedByOrOptions: string | { requestedBy?: string; plugins?: string | string[]; signal?: AbortSignal; playerId?: string },
		signal?: AbortSignal,
	): Promise<SearchResult | null> {
		const opts = typeof requestedByOrOptions === "object" ? requestedByOrOptions : { requestedBy: requestedByOrOptions };
		const requestedBy = opts.requestedBy ?? "Unknown";
		const effectiveSignal = opts.signal ?? signal;
		const pluginsFilter = opts.plugins;
		const playerId = opts.playerId;

		if (effectiveSignal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (this.destroyed) return null;
		if (playerId && !this.runtimes.has(playerId)) return null;
		if (!query || !query.trim()) {
			this.debug(`[Search] Empty query provided`);
			return null;
		}

		const trimmedQuery = query.trim();
		const selectedPluginNames =
			pluginsFilter !== undefined ?
				(Array.isArray(pluginsFilter) ? pluginsFilter : [pluginsFilter]).map((p) => p.toLowerCase())
			:	null;
		const pluginsKey = selectedPluginNames ? [...selectedPluginNames].sort().join(",") : "all";

		this.debug(`[Search] Called with query: "${trimmedQuery}", requestedBy: ${requestedBy}, plugins: ${pluginsKey}`);

		// Check cache
		const cached = this.getCachedSearch(trimmedQuery, requestedBy, pluginsKey, playerId);
		if (cached) {
			this.debug(`[Search] Returning cached result for: ${trimmedQuery}`);
			return cached;
		}

		// Check in-flight request
		const dedupeKey = this.getSearchCacheKey(trimmedQuery, requestedBy, pluginsKey, playerId);
		let searchPromise = this.pendingSearches.get(dedupeKey);
		if (!searchPromise) {
			searchPromise = this.searchInternal(trimmedQuery, requestedBy, selectedPluginNames, pluginsKey, playerId).finally(() => {
				if (this.pendingSearches.get(dedupeKey) === searchPromise) this.pendingSearches.delete(dedupeKey);
			});
			this.pendingSearches.set(dedupeKey, searchPromise);
		} else {
			this.debug(`[Search] Waiting for in-flight request: ${trimmedQuery}`);
		}

		if (!effectiveSignal) return searchPromise;

		return new Promise<SearchResult | null>((resolve, reject) => {
			const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
			if (effectiveSignal.aborted) return onAbort();
			effectiveSignal.addEventListener("abort", onAbort, { once: true });
			searchPromise!
				.then((result) => {
					effectiveSignal.removeEventListener("abort", onAbort);
					resolve(result);
				})
				.catch((err) => {
					effectiveSignal.removeEventListener("abort", onAbort);
					reject(err);
				});
		});
	}

	private async searchInternal(
		query: string,
		requestedBy: string,
		selectedPluginNames?: string[] | null,
		pluginsKey?: string,
		playerId?: string,
	): Promise<SearchResult | null> {
		const timeoutMs =
			playerId ? (this.runtimes.get(playerId)?.extractorTimeout ?? 15000) : (this.options.extractorTimeout ?? 15000);

		let plugins = this.getAll(playerId).filter((p) => typeof p.search === "function");
		if (selectedPluginNames !== null && selectedPluginNames !== undefined) {
			plugins = plugins.filter((p) => selectedPluginNames.includes(p.name.toLowerCase()));
		}

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
			this.setCachedSearch(query, requestedBy, playlistResult, pluginsKey, playerId);

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

		this.setCachedSearch(query, requestedBy, finalResult, pluginsKey, playerId);

		this.debug(`[Search] Aggregated ${tracks.length} tracks from ${plugins.length} plugins`);
		return finalResult;
	}
	/**
	 * Get plugin priority groups info for debugging
	 */
	getPriorityGroupsInfo(playerId?: string): { priority: number; plugins: string[]; count: number }[] {
		const groups = new Map<number, string[]>();

		for (const plugin of this.getAll(playerId)) {
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
	clearSearchCache(playerId?: string): void {
		const matchingKeys =
			playerId ? [...this.searchCache.keys()].filter((key) => key.startsWith(`${playerId}:`)) : [...this.searchCache.keys()];
		const size = matchingKeys.length;
		for (const key of matchingKeys) this.searchCache.delete(key);
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

	//#region Stream methods

	private getStreamCacheKey(track: Track): string {
		return `${track.source}:${track.url}:${track.id || track.title}`;
	}

	private getCachedStream(track: Track, runtime: PluginRuntime): StreamInfo | null {
		if (!this.options.enableCache) return null;

		const key = this.getStreamCacheKey(track);
		const cached = runtime.streamCache.get(key);

		if (cached && Date.now() < cached.expiresAt) {
			const s = cached.streamInfo?.stream;
			if (!s || s.destroyed || (s as any).readable === false) {
				this.debug(`[StreamCache] Dead stream detected, evicting: ${track.title}`);
				runtime.streamCache.delete(key);
				return null;
			}
			this.debug(`[StreamCache] Hit for track: ${track.title}`);
			return cached.streamInfo;
		}

		if (cached) {
			this.debug(`[StreamCache] Expired for track: ${track.title}`);
			runtime.streamCache.delete(key);
		}

		return null;
	}

	private setCachedStream(track: Track, streamInfo: StreamInfo, runtime: PluginRuntime): void {
		if (!this.options.enableCache || this.destroyed || runtime.destroyed || streamInfo.remote) return;

		const key = this.getStreamCacheKey(track);
		runtime.streamCache.set(key, {
			streamInfo,
			timestamp: Date.now(),
			expiresAt: Date.now() + this.STREAM_CACHE_TTL,
		});
		this.debug(`[StreamCache] Stored for track: ${track.title}`);
	}

	private async getStreamWithDedupe(
		track: Track,
		primary: BasePlugin,
		runtime: PluginRuntime,
		playerId?: string,
	): Promise<StreamInfo | null> {
		const key = this.getStreamCacheKey(track);

		if (runtime.pendingStreams.has(key)) {
			this.debug(`[StreamDedupe] Waiting for existing request: ${track.title}`);
			return runtime.pendingStreams.get(key)!;
		}

		const promise = this.getStreamInternal(track, primary, false, runtime, playerId);
		runtime.pendingStreams.set(key, promise);

		try {
			const result = await promise;
			return result;
		} finally {
			if (runtime.pendingStreams.get(key) === promise) runtime.pendingStreams.delete(key);
		}
	}

	private async getStreamInternal(
		track: Track,
		primary: BasePlugin,
		fresh = false,
		runtime: PluginRuntime = this.defaultRuntime,
		playerId?: string,
	): Promise<StreamInfo | null> {
		// Reuse existing stream from StreamManager
		if (!fresh && runtime.streamManager) {
			const existingStream = runtime.streamManager.getStreamByTrack(track.id || track.title);

			if (existingStream) {
				this.debug(`[Stream] Using existing stream from manager`);

				return normalizeStreamInfo(track, {
					stream: existingStream,
					type: "arbitrary",
				});
			}
		}

		const timeoutMs = playerId ? (runtime.extractorTimeout ?? 50000) : (this.options.extractorTimeout ?? 50000);

		// Cache
		const cached = fresh ? null : this.getCachedStream(track, runtime);

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
		const tryPlugin = async (plugin: BasePlugin): Promise<{ result: StreamInfo | null; similarity: number }> => {
			const controller = new AbortController();

			let result: StreamInfo | null = null;

			// =========================================================
			// 1. TRY DIRECT STREAM
			// =========================================================
			if (plugin?.getStream && plugin.validate?.(track.url ?? "")) {
				try {
					this.debug(`[Stream] ${plugin.name} trying direct stream`);

					const rawResult = await withTimeout(
						plugin.getStream(track, controller.signal),
						timeoutMs,
						`${plugin.name} getStream timeout`,
					);
					result = rawResult ? normalizeStreamInfo(track, rawResult) : null;

					if (result?.remote && result?.handle) {
						this.debug(`[Stream] ${plugin.name} direct remote stream success`);

						return {
							result,
							similarity: 1,
						};
					}

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

					const rawResult = await withTimeout(
						plugin.getFallback(track, controller.signal),
						timeoutMs,
						`${plugin.name} fallback timeout`,
					);
					result = rawResult ? normalizeStreamInfo(track, rawResult) : null;

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
		const primaryResult = await tryPlugin(primary);

		if (primaryResult.result?.stream || (primaryResult.result?.remote && primaryResult.result?.handle)) {
			this.setCachedStream(track, primaryResult.result, runtime);

			return primaryResult.result;
		}

		// =========================================================
		// FALLBACK PLUGINS
		// =========================================================
		const fallbackPlugins = this.getAll(playerId).filter((p) => p !== primary && p.name !== primary.name);

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

			if (!result?.stream && !(result?.remote && result?.handle)) {
				continue;
			}

			// Perfect / good match
			if (similarity >= 0.7) {
				this.debug(`[Stream] Success via fallback ${plugin.name} (score: ${similarity})`);

				this.setCachedStream(track, result, runtime);

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

			this.setCachedStream(track, bestMatch.streamInfo, runtime);

			return bestMatch.streamInfo;
		}

		this.debug(`[Stream] All plugins failed for: ${track.title}`);

		return null;
	}
	async getStream(track: Track, options?: { fresh?: boolean; context?: TrackResolveContext }): Promise<StreamInfo | null> {
		if (this.destroyed) return null;
		if (!track) {
			this.debug(`[getStream] No track provided`);
			return null;
		}
		const playerId = options?.context?.playerId;
		const runtime = playerId ? this.runtimes.get(playerId) : this.defaultRuntime;
		if (!runtime || runtime.destroyed) return null;

		// Step 1: Check provenance (Track.source)
		let primary: BasePlugin | undefined;
		if (track.source) {
			primary = this.get(track.source, playerId);
			if (primary) {
				this.debug(`[getStream] Using source plugin for track provenance: ${primary.name}`);
			}
		}

		// Step 2: Fallback candidate resolution if no source or source not registered
		if (!primary) {
			if (track.url) {
				primary = this.findPlugin(track.url, playerId);
			}
			if (!primary) {
				const candidates = this.getAll(playerId);
				primary = candidates[0];
			}
			if (primary) {
				this.debug(`[getStream] Using candidate plugin: ${primary.name}`);
			}
		}

		if (!primary) {
			this.debug(`[getStream] No plugin available for track: ${track.title}`);
			return null;
		}

		if (options?.fresh) return this.getStreamInternal(track, primary, true, runtime, playerId);
		return this.getStreamWithDedupe(track, primary, runtime, playerId);
	}

	hasStreamCandidate(track: Track, playerId?: string): boolean {
		if (!track) return false;
		if (track.source && this.get(track.source, playerId)) return true;
		const query = track.url || track.title || track.source;
		if (query && this.findPlugin(query, playerId)) return true;
		return this.getAll(playerId).some((p) => typeof p.getStream === "function" || typeof p.getFallback === "function");
	}

	async getRelatedTracks(track: Track, context?: TrackResolveContext | { history?: Track[] } | Track[]): Promise<Track[]> {
		if (!track) return [];

		const playerId = context && !Array.isArray(context) && "playerId" in context ? context.playerId : undefined;
		const timeoutMs =
			playerId ? (this.runtimes.get(playerId)?.extractorTimeout ?? 15000) : (this.options.extractorTimeout ?? 15000);
		const limit = 20;
		const minSimilarityScore = 10;

		const relatedPlugins = this.getAll(playerId).filter((p) => typeof p.getRelatedTracks === "function");

		if (relatedPlugins.length === 0) {
			return [];
		}

		const history =
			(Array.isArray(context) ? context
			: context?.history ? context.history
			: this.player?.previousTracks) || [];
		const historyUrls = new Set(history.map((t: Track) => t.url));
		const recentAuthors = new Set(
			history
				.slice(-5)
				.map((t: Track) => normalize(t.author || t.metadata?.author || ""))
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
			const isRecentlyPlayedAuthor = Boolean(author && recentAuthors.has(author));

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
	async getVideo(track: Track, options: VideoResolveOptions & { playerId?: string } = {}): Promise<StreamInfo | null> {
		if (!track) return null;

		let primary = this.get(track.source, options.playerId);
		if (!primary) {
			primary = this.findPlugin(track.url, options.playerId);
		}
		if (!primary) {
			this.debug(`[getStream] No plugin found for track: ${track.title}`);
			return null;
		}

		const candidates = [
			primary,
			...this.getAll(options.playerId)
				.filter((plugin) => plugin !== primary && typeof plugin.getVideo === "function")
				.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
		].filter((plugin, index, list) => list.indexOf(plugin) === index && typeof plugin.getVideo === "function");

		for (const plugin of candidates) {
			const controller = new AbortController();
			const onAbort = () => controller.abort(options.signal?.reason);
			options.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				if (plugin.validate && !plugin.validate(track.url ?? "")) continue;

				this.debug(`[Video] ${plugin.name} resolving video: ${track.title}`);
				const result = await withTimeout(plugin.getVideo!(track, controller.signal), 50000, `${plugin.name} getVideo timeout`);

				if (result?.stream) {
					this.debug(`[Video] ${plugin.name} video stream ready: ${track.title}`);
					return normalizeStreamInfo(track, result);
				}
			} catch (error) {
				this.debug(`[Video] ${plugin.name} getVideo failed:`, error instanceof Error ? error.message : error);
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
		}

		this.debug(`[Video] All plugins failed for: ${track.title}`);
		return null;
	}
	//#endregion

	//#region Utility methods

	clearStreamCache(playerId?: string): void {
		let size = 0;
		if (playerId) {
			const runtime = this.runtimes.get(playerId);
			if (!runtime) return;
			size = runtime.streamCache.size;
			runtime.streamCache.clear();
		} else {
			size = this.defaultRuntime.streamCache.size;
			this.defaultRuntime.streamCache.clear();
			for (const runtime of this.runtimes.values()) {
				size += runtime.streamCache.size;
				runtime.streamCache.clear();
			}
		}
		this.debug(`[StreamCache] Cleared ${size} entries`);
	}

	getStats(playerId?: string): object {
		const runtime = playerId ? this.runtimes.get(playerId) : this.defaultRuntime;
		const streamCacheSize =
			playerId ?
				(runtime?.streamCache.size ?? 0)
			:	[...this.runtimes.values()].reduce((total, state) => total + state.streamCache.size, this.defaultRuntime.streamCache.size);
		const pendingStreams =
			playerId ?
				(runtime?.pendingStreams.size ?? 0)
			:	[...this.runtimes.values()].reduce(
					(total, state) => total + state.pendingStreams.size,
					this.defaultRuntime.pendingStreams.size,
				);
		const searchPrefix = playerId ? `${playerId}:` : null;
		const searchCacheSize =
			searchPrefix ? [...this.searchCache.keys()].filter((key) => key.startsWith(searchPrefix)).length : this.searchCache.size;
		const pendingSearches =
			searchPrefix ?
				[...this.pendingSearches.keys()].filter((key) => key.startsWith(searchPrefix)).length
			:	this.pendingSearches.size;
		return {
			totalPlugins: this.getAll(playerId).length,
			pluginNames: this.getAll(playerId).map((plugin) => plugin.name),
			streamCacheSize,
			searchCacheSize,
			pendingStreams,
			pendingSearches,
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
