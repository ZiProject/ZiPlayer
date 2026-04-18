import { Readable } from "node:stream";
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

// ─── Constants ────────────────────────────────────────────────────────────────

//─── src ────────────────────────────────────────────────────────────────
// https://github.com/SASCYT9/infinity-downloader
//────────────────────────────────────────────────────────────────────────

const FALLBACK_INSTANCES: string[] = [
	"https://lime.clxxped.lol",
	"https://cobaltapi.squair.xyz",
	"https://nuko-c.meowing.de",
	"https://api.cobalt.liubquanti.click",
	"https://cobaltapi.kittycat.boo",
	"https://fox.kittycat.boo",
	"https://dog.kittycat.boo",
	"https://melon.clxxped.lol",
	"https://grapefruit.clxxped.lol",
	"https://api.dl.woof.monster",
	"https://api.qwkuns.me",
	"https://cobaltapi.cjs.nz",
	"https://subito-c.meowing.de",
	"https://cobalt.alpha.wolfy.love",
	"https://api.cobalt.blackcat.sweeux.org",
	"https://cobalt.omega.wolfy.love",
];

const OFFICIAL_INSTANCES: string[] = [
	"https://kityune.imput.net",
	"https://blossom.imput.net",
	"https://nachos.imput.net",
	"https://sunny.imput.net",
];

const INSTANCE_ERRORS = new Set([
	"error.api.auth",
	"error.api.rate_limit",
	"error.api.capacity",
	"error.api.generic",
	"error.api.youtube.login",
	"error.api.youtube.age",
	"error.api.youtube.decipher",
]);

const CONTENT_ERRORS = new Set(["error.api.link", "error.api.content"]);

const SUPPORTED_HOSTS: readonly string[] = [
	// Video
	"youtube.com",
	"youtu.be",
	"music.youtube.com",
	"tiktok.com",
	"vm.tiktok.com",
	"instagram.com",
	"instagr.am",
	"twitter.com",
	"x.com",
	"t.co",
	"reddit.com",
	"redd.it",
	"v.redd.it",
	"twitch.tv",
	"clips.twitch.tv",
	"vimeo.com",
	"dailymotion.com",
	"dai.ly",
	"bilibili.com",
	"bilibili.tv",
	"b23.tv",
	"nicovideo.jp",
	"nico.ms",
	"ok.ru",
	"odnoklassniki.ru",
	"rutube.ru",
	"streamable.com",
	"pinterest.com",
	"pin.it",
	"tumblr.com",
	"facebook.com",
	"fb.watch",
	"fb.com",
	"snapchat.com",
	"tenor.com",
	"giphy.com",
	// Audio
	"soundcloud.com",
	"on.soundcloud.com",
	"bandcamp.com",
] as const;

// ─── Metadata resolution ──────────────────────────────────────────────────────

interface MediaMeta {
	title: string;
	thumbnail?: string;
	author?: string;
}

/**
 * Maps a normalised hostname (no `www.`) to a function that returns the
 * appropriate oEmbed endpoint URL.  oEmbed is free, requires no API key, and
 * returns `title` + `thumbnail_url` + `author_name` for most platforms.
 */
