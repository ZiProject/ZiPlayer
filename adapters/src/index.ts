/**
 * @fileoverview Third-party plugin adapter system for ZiPlayer.
 *
 * Allows registering plugins/extractors from other ecosystems
 * (discord-player, distube, youtube-dl-exec, etc.) without rewriting them.
 *
 * @example
 * import { provide } from "@ziplayer/adapters";
 * import { YouTubePlugin } from "@ziplayer/plugin";
 * import { DefaultExtractors, SoundCloudExtractor } from "@discord-player/extractor";
 * import { SoundCloudPlugin } from "@distube/soundcloud";
 *
 * const manager = new PlayerManager({
 *   plugins: [
 *     provide(YouTubePlugin),                 // ZiPlayer plugin class
 *     provide(DefaultExtractors),           // discord-player bundle
 *     provide(SoundCloudExtractor),         // discord-player extractor class
 *     provide(new SoundCloudPlugin()),      // DisTube instance
 *   ],
 * });
 */

import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";
import * as https from "https";
import type { IncomingMessage } from "http";
const DEBUG = process.env.ZIPLAYER_ADAPTER_DEBUG === "true";

function debug(...args: any[]) {
	if (DEBUG) {
		console.debug("[ZiAdapter]", ...args);
	}
}
// ─────────────────────────────────────────────────────────────────────────────
// Types describing the foreign shapes we handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A discord-player v6/v7 extractor instance.
 * Methods require `context.type` (a QueryType string) resolved via QueryResolver.
 */
export interface DiscordPlayerExtractor {
	identifier?: string;
	protocols?: string[];
	context?: { player: unknown };

	activate?(): Promise<void>;
	deactivate?(): Promise<void>;

	/** validate(query, queryType) → boolean */
	validate?(query: string, type?: string): Promise<boolean> | boolean;

	/** handle(query, context) → { playlist, tracks: DPTrack[] } */
	handle?(
		query: string,
		context: {
			type: string;
			requestedBy: unknown;
			player: unknown;
			protocol: string | null;
		},
	): Promise<{ playlist: unknown; tracks: unknown[] } | null>;

	/** stream(dpTrack) → string URL | Readable */
	stream?(track: unknown): Promise<string | Readable>;

	emptyResponse?(): { playlist: null; tracks: [] };
}

/** discord-player QueryResolver (auto-imported if discord-player is installed) */
interface DPQueryResolver {
	resolve(query: string): { type: string; query: string };
}

/** discord-player QueryType map */
interface DPQueryType {
	AUTO_SEARCH: string;
	SOUNDCLOUD_SEARCH: string;
	YOUTUBE_SEARCH: string;
	[key: string]: string;
}

/** DisTube plugin shape (ExtractorPlugin, PlayableExtractorPlugin, InfoExtractorPlugin, …) */
export interface DistubePlugin {
	name?: string;
	type?: string;
	validate?(url: string, ctx?: unknown): Promise<boolean> | boolean;
	resolve?(
		url: string,
		opts?: unknown,
	): Promise<{
		name?: string;
		songs?: unknown[];
		url?: string;
		thumbnail?: string;
	}>;
	/** DisTube text-search hook (ExtractorPlugin.searchSong) */
	searchSong?(query: string, opts?: unknown): Promise<unknown | null>;
	getStreamURL?(song: unknown): Promise<string>;
}

/** Generic extractor (youtube-dl-exec, yt-dlp-wrap, custom, …) */
export interface GenericExtractor {
	name?: string;
	getInfo?(url: string): Promise<{
		title?: string;
		id?: string;
		url?: string;
		duration?: number;
		thumbnail?: string;
		formats?: Array<{ url: string; acodec?: string; vcodec?: string }>;
	}>;
	download?(url: string): Promise<Readable | string>;
}

export type ThirdPartyPlugin =
	| DiscordPlayerExtractor
	| DistubePlugin
	| GenericExtractor
	| BasePlugin
	| (new (...args: any[]) => unknown) // plugin / extractor constructor
	| ThirdPartyPlugin[];

// ─────────────────────────────────────────────────────────────────────────────
// discord-player lazy imports  (optional peer-dep)
// ─────────────────────────────────────────────────────────────────────────────

let _queryResolver: DPQueryResolver | null = null;
let _queryType: DPQueryType | null = null;

