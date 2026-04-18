import { BasePlugin } from "./BasePlugin";
import { withTimeout } from "../utils/timeout";
import type { Track, StreamInfo } from "../types";
import type { PlayerManager } from "../structures/PlayerManager";
import type { Player } from "../structures/Player";

type PluginManagerOptions = {
	extractorTimeout: number | undefined;
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

	return 1 - dist / maxLen; // 0 → 1
}

function normalize(str: string): string {
	return str
		.toLowerCase()
		.replace(/\(.*?\)|\[.*?\]/g, "") // remove (remix), [lyrics]
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const MUSIC_KEYWORDS = ["official", "mv", "audio", "lyrics", "remix", "cover", "ft", "feat", "prod", "music video"];

const NON_MUSIC_KEYWORDS = ["reaction", "review", "podcast", "interview", "vlog", "live stream", "news", "tiktok"];

function detectContentType(title: string): number {
	const t = title.toLowerCase();

	let score = 0;

	for (const k of MUSIC_KEYWORDS) {
		if (t.includes(k)) score += 2;
	}

	for (const k of NON_MUSIC_KEYWORDS) {
		if (t.includes(k)) score -= 3;
	}

	return score;
}

function tokenOverlap(a: string, b: string): number {
	const setA = new Set(a.split(" "));
	const setB = new Set(b.split(" "));

	let match = 0;
	for (const word of setA) {
		if (setB.has(word)) match++;
	}

	return match / Math.max(setA.size, setB.size);
}

function scoreTrack(base: Track, candidate: Track): number {
	const titleA = normalize(base.title);
	const titleB = normalize(candidate.title);

	let score = 0;

	// ===== FUZZY =====
	const sim = similarity(titleA, titleB); // 0 → 1
	score += sim * 50;

	// ===== TOKEN MATCH =====
	score += tokenOverlap(titleA, titleB) * 30;

	// ===== CONTENT TYPE =====
	score += detectContentType(candidate.title);

	return score;
}

// Plugin factory
export class PluginManager {
	private options: PluginManagerOptions;
	private player: Player;
	private manager: PlayerManager;
	private plugins: Map<string, BasePlugin> = new Map();

	constructor(player: Player, manager: PlayerManager, options: PluginManagerOptions) {
		this.player = player;
		this.manager = manager;
		this.options = options;
	}

	debug(message?: any, ...optionalParams: any[]): void {
		if (this.manager.debugEnabled) {
			this.manager.emit("debug", `[Plugins] ${message}`, ...optionalParams);
		}
	}

	register(plugin: BasePlugin): void {
		this.plugins.set(plugin.name, plugin);
	}

	unregister(name: string): boolean {
		return this.plugins.delete(name);
	}

	get(name: string): BasePlugin | undefined {
		return this.plugins.get(name);
	}

	getAll(): BasePlugin[] {
		return Array.from(this.plugins.values());
	}

	findPlugin(query: string): BasePlugin | undefined {
		return this.getAll().find((plugin) => plugin.canHandle(query));
	}

	clear(): void {
		this.plugins.clear();
	}

	async getStream(track: Track): Promise<StreamInfo | null> {
		const timeoutMs = this.options.extractorTimeout ?? 50000;
		const primary = this.get(track.source) || this.findPlugin(track.url);
		if (!primary) {
			this.debug(`No plugin found for track: ${track.title}`);
			return null;
		}
		try {
			const controller = new AbortController();
			const result = await withTimeout(primary.getStream(track, controller.signal), timeoutMs, "Primary timeout");
			if (result?.stream) return result;
			throw new Error("Primary failed");
		} catch {
			this.debug("Primary failed → fallback parallel");
		}

		// ===== FALLBACK PARALLEL =====
		const plugins = this.getAll()
			.filter((p) => p !== primary)
			.map((p) => {
				p.priority ??= 0;
				return p;
			})
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

		// group by priority
		const groups = new Map<number, BasePlugin[]>();
		for (const p of plugins) {
			if (!groups.has(p.priority ?? 0)) groups.set(p.priority ?? 0, []);
			groups.get(p.priority ?? 0)!.push(p);
		}
		for (const [priority, group] of groups) {
			this.debug(`Running group priority=${priority}`);
			const controller = new AbortController();
			try {
				const promises = group.map((p) => {
					const run = async () => {
						try {
							let result: StreamInfo | null = null;

							if (p.getStream) {
								try {
									result = await withTimeout(p.getStream(track, controller.signal), timeoutMs, `Timeout ${p.name}`);
								} catch (err) {
									// getStream thất bại → log rồi thử getFallback
									this.debug(`getStream failed for ${p.name}, trying getFallback`, err);
								}

								if (result?.stream) {
									this.debug(`Success via ${p.name}`);
									controller.abort();
									return result;
								}
							}

							if (p.getFallback) {
								result = await withTimeout(p.getFallback(track, controller.signal), timeoutMs, `Fallback timeout ${p.name}`);
								if (result?.stream) {
									this.debug(`Fallback via ${p.name}`);
									controller.abort();
									return result;
								}
							}

							throw new Error("No stream");
						} catch (err) {
							if (controller.signal.aborted) throw new Error("Aborted");
							this.debug(`Failed ${p.name}`, err);
							throw err;
						}
					};
					return run();
				});

				const result = await Promise.any(promises);
				if (result?.stream) return result;
			} catch {
				this.debug(`Priority group ${priority} failed`);
				controller.abort();
			}
		}

		throw new Error(`All plugins failed for track: ${track.title}`);
	}

	/**
	 * Get related tracks for a given track
	 * @param {Track} track Track to find related tracks for
	 * @returns {Track[]} Related tracks or empty array
	 * @example
	 * const related = await player.getRelatedTracks(track);
	 * console.log(`Found ${related.length} related tracks`);
	 */
	async getRelatedTracks(track: Track): Promise<Track[]> {
		if (!track) return [];

		const timeoutMs = this.options.extractorTimeout ?? 15000;
		const limit = 20;

		const allPlugins = this.getAll()
			.filter((p) => typeof p.getRelatedTracks === "function")
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

		const history = this.player.queue.previousTracks;

		const results: Track[] = [];

		// ===== TRY ALL PLUGINS (NOT JUST FIRST SUCCESS) =====
		await Promise.allSettled(
			allPlugins.map(async (p) => {
				try {
					this.debug(`[RelatedTracks] Querying ${p.name}`);

					const related = await withTimeout(p.getRelatedTracks!(track, { limit, history }), timeoutMs, `Timeout ${p.name}`);

					if (Array.isArray(related)) {
						results.push(...related);
					}
				} catch (err) {
					this.debug(`[RelatedTracks] ${p.name} failed`, err);
				}
			}),
		);

		if (results.length === 0) {
			this.debug(`[RelatedTracks] No results`);
			return [];
		}

		// ===== DEDUPE =====
		const unique = new Map<string, Track>();
		for (const t of results) {
			if (!unique.has(t.url)) {
				unique.set(t.url, t);
			}
		}

		// ===== SCORE + SORT =====
		const ranked = Array.from(unique.values())
			.map((t) => ({ track: t, score: scoreTrack(track, t) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((x) => x.track);

		this.debug(`[RelatedTracks] Final ${ranked.length} tracks`);
		return ranked;
	}
}