const OEMBED_ENDPOINTS: Record<string, (url: string) => string> = {
	"youtube.com": (u) => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`,
	"youtu.be": (u) => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`,
	"music.youtube.com": (u) => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`,
	"vimeo.com": (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`,
	"soundcloud.com": (u) => `https://soundcloud.com/oembed?url=${encodeURIComponent(u)}&format=json`,
	"on.soundcloud.com": (u) => `https://soundcloud.com/oembed?url=${encodeURIComponent(u)}&format=json`,
	"tiktok.com": (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
	"vm.tiktok.com": (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
	"twitter.com": (u) => `https://publish.twitter.com/oembed?url=${encodeURIComponent(u)}`,
	"x.com": (u) => `https://publish.twitter.com/oembed?url=${encodeURIComponent(u)}`,
	"reddit.com": (u) => `https://www.reddit.com/oembed?url=${encodeURIComponent(u)}`,
	"dailymotion.com": (u) => `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(u)}&format=json`,
	"dai.ly": (u) => `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(u)}&format=json`,
	"streamable.com": (u) => `https://api.streamable.com/oembed.json?url=${encodeURIComponent(u)}`,
	"tumblr.com": (u) => `https://www.tumblr.com/oembed/1.0?url=${encodeURIComponent(u)}`,
};

/**
 * Try the oEmbed endpoint for the given URL's platform.
 * Returns `null` if the platform has no registered endpoint or the call fails.
 */
async function fetchOEmbed(rawUrl: string): Promise<MediaMeta | null> {
	try {
		const parsed = new URL(rawUrl);
		const host = parsed.hostname.replace(/^www\./, "");
		const endpointFn = OEMBED_ENDPOINTS[host];
		if (!endpointFn) return null;

		const res = await fetch(endpointFn(rawUrl), {
			headers: { "User-Agent": "ZiPlayer/1.0 (oEmbed)" },
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) return null;

		const json = (await res.json()) as {
			title?: string;
			thumbnail_url?: string;
			author_name?: string;
		};

		if (!json.title) return null;

		return {
			title: json.title,
			thumbnail: json.thumbnail_url,
			author: json.author_name,
		};
	} catch {
		return null;
	}
}

/**
 * Scrape `og:title` and `og:image` from a page's `<head>`.
 * We only download the first 20 KB to keep this cheap — enough for the `<head>`.
 */
async function fetchOpenGraph(rawUrl: string): Promise<MediaMeta | null> {
	try {
		const res = await fetch(rawUrl, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; ZiPlayer/1.0; +https://github.com/ZiProject/ZiPlayer)",
				Accept: "text/html",
				Range: "bytes=0-20479", // first 20 KB
			},
			signal: AbortSignal.timeout(6_000),
		});

		if (!res.ok) return null;

		const html = await res.text();

		const extract = (prop: string): string | undefined => {
			// Match both og:X and twitter:X variants
			const patterns = [
				new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
				new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"),
			];
			for (const re of patterns) {
				const m = html.match(re);
				if (m?.[1]) return m[1].trim();
			}
			return undefined;
		};

		const title = extract("og:title") ?? extract("twitter:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

		if (!title) return null;

		return {
			title,
			thumbnail: extract("og:image") ?? extract("twitter:image"),
		};
	} catch {
		return null;
	}
}

/**
 * Resolve human-readable metadata for any supported URL.
 * Strategy: oEmbed (fast, structured) → Open Graph scrape (universal fallback).
 * Never throws — always returns at least a minimal object derived from the URL.
 */
async function fetchMetadata(rawUrl: string): Promise<MediaMeta> {
	// 1. oEmbed — preferred: fast, no HTML parsing, returns clean title + thumbnail
	const oembed = await fetchOEmbed(rawUrl);
	if (oembed) return oembed;

	// 2. Open Graph — works for platforms without an oEmbed endpoint
	const og = await fetchOpenGraph(rawUrl);
	if (og) return og;

	// 3. Last resort — synthesise something readable from the URL itself
	const parsed = new URL(rawUrl);
	const host = parsed.hostname.replace(/^www\./, "");
	const slug = parsed.pathname.split("/").filter(Boolean).pop() ?? "media";
	return { title: `${host} – ${slug}` };
}

// ─── Cobalt API types ─────────────────────────────────────────────────────────

interface CobaltRequest {
	url: string;
	videoQuality?: string;
	audioFormat?: string;
	audioBitrate?: string;
	filenameStyle?: string;
	downloadMode?: "auto" | "audio" | "mute";
	youtubeVideoCodec?: "h264" | "av1" | "vp9";
}

interface CobaltSuccess {
	status: "redirect" | "tunnel" | "picker";
	url?: string;
	urls?: string[];
	filename?: string;
	audio?: string;
	picker?: { type: string; url: string; thumb?: string }[];
}

interface CobaltError {
	status: "error";
	error: { code: string; message?: string };
}

type CobaltResponse = CobaltSuccess | CobaltError;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCobaltError(res: CobaltResponse): res is CobaltError {
	return res.status === "error";
}

function isInstanceError(code: string): boolean {
	return INSTANCE_ERRORS.has(code) || [...INSTANCE_ERRORS].some((e) => code.startsWith(e));
}

function isContentError(code: string): boolean {
	return CONTENT_ERRORS.has(code) || [...CONTENT_ERRORS].some((e) => code.startsWith(e));
}

async function fetchInstances(): Promise<string[]> {
	try {
		const res = await fetch("https://cobalt.directory/api/working?type=api", {
			signal: AbortSignal.timeout(4_000),
		});
		const json = (await res.json()) as { data?: Record<string, string[]> };
		const platformData = json?.data ?? {};

		const all = new Set<string>();
		for (const urls of Object.values(platformData)) {
			if (Array.isArray(urls)) {
				for (const url of urls) all.add(url.replace(/\/$/, ""));
			}
		}

		const community = [...all].filter((url) => !OFFICIAL_INSTANCES.some((off) => url.startsWith(off.replace(/\/$/, ""))));

		if (community.length > 0) return community;
		if (all.size > 0) return [...all];
	} catch {
		// Network error or parse failure — use hardcoded fallback
	}
	return FALLBACK_INSTANCES;
}

/** POST to a single cobalt instance with a 15 s timeout. */
async function tryCobaltInstance(baseUrl: string, body: CobaltRequest): Promise<CobaltResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("application/json")) {
			throw new Error(`Non-JSON response (HTTP ${res.status})`);
		}

		return (await res.json()) as CobaltResponse;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Validate that a tunnel URL actually streams bytes.
 * Cobalt sometimes returns a 200 with a 0-byte body — we skip those.
 */
async function verifyTunnel(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
		if (!res.ok) return false;
		if (res.headers.get("content-length") === "0") return false;

		if (res.body) {
			const reader = res.body.getReader();
			const { value, done } = await reader.read();
			await reader.cancel();
			if (done && (!value || value.length === 0)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Core cobalt resolution.
 * Tries up to `maxAttempts` instances and returns the final media URL.
 * Throws on unrecoverable failure.
 */
async function resolveCobalt(
	mediaUrl: string,
	opts: {
		mode?: "auto" | "audio" | "mute";
		audioFormat?: string;
		audioBitrate?: string;
		videoQuality?: string;
		youtubeVideoCodec?: "h264" | "av1" | "vp9";
		maxAttempts?: number;
	} = {},
): Promise<{ mediaUrl: string; filename?: string }> {
	const {
		mode = "auto",
		audioFormat = "mp3",
		audioBitrate = "320",
		videoQuality = "max",
		youtubeVideoCodec = "h264",
		maxAttempts = 10,
	} = opts;

	const body: CobaltRequest = {
		url: mediaUrl.trim(),
		videoQuality,
		audioFormat,
		audioBitrate,
		filenameStyle: "pretty",
		downloadMode: mode,
		youtubeVideoCodec,
	};

	const instances = await fetchInstances();
	const tries = Math.min(instances.length, maxAttempts);
	let lastError = "All instances exhausted";

	for (let i = 0; i < tries; i++) {
		const instance = instances[i];
		try {
			const result = await tryCobaltInstance(instance, body);

			if (isCobaltError(result)) {
				const code = result.error?.code ?? "";
				if (isContentError(code)) {
					throw new Error(`Content error [${code}]: ${result.error?.message ?? "unsupported content"}`);
				}
				lastError = `[${code}] ${result.error?.message ?? "unknown"}`;
				continue; // instance-level or unknown error → try next
			}

			// "picker" — playlist-style response; use first audio URL if available
			if (result.status === "picker") {
				const audioUrl = result.audio ?? result.picker?.[0]?.url;
				if (!audioUrl) {
					lastError = "Picker response contained no usable URL";
					continue;
				}
				return { mediaUrl: audioUrl, filename: result.filename };
			}

			// "redirect" or "tunnel"
			const resolvedUrl = result.url;
			if (!resolvedUrl) {
				lastError = "Instance returned success with no URL";
				continue;
			}

			if (result.status === "tunnel") {
				const valid = await verifyTunnel(resolvedUrl);
				if (!valid) {
					lastError = `Instance ${instance} returned a 0-byte tunnel`;
					continue;
				}
			}

			return { mediaUrl: resolvedUrl, filename: result.filename };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Content errors are terminal — rethrow immediately
			if (msg.startsWith("Content error")) throw err;
			lastError = msg;
		}
	}

	throw new Error(`cobalt: all instances failed — ${lastError}`);
}

/** Convert a fetch Response body to a Node.js Readable stream. */
function responseToReadable(res: Response): Readable {
	if (!res.body) throw new Error("Response has no body");
	const reader = res.body.getReader();
	return new Readable({
		async read() {
			try {
				const { value, done } = await reader.read();
				this.push(done ? null : value);
			} catch (err) {
				this.destroy(err instanceof Error ? err : new Error(String(err)));
			}
		},
		destroy(err, cb) {
			reader.cancel().finally(() => cb(err));
		},
	});
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

/**
 * **InfinityPlugin** — multi-platform audio/video downloader powered by the
 * [cobalt](https://cobalt.tools) API.
 *
 * Supported platforms include YouTube, SoundCloud, TikTok, Twitter/X,
 * Instagram, Reddit, Twitch, Vimeo, Bilibili, Dailymotion, and more.
 *
 * ### Usage
 * ```ts
 * const plugin = new InfinityPlugin();
 *
 * // Check if a URL is supported
 * plugin.canHandle("https://youtube.com/watch?v=dQw4w9WgXcQ"); // true
 *
 * // Resolve a track from a URL
 * const { tracks } = await plugin.search(
 *   "https://soundcloud.com/artist/track",
 *   "user123"
 * );
 *
 * // Stream the audio
 * const streamInfo = await plugin.getStream(tracks[0]);
 * streamInfo.stream.pipe(audioOutput);
 * ```
 */
export class InfinityPlugin extends BasePlugin {
	readonly name = "Infinity";
	readonly version = "1.0.0";

	/**
	 * Lower priority than platform-specific plugins (e.g. a dedicated YouTube
	 * plugin) so those get a chance first.
	 */
	readonly priority = 10;

	// ── canHandle ──────────────────────────────────────────────────────────────

	/**
	 * Returns `true` for any URL whose hostname matches a cobalt-supported
	 * platform.  Plain search queries (no protocol) return `false`.
	 */
	canHandle(query: string): boolean {
		try {
			const { hostname } = new URL(query);
			const host = hostname.replace(/^www\./, "");
			return SUPPORTED_HOSTS.some((supported) => host === supported || host.endsWith(`.${supported}`));
		} catch {
			return false; // not a URL
		}
	}

	// ── validate ───────────────────────────────────────────────────────────────

	validate(url: string): boolean {
		return this.canHandle(url);
	}

	// ── search ─────────────────────────────────────────────────────────────────

	/**
	 * Resolves a direct platform URL into a `Track` with real title and thumbnail.
	 *
	 * Metadata is fetched via oEmbed (YouTube, SoundCloud, TikTok, Vimeo, etc.)
	 * or Open Graph scraping for platforms without an oEmbed endpoint.
	 * Both strategies are capped at a few seconds so search stays snappy.
	 *
	 * Plain text search queries are not supported — provide a direct URL.
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (!this.canHandle(query)) {
			throw new Error(`InfinityPlugin does not support plain text search. ` + `Provide a direct URL from a supported platform.`);
		}

		const parsed = new URL(query);
		const host = parsed.hostname.replace(/^www\./, "");
		const source = host.split(".")[0]; // e.g. "youtube", "soundcloud", "tiktok"

		// Fetch real metadata — oEmbed first, OG scrape as fallback
		const meta = await fetchMetadata(query);

		const track: Track = {
			id: `infinity-${Buffer.from(query).toString("base64url").slice(0, 16)}`,
			title: meta.title,
			url: query,
			duration: 0, // cobalt provides no duration metadata
			thumbnail: meta.thumbnail,
			requestedBy,
			source,
			metadata: {
				originalUrl: query,
				resolvedBy: this.name,
				...(meta.author ? { artist: meta.author } : {}),
			},
		};

		return { tracks: [track] };
	}

	// ── getStream ──────────────────────────────────────────────────────────────

	/**
	 * Resolves the track URL through the cobalt instance pool and returns a
	 * Node.js `Readable` stream.
	 *
	 * @param track   - The track to stream (must have a valid URL).
	 * @param signal  - Optional `AbortSignal` to cancel the download.
	 * @param mode    - `"audio"` (default) for audio-only, `"auto"` for best stream.
	 */
	async getStream(track: Track, signal?: AbortSignal, mode: "audio" | "auto" = "audio"): Promise<StreamInfo> {
		if (!this.canHandle(track.url)) {
			throw new Error(`InfinityPlugin cannot handle URL: ${track.url}`);
		}

		const { mediaUrl, filename } = await resolveCobalt(track.url, { mode });

		// Abort check after the potentially-slow instance resolution
		signal?.throwIfAborted();

		const res = await fetch(mediaUrl, { signal });
		if (!res.ok) {
			throw new Error(`Failed to fetch media stream: HTTP ${res.status}`);
		}

		const contentType = res.headers.get("content-type") ?? "";
		const stream = responseToReadable(res);

		return {
			stream,
			// cobalt returns MP3/MP4/WebM depending on the source; mark as arbitrary
			// unless the content-type tells us otherwise.
			type:
				contentType.includes("webm") ? "webm/opus"
				: contentType.includes("ogg") ? "ogg/opus"
				: "arbitrary",
			metadata: {
				filename,
				contentType,
				source: track.source,
				resolvedUrl: mediaUrl,
			},
		};
	}

	// ── getFallback ────────────────────────────────────────────────────────────

	/**
	 * Fallback that retries cobalt with a different instance pool subset.
	 * Called automatically by the bot framework when `getStream` fails.
	 */
	async getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		// Attempt with a wider instance sweep (double the attempts)
		const { mediaUrl, filename } = await resolveCobalt(track.url, {
			mode: "audio",
			maxAttempts: 16,
		});

		signal?.throwIfAborted();

		const res = await fetch(mediaUrl, { signal });
		if (!res.ok) {
			throw new Error(`Fallback stream fetch failed: HTTP ${res.status}`);
		}

		const contentType = res.headers.get("content-type") ?? "";

		return {
			stream: responseToReadable(res),
			type:
				contentType.includes("webm") ? "webm/opus"
				: contentType.includes("ogg") ? "ogg/opus"
				: "arbitrary",
			metadata: {
				filename,
				contentType,
				source: track.source,
				resolvedUrl: mediaUrl,
				fallback: true,
			},
		};
	}

	// ── extractPlaylist ────────────────────────────────────────────────────────

	/**
	 * Extracts individual tracks from a playlist URL.
	 *
	 * ⚠️  cobalt does not expose a playlist enumeration API; this method is a
	 * best-effort wrapper — it resolves a single "picker" response (e.g. a
	 * Twitter/X post with multiple videos) and maps each entry to a `Track`.
	 * Full YouTube playlist expansion requires a separate YouTube plugin.
	 */
	async extractPlaylist(url: string, requestedBy: string): Promise<Track[]> {
		if (!this.canHandle(url)) return [];

		const body: CobaltRequest = {
			url: url.trim(),
			downloadMode: "auto",
			filenameStyle: "pretty",
		};

		const instances = await fetchInstances();
		const tries = Math.min(instances.length, 5);

		for (let i = 0; i < tries; i++) {
			try {
				const result = await tryCobaltInstance(instances[i], body);
				if (isCobaltError(result) || result.status !== "picker") continue;

				const items = result.picker ?? [];
				return items.map((item, idx) => ({
					id: `infinity-picker-${idx}-${Buffer.from(item.url).toString("base64url").slice(0, 12)}`,
					title: result.filename ? `${result.filename} [${idx + 1}]` : `Track ${idx + 1}`,
					url: item.url,
					duration: 0,
					thumbnail: item.thumb,
					requestedBy,
					source: "infinity",
					metadata: { pickerType: item.type, resolvedBy: this.name },
				}));
			} catch {
				continue;
			}
		}

		// Single-track fallback
		const { tracks } = await this.search(url, requestedBy);
		return tracks;
	}
}