function getDPQueryResolver(): DPQueryResolver | null {
	if (_queryResolver) return _queryResolver;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const dp = require("discord-player") as {
			QueryResolver?: DPQueryResolver;
			QueryType?: DPQueryType;
		};
		_queryResolver = dp.QueryResolver ?? null;
		_queryType = dp.QueryType ?? null;
	} catch {
		/* discord-player not installed */
	}
	return _queryResolver;
}

function getDPQueryType(): DPQueryType | null {
	getDPQueryResolver();
	return _queryType;
}

/**
 * Resolve a raw query string to a discord-player QueryType + canonical query.
 * Falls back to AUTO_SEARCH when QueryResolver is unavailable.
 */
function dpResolve(query: string): { type: string; query: string } {
	const qr = getDPQueryResolver();

	if (qr) {
		try {
			const resolved = qr.resolve(query);

			debug("QueryResolver", {
				input: query,
				output: resolved,
			});

			return resolved;
		} catch (err) {
			debug("QueryResolver failed", err);
		}
	}

	const qt = getDPQueryType();

	const fallback = {
		type: qt?.AUTO_SEARCH ?? "autoSearch",
		query,
	};

	debug("QueryResolver fallback", fallback);

	return fallback;
}

/**
 * Map a resolved QueryType to the best search-specific type.
 * When the user types a plain text query, we must convert "auto"/"autoSearch"
 * into the extractor-specific search type (e.g. soundcloudSearch) so that
 * handle() actually runs a search rather than skipping silently.
 */
function mapToSearchType(resolvedType: string, extractor: DiscordPlayerExtractor): string {
	const qt = getDPQueryType();
	if (!qt) return resolvedType;

	// If already a specific type (URL-resolved), keep it.
	const autoTypes = new Set([qt.AUTO_SEARCH ?? "autoSearch", qt.AUTO ?? "auto"]);
	if (!autoTypes.has(resolvedType)) return resolvedType;

	// Infer preferred search type from extractor protocols
	const protocols: string[] = (extractor as any).protocols ?? [];
	for (const p of protocols) {
		if (p === "scsearch") return qt.SOUNDCLOUD_SEARCH ?? "soundcloudSearch";
		if (p === "ytsearch") return qt.YOUTUBE_SEARCH ?? "youtubeSearch";
		if (p === "spsearch") return "spotifySearch";
	}

	// Infer from identifier
	const id: string = (extractor as any).identifier ?? "";
	if (id.toLowerCase().includes("soundcloud")) return qt.SOUNDCLOUD_SEARCH ?? "soundcloudSearch";
	if (id.toLowerCase().includes("youtube")) return qt.YOUTUBE_SEARCH ?? "youtubeSearch";
	if (id.toLowerCase().includes("spotify")) return "spotifySearch";

	return resolvedType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers
// ─────────────────────────────────────────────────────────────────────────────

function isConstructor(fn: unknown): fn is new (...args: any[]) => any {
	return typeof fn === "function" && !!fn.prototype && (fn as any).prototype.constructor === fn;
}

function hasZiPlayerPluginShape(o: unknown): o is BasePlugin {
	return (
		typeof o === "object" &&
		o !== null &&
		typeof (o as any).canHandle === "function" &&
		typeof (o as any).search === "function" &&
		typeof (o as any).getStream === "function"
	);
}

function isZiPlayerPlugin(p: unknown): p is BasePlugin {
	return hasZiPlayerPluginShape(p);
}

function isZiPlayerPluginClass(p: unknown): p is new (...args: any[]) => BasePlugin {
	if (!isConstructor(p)) return false;
	return hasZiPlayerPluginShape((p as any).prototype);
}

function isDPExtractorCtor(p: unknown): p is new (...args: any[]) => DiscordPlayerExtractor {
	if (!isConstructor(p)) return false;
	const proto = (p as any).prototype;
	return (
		typeof proto.handle === "function" ||
		typeof proto.activate === "function" ||
		(typeof proto.stream === "function" && typeof proto.validate === "function")
	);
}

function isDistubePluginClass(p: unknown): p is new (...args: any[]) => DistubePlugin {
	if (!isConstructor(p)) return false;
	const proto = (p as any).prototype;
	return typeof proto.resolve === "function" || typeof proto.getStreamURL === "function" || typeof proto.searchSong === "function";
}

/** discord-player DefaultExtractors — array of extractor constructors */
function isDPExtractorCtorArray(p: unknown): p is Array<new (...args: any[]) => DiscordPlayerExtractor> {
	return Array.isArray(p) && p.length > 0 && p.every((item) => isDPExtractorCtor(item));
}

/** discord-player ExtractorExecutionContext-style container */
function isDPExtractorContainer(p: unknown): p is { extractors: Map<unknown, DiscordPlayerExtractor> | DiscordPlayerExtractor[] } {
	if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
	const extractors = (p as any).extractors;
	if (extractors instanceof Map) return extractors.size > 0;
	return Array.isArray(extractors) && extractors.length > 0;
}

function extractorsFromContainer(p: { extractors: Map<unknown, DiscordPlayerExtractor> | DiscordPlayerExtractor[] }): DiscordPlayerExtractor[] {
	const { extractors } = p;
	if (extractors instanceof Map) return [...extractors.values()];
	return extractors;
}

function isDPExtractor(p: unknown): p is DiscordPlayerExtractor {
	if (typeof p !== "object" || p === null) return false;
	const o = p as any;
	// validate alone is shared with DisTube — require discord-player-specific hooks
	return typeof o.handle === "function" || typeof o.activate === "function" || typeof o.stream === "function";
}

function isDistubePlugin(p: unknown): p is DistubePlugin {
	if (typeof p !== "object" || p === null) return false;
	const o = p as any;
	return typeof o.resolve === "function" || typeof o.getStreamURL === "function" || typeof o.searchSong === "function";
}

function isGenericExtractor(p: unknown): p is GenericExtractor {
	if (typeof p !== "object" || p === null) return false;
	const o = p as any;
	return typeof o.getInfo === "function" || typeof o.download === "function";
}

function isPlainPluginArray(p: unknown): p is ThirdPartyPlugin[] {
	return Array.isArray(p) && p.length > 0;
}

function instantiatePlugin<T>(Ctor: new (...args: any[]) => T, args: any[] = []): T {
	return new Ctor(...args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function isNodeReadable(raw: unknown): raw is Readable {
	return typeof raw === "object" && raw !== null && typeof (raw as Readable).pipe === "function";
}

function isHlsManifestUrl(url: string): boolean {
	const u = url.toLowerCase();
	return u.includes(".m3u8") || u.includes(".m3u") || u.includes("playlist.m3u");
}

function resolveFfmpegBinary(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const staticPath = require("ffmpeg-static") as string | null;
		if (staticPath) return staticPath;
	} catch {
		/* optional */
	}
	return "ffmpeg";
}

function fetchHttpResponse(url: string, redirectsLeft = 5): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const client = url.startsWith("https") ? https : http;
		const req = client.get(url, { headers: { "User-Agent": DEFAULT_UA } }, (res) => {
			const code = res.statusCode ?? 0;
			if ([301, 302, 307, 308].includes(code) && res.headers.location) {
				if (redirectsLeft <= 0) {
					res.resume();
					reject(new Error(`Too many redirects for ${url}`));
					return;
				}
				const next = new URL(res.headers.location, url).toString();
				res.resume();
				fetchHttpResponse(next, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			resolve(res);
		});
		req.on("error", reject);
	});
}

/** Convert a direct media URL → Node.js Readable stream (follows redirects). */
function urlToReadable(url: string): Readable {
	const readable = new Readable({ read() {} });
	fetchHttpResponse(url)
		.then((res) => {
			const code = res.statusCode ?? 0;
			if (code >= 400) {
				readable.destroy(new Error(`HTTP ${code} for ${url}`));
				res.resume();
				return;
			}
			res.on("data", (chunk: Buffer) => readable.push(chunk));
			res.on("end", () => readable.push(null));
			res.on("error", (e) => readable.destroy(e));
		})
		.catch((e) => readable.destroy(e));
	return readable;
}

function spawnFfmpegInput(input: string): Readable {
	const args = ["-hide_banner", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-i", input, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];
	const proc: ChildProcess = spawn(resolveFfmpegBinary(), args, { stdio: ["ignore", "pipe", "pipe"] });
	const stdout = proc.stdout;
	if (!stdout) {
		throw new Error("ffmpeg stdout unavailable — install ffmpeg or ffmpeg-static for HLS sources");
	}
	proc.stderr?.on("data", (chunk: Buffer) => debug("ffmpeg", chunk.toString().trim()));
	proc.on("error", (err) => stdout.destroy(err));
	stdout.on("close", () => {
		if (!proc.killed && proc.exitCode && proc.exitCode !== 0) {
			stdout.destroy(new Error(`ffmpeg exited with code ${proc.exitCode}`));
		}
	});
	return stdout;
}

/**
 * discord-player extractors often return an HLS manifest URL (e.g. SoundCloud).
 * Fetching that URL directly yields playlist text, not audio — resolve it properly.
 */
async function resolveStreamPayload(ext: DiscordPlayerExtractor | null, dpTrack: unknown, raw: unknown): Promise<Readable> {
	if (isNodeReadable(raw)) return raw;

	if (raw && typeof raw === "object" && typeof (raw as any).pipe === "function") {
		return raw as Readable;
	}

	if (typeof raw !== "string") {
		throw new Error("Unsupported stream payload from extractor");
	}

	if (!isHlsManifestUrl(raw)) {
		return urlToReadable(raw);
	}

	const track = dpTrack as { url?: string; permalink_url?: string } | undefined;
	const trackUrl = track?.url ?? track?.permalink_url;
	const util = (ext as any)?.internal?.util;

	if (util && trackUrl) {
		for (const method of ["streamTrack", "downloadTrackStream", "downloadTrack"] as const) {
			if (typeof util[method] !== "function") continue;
			try {
				const stream = await util[method](trackUrl);
				if (isNodeReadable(stream)) {
					debug("resolved HLS via extractor internal", method);
					return stream;
				}
			} catch (err) {
				debug(`extractor internal ${method} failed`, err);
			}
		}
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const dp = require("discord-player") as { createFFmpegStream?: (src: string, opts?: { type?: string }) => Promise<Readable> };
		if (typeof dp.createFFmpegStream === "function") {
			const stream = await dp.createFFmpegStream(raw, { type: "hls" });
			if (isNodeReadable(stream)) {
				debug("resolved HLS via discord-player createFFmpegStream");
				return stream;
			}
		}
	} catch (err) {
		debug("createFFmpegStream failed", err);
	}

	debug("resolved HLS via ffmpeg spawn");
	return spawnFfmpegInput(raw);
}

async function toReadable(raw: unknown, ext?: DiscordPlayerExtractor | null, dpTrack?: unknown): Promise<Readable> {
	if (ext || dpTrack) {
		return resolveStreamPayload(ext ?? null, dpTrack, raw);
	}
	if (isNodeReadable(raw)) return raw;
	if (typeof raw === "string") return urlToReadable(raw);
	throw new Error("Unsupported stream payload");
}

/**
 * Normalise a discord-player Track object (which may have a string `duration`
 * like "03:45") into a ZiPlayer Track.
 */
function dpTrackToZiTrack(raw: any, requestedBy: string, sourceName: string): Track {
	let durationMs = 0;
	if (typeof raw.durationMS === "number") {
		durationMs = raw.durationMS;
	} else if (typeof raw.duration === "number") {
		// Some extractors expose duration in ms already
		durationMs = raw.duration > 10_000 ? raw.duration : raw.duration * 1000;
	} else if (typeof raw.duration === "string") {
		// Parse "MM:SS" or "HH:MM:SS"
		const parts = raw.duration.split(":").map(Number);
		if (parts.length === 2) durationMs = (parts[0] * 60 + parts[1]) * 1000;
		else if (parts.length === 3) durationMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
	}

	return {
		id: String(raw.id ?? raw.url ?? Date.now()),
		title: String(raw.title ?? raw.name ?? "Unknown"),
		url: String(raw.url ?? ""),
		duration: durationMs,
		thumbnail: raw.thumbnail ?? raw.artwork ?? undefined,
		requestedBy,
		source: sourceName,
		author: raw.author ?? undefined,
		metadata: { _dpTrack: raw },
	};
}

function buildGenericTrack(raw: any, requestedBy: string, sourceName: string): Track {
	let durationMs = 0;
	if (typeof raw?.durationMS === "number") {
		durationMs = raw.durationMS;
	} else if (typeof raw?.duration === "number") {
		durationMs = raw.duration > 10_000 ? raw.duration : raw.duration * 1000;
	}

	return {
		id: String(raw?.id ?? raw?.url ?? Date.now()),
		title: String(raw?.title ?? raw?.name ?? "Unknown"),
		url: String(raw?.url ?? raw?.webpage_url ?? ""),
		duration: durationMs,
		thumbnail: raw?.thumbnail ?? raw?.artwork_url ?? raw?.thumbnailURL ?? undefined,
		requestedBy,
		source: sourceName,
		author: raw?.uploader ?? raw?.author ?? undefined,
		metadata: { original: raw },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// DiscordPlayerExtractorAdapter — single extractor instance
// ─────────────────────────────────────────────────────────────────────────────

export class DiscordPlayerExtractorAdapter extends BasePlugin {
	readonly version = "adapter-1.0.0";
	priority = 5;

	private activated = false;
	private readonly _name: string;

	get name(): string {
		return this._name;
	}

	constructor(
		private readonly ext: DiscordPlayerExtractor,
		nameOverride?: string,
	) {
		super();
		this._name = nameOverride ?? ext.identifier ?? "discord-player-ext";
	}

	ownsDpTrack(dpTrack: unknown): boolean {
		if (!dpTrack || typeof dpTrack !== "object") return false;
		const extractor = (dpTrack as any).extractor;
		return extractor === this.ext || extractor?.identifier === this._name;
	}

	/** Call activate() once before the first search/stream. */
	private async ensureActivated(): Promise<void> {
		if (this.activated) return;

		debug(`[${this._name}] activating extractor`);

		if (!(this.ext as any).context) {
			(this.ext as any).context = { player: {} };
		}

		if (typeof this.ext.activate === "function") {
			await this.ext.activate();
		}

		this.activated = true;

		debug(`[${this._name}] activated`);
	}

	canHandle(query: string): boolean {
		// Cheap sync check: if extractor has protocols, check url prefix
		const protocols: string[] = (this.ext as any).protocols ?? [];
		if (protocols.length > 0) {
			const q = query.toLowerCase();
			for (const p of protocols) {
				if (q.startsWith(p + ":") || q.includes(p)) return true;
			}
		}
		// If extractor exposes an identifier we can use as a rough URL hint
		const id: string = (this.ext as any).identifier ?? "";
		if (id) {
			const domain = id.split(".").slice(-2).join("."); // e.g. "soundcloud.com"
			if (query.toLowerCase().includes(domain)) return true;
		}
		// Optimistically allow non-URL text queries (validate() will gate at search time)
		const isUrl = query.startsWith("http://") || query.startsWith("https://");
		return !isUrl;
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (typeof this.ext.handle !== "function") return { tracks: [] };
		debug(`[${this._name}] search start`, {
			query,
			requestedBy,
		});
		await this.ensureActivated();

		const { type: rawType, query: resolvedQuery } = dpResolve(query);
		debug(`[${this._name}] resolved query`, {
			rawType,
			resolvedQuery,
		});
		const type = mapToSearchType(rawType, this.ext);

		// Gate with validate() if available
		if (typeof this.ext.validate === "function") {
			const valid = await Promise.resolve(this.ext.validate(resolvedQuery, type)).catch(() => false);
			debug(`[${this._name}] validate`, {
				query: resolvedQuery,
				type,
				valid,
			});
			if (!valid) return { tracks: [] };
		}
		debug(`[${this._name}] calling handle()`);
		const result = await this.ext
			.handle(resolvedQuery, {
				type,
				requestedBy,
				player: (this.ext as any).context?.player ?? {},
				protocol: null,
			})
			.catch(() => null);
		debug(`[${this._name}] handle result`, {
			playlist: !!result?.playlist,
			tracks: result?.tracks?.length ?? 0,
		});
		if (!result) return { tracks: [] };

		const tracks = (result.tracks ?? []).map((raw: any) => dpTrackToZiTrack(raw, requestedBy, this._name));
		debug(
			`[${this._name}] converted tracks`,
			tracks.map((t) => ({
				title: t.title,
				url: t.url,
				duration: t.duration,
			})),
		);
		if (result.playlist && typeof result.playlist === "object") {
			const pl = result.playlist as any;
			return {
				tracks,
				playlist: { name: String(pl.title ?? pl.name ?? "Playlist"), url: pl.url },
			};
		}

		return { tracks };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		if (typeof this.ext.stream !== "function") {
			throw new Error(`${this._name}: no stream() method`);
		}

		await this.ensureActivated();

		// Pass the original dp Track if we saved it; otherwise pass ZiPlayer track
		const dpTrack = track.metadata?._dpTrack ?? track;
		const raw = await this.ext.stream(dpTrack);

		if (!raw) throw new Error(`${this._name}: stream() returned null for "${track.title}"`);

		return { stream: await toReadable(raw, this.ext, dpTrack), type: "arbitrary" };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DiscordPlayerContainerAdapter — DefaultExtractors (array of constructors)
// ─────────────────────────────────────────────────────────────────────────────

export class DiscordPlayerContainerAdapter extends BasePlugin {
	readonly name = "discord-player-container";
	readonly version = "adapter-1.0.0";
	priority = 5;

	private readonly adapters: DiscordPlayerExtractorAdapter[];

	constructor(source: Array<new (...args: any[]) => DiscordPlayerExtractor> | DiscordPlayerExtractor[]) {
		super();
		this.adapters = source
			.filter(Boolean)
			.map((item) => {
				if (typeof item === "function") {
					return new DiscordPlayerExtractorAdapter(instantiatePlugin(item as new (...args: any[]) => DiscordPlayerExtractor));
				}
				return new DiscordPlayerExtractorAdapter(item);
			});
	}

	canHandle(query: string): boolean {
		return this.adapters.some((a) => a.canHandle(query));
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		debug("[Container] search", query);
		// Try each extractor in priority order, return first non-empty result
		for (const adapter of this.adapters) {
			if (!adapter.canHandle(query)) continue;
			try {
				debug("[Container] trying", adapter.name);
				const result = await adapter.search(query, requestedBy);
				if (result.tracks.length > 0) return result;
			} catch {
				/* try next */
			}
		}
		return { tracks: [] };
	}

	private resolveAdapterForTrack(track: Track): DiscordPlayerExtractorAdapter[] {
		const dpTrack = track.metadata?._dpTrack;
		const byDp = this.adapters.filter((a) => a.ownsDpTrack(dpTrack));
		if (byDp.length > 0) return byDp;

		if (track.source && track.source !== this.name) {
			const bySource = this.adapters.filter((a) => a.name === track.source);
			if (bySource.length > 0) return bySource;
		}

		return this.adapters;
	}

	async getStream(track: Track): Promise<StreamInfo> {
		const candidates = this.resolveAdapterForTrack(track);

		for (const adapter of candidates) {
			try {
				debug("[Container] streaming via", adapter.name);
				return await adapter.getStream(track);
			} catch (err) {
				debug("[Container] stream failed for", adapter.name, err);
			}
		}
		throw new Error(`discord-player-container: no adapter could stream "${track.title}"`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DistubePluginAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class DistubePluginAdapter extends BasePlugin {
	readonly version = "adapter-1.0.0";
	priority = 5;

	private readonly _name: string;
	get name(): string {
		return this._name;
	}

	constructor(private readonly plugin: DistubePlugin) {
		super();
		this._name = plugin.name ?? "distube-plugin";
	}

	canHandle(query: string): boolean {
		const isUrl = query.startsWith("http://") || query.startsWith("https://");
		if (isUrl && typeof this.plugin.validate === "function") {
			try {
				const r = this.plugin.validate(query);
				if (r instanceof Promise) return true;
				return Boolean(r);
			} catch {
				return false;
			}
		}
		return typeof this.plugin.searchSong === "function" || typeof this.plugin.resolve === "function";
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		const isUrl = query.startsWith("http://") || query.startsWith("https://");

		if (!isUrl && typeof this.plugin.searchSong === "function") {
			const song = await this.plugin.searchSong(query).catch(() => null);
			if (song) {
				return { tracks: [buildGenericTrack(song, requestedBy, this._name)] };
			}
		}

		if (typeof this.plugin.resolve !== "function") return { tracks: [] };

		if (isUrl && typeof this.plugin.validate === "function") {
			const valid = await Promise.resolve(this.plugin.validate(query)).catch(() => false);
			if (!valid) return { tracks: [] };
		}

		const resolved = await this.plugin.resolve(query, {}).catch(() => null);
		if (!resolved) return { tracks: [] };

		if (resolved.songs && resolved.songs.length > 0) {
			const tracks = resolved.songs.map((s: any) => buildGenericTrack(s, requestedBy, this._name));
			return {
				tracks,
				playlist: {
					name: resolved.name ?? "Playlist",
					url: resolved.url,
					thumbnail: resolved.thumbnail,
				},
			};
		}

		return { tracks: [buildGenericTrack(resolved, requestedBy, this._name)] };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		if (typeof this.plugin.getStreamURL !== "function") {
			throw new Error(`${this._name}: no getStreamURL() method`);
		}
		const url = await this.plugin.getStreamURL(track.metadata?.original ?? track);
		return { stream: await toReadable(url), type: "arbitrary" };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GenericExtractorAdapter — youtube-dl-exec, yt-dlp-wrap, custom, …
// ─────────────────────────────────────────────────────────────────────────────

export class GenericExtractorAdapter extends BasePlugin {
	readonly version = "adapter-1.0.0";
	priority = 1;

	private readonly _name: string;
	get name(): string {
		return this._name;
	}

	constructor(
		private readonly ext: GenericExtractor,
		nameOverride?: string,
	) {
		super();
		this._name = nameOverride ?? ext.name ?? "generic-extractor";
	}

	canHandle(_query: string): boolean {
		return typeof this.ext.getInfo === "function" || typeof this.ext.download === "function";
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (typeof this.ext.getInfo !== "function") return { tracks: [] };
		const info = await this.ext.getInfo(query).catch(() => null);
		if (!info) return { tracks: [] };

		const track: Track = {
			id: String(info.id ?? info.url ?? Date.now()),
			title: String(info.title ?? "Unknown"),
			url: String(info.url ?? query),
			duration: Number(info.duration ?? 0) * 1000,
			thumbnail: info.thumbnail,
			requestedBy,
			source: this._name,
			metadata: { original: info },
		};
		return { tracks: [track] };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		const original = track.metadata?.original;

		// Use pre-resolved format URLs when available (youtube-dl-exec style)
		if (original?.formats) {
			const audioOnly = (original.formats as any[]).filter(
				(f: any) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"),
			);
			const best = audioOnly.at(-1) ?? (original.formats as any[]).at(-1);
			if (best?.url) return { stream: await toReadable(best.url), type: "arbitrary" };
		}

		if (typeof this.ext.download === "function") {
			const raw = await this.ext.download(track.url);
			return { stream: await toReadable(raw), type: "arbitrary" };
		}

		throw new Error(`${this._name}: cannot stream "${track.title}"`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiAdapter — wraps an array of BasePlugin instances
// ─────────────────────────────────────────────────────────────────────────────

export class MultiAdapter extends BasePlugin {
	readonly name = "multi-adapter";
	readonly version = "adapter-1.0.0";
	priority = 5;

	constructor(private readonly adapters: BasePlugin[]) {
		super();
	}

	canHandle(query: string): boolean {
		return this.adapters.some((a) => a.canHandle(query));
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		const results = await Promise.allSettled(
			this.adapters.filter((a) => a.canHandle(query)).map((a) => a.search(query, requestedBy)),
		);
		for (const r of results) {
			if (r.status === "fulfilled" && r.value.tracks.length > 0) return r.value;
		}
		return { tracks: [] };
	}

	async getStream(track: Track): Promise<StreamInfo> {
		for (const adapter of this.adapters) {
			try {
				return await adapter.getStream(track);
			} catch {
				/* try next */
			}
		}
		throw new Error(`multi-adapter: no plugin could stream "${track.title}"`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// provide() — the single public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvideOptions {
	/**
	 * Override ZiPlayer plugin priority (higher = tried first in fallback chain).
	 * Defaults: ZiPlayer native → unchanged, all adapters → 5, generic → 1.
	 */
	priority?: number;
	/** Override the name used to identify this plugin inside ZiPlayer. */
	name?: string;
}

/**
 * Wraps any third-party plugin/extractor so it can be passed to `PlayerManager`.
 *
 * Auto-detects the plugin type in this order:
 *   1. Array of constructors (`DefaultExtractors`) → DiscordPlayerContainerAdapter
 *   2. Mixed array of instances/constructors       → each item wrapped, then MultiAdapter
 *   3. ZiPlayer `BasePlugin`                       → pass-through
 *   4. discord-player extractor instance           → DiscordPlayerExtractorAdapter
 *   5. DisTube plugin                              → DistubePluginAdapter
 *   6. Generic extractor (getInfo/download)        → GenericExtractorAdapter
 *
 * @example
 * import { provide } from "@ziplayer/adapters";
 * import { DefaultExtractors, SoundCloudExtractor } from "@discord-player/extractor";
 *
 * new PlayerManager({
 *   plugins: [
 *     provide(DefaultExtractors),             // array of ctors
 *     provide(new SoundCloudExtractor()),     // single instance
 *     provide(new SoundCloudPlugin()),        // DisTube
 *     provide({ name:"ydl", getInfo, download }), // generic
 *   ],
 * });
 */
function wrapThirdPartyPlugin(plugin: ThirdPartyPlugin, options?: ProvideOptions): BasePlugin {
	let adapted: BasePlugin;
	debug("provide()", "plugin:", (plugin as any)?.constructor?.name ?? typeof plugin, "options:", options);

	// ── discord-player DefaultExtractors (array of constructors) ───────────────
	if (isDPExtractorCtorArray(plugin)) {
		debug("Detected DiscordPlayerContainerAdapter (constructors)");
		adapted = new DiscordPlayerContainerAdapter(plugin);
	}
	// ── Mixed / instance array ─────────────────────────────────────────────────
	else if (isPlainPluginArray(plugin)) {
		debug("Detected MultiAdapter", "count:", plugin.length);
		const wrapped = plugin.map((p) => wrapThirdPartyPlugin(p, options));
		adapted = wrapped.length === 1 ? wrapped[0] : new MultiAdapter(wrapped);
	}
	// ── Plugin / extractor constructor (class) ─────────────────────────────────
	else if (isZiPlayerPluginClass(plugin)) {
		debug("Detected ZiPlayer Plugin class", (plugin as any).name);
		adapted = wrapThirdPartyPlugin(instantiatePlugin(plugin), options);
	} else if (isDistubePluginClass(plugin)) {
		debug("Detected DisTube Plugin class", (plugin as any).name);
		adapted = new DistubePluginAdapter(instantiatePlugin(plugin));
	} else if (isDPExtractorCtor(plugin)) {
		debug("Detected discord-player extractor class", (plugin as any).name);
		adapted = new DiscordPlayerExtractorAdapter(instantiatePlugin(plugin), options?.name);
	} else if (isConstructor(plugin)) {
		debug("Detected generic constructor, instantiating", (plugin as any).name);
		adapted = wrapThirdPartyPlugin(instantiatePlugin(plugin) as ThirdPartyPlugin, options);
	}
	// ── discord-player extractor container (.extractors Map) ───────────────────
	else if (isDPExtractorContainer(plugin)) {
		debug("Detected DiscordPlayerContainerAdapter (container)");
		adapted = new DiscordPlayerContainerAdapter(extractorsFromContainer(plugin));
	}
	// ── Already a ZiPlayer plugin instance ─────────────────────────────────────
	else if (isZiPlayerPlugin(plugin)) {
		debug("Detected ZiPlayer Plugin", (plugin as any).name);
		adapted = plugin as BasePlugin;
	}
	// ── DisTube plugin instance (before discord-player — both may have validate) ─
	else if (isDistubePlugin(plugin)) {
		debug("Detected DisTube Plugin", (plugin as any).name);
		adapted = new DistubePluginAdapter(plugin as DistubePlugin);
	}
	// ── discord-player extractor instance ──────────────────────────────────────
	else if (isDPExtractor(plugin)) {
		debug("Detected DiscordPlayerExtractor", (plugin as any).identifier);
		adapted = new DiscordPlayerExtractorAdapter(plugin as DiscordPlayerExtractor, options?.name);
	}
	// ── Generic extractor object ─────────────────────────────────────────────────
	else if (isGenericExtractor(plugin)) {
		debug("Detected Generic Extractor", (plugin as any).name);
		adapted = new GenericExtractorAdapter(plugin as GenericExtractor, options?.name);
	} else {
		throw new Error(
			`provide(): unrecognised plugin type "${(plugin as any)?.constructor?.name ?? typeof plugin}". ` +
				`Accepted: ZiPlayer BasePlugin (instance or class), discord-player extractor/container/DefaultExtractors, ` +
				`DisTube plugin (resolve/searchSong/getStreamURL), generic extractor (getInfo/download), or an array.`,
		);
	}

	if (options?.priority !== undefined) adapted.priority = options.priority;
	if (options?.name !== undefined && !isZiPlayerPlugin(plugin) && !isZiPlayerPluginClass(plugin)) {
		(adapted as any)._name = options.name;
	}

	return adapted;
}

export function provide(plugin: ThirdPartyPlugin, options?: ProvideOptions): BasePlugin {
	return wrapThirdPartyPlugin(plugin, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export { BasePlugin } from "ziplayer";
