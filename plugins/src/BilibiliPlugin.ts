/**
 * @file BilibiliPlugin.ts
 * @source https://github.com/ScottSloan/Bili23-Downloader
 * @description Bilibili source plugin for ZiPlayer.
 * @note Browser emulation and ExClimbWuzhi/WBI logic are adapted from Bili23-Downloader and ported to the ZiPlayer plugin architecture.
 */
import { createHash, createHmac } from "node:crypto";
import type { Readable } from "node:stream";
import axios, { AxiosRequestConfig } from "axios";
import { BasePlugin } from "ziplayer";
import type { Track, SearchResult, StreamInfo, RelatedTracksOptions } from "ziplayer";

type Requester = Track["requestedBy"]; // string | object

/* -------------------------------------------------------------------------- */
/*  Options                                                                   */
/* -------------------------------------------------------------------------- */

export interface BilibiliPluginOptions {
	/** Optional Bilibili account SESSDATA cookie. Required for restricted videos / higher quality. */
	sessdata?: string;
	/** Preferred audio quality. Defaults to `super` (highest available). */
	quality?: "low" | "standard" | "high" | "super";
	/** Allows fetching Hi-Res audio (FLAC / Dolby) when available (usually requires VIP SESSDATA). Defaults to false. */
	preferHiRes?: boolean;
	/** Multi-part videos (P1, P2, ...) are returned as a playlist. Defaults to true. */
	multiPartAsPlaylist?: boolean;
	/** Maximum track count for extractPlaylist (favorites / UP channel). Defaults to 100. */
	maxPlaylistItems?: number;
	/** Request timeout (ms). Defaults to 15000. */
	timeout?: number;
}

/* -------------------------------------------------------------------------- */
/*  Constants & helpers                                                       */
/* -------------------------------------------------------------------------- */

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0";

const SEARCH_PAGE_SIZE = 20;
const BVID_RE = /BV[0-9A-Za-z]{10}/;
const AID_RE = /(?:^|[^a-z])av(\d+)/i;

/** Only allow media downloads from Bilibili CDNs (mitigates SSRF because the plugin uses URLs returned by the API). */
const MEDIA_HOST_RE = /(^|\.)(bilivideo\.(com|cn)|hdslb\.com|akamaized\.net)$/i;

const MIXIN_KEY_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37,
	48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * Payload template for "ExClimbWuzhi" used to activate buvid3 (adapted from Bili23-Downloader).
 * Without this activation step, several APIs (playurl, view...) return 412 / -352.
 */
const EXCLIMBWUZHI_TEMPLATE: Record<string, any> = {
	"3064": 1,
	"5062": "1",
	"03bf": "https%3A%2F%2Fwww.bilibili.com%2F",
	"39c8": "333.1007.fp.risk",
	"34f1": "",
	d402: "",
	"654a": "",
	"6e7c": "1699x794",
	"3c43": {
		"2673": 0,
		"5766": 32,
		"6527": 0,
		"7003": 1,
		"807e": 1,
		b8ce: "__UA__",
		"641c": 0,
		"07a4": "zh-CN",
		"1c57": 32,
		"0bd0": 20,
		"748e": [960, 1707],
		d61f: [912, 1707],
		fc9d: -480,
		"6aa9": "Asia/Shanghai",
		"75b8": 1,
		"3b21": 1,
		"8a1c": 0,
		d52f: "not available",
		adca: "Win32",
		"80c9": [
			[
				"PDF Viewer",
				"Portable Document Format",
				[
					["application/pdf", "pdf"],
					["text/pdf", "pdf"],
				],
			],
			[
				"Chrome PDF Viewer",
				"Portable Document Format",
				[
					["application/pdf", "pdf"],
					["text/pdf", "pdf"],
				],
			],
			[
				"Chromium PDF Viewer",
				"Portable Document Format",
				[
					["application/pdf", "pdf"],
					["text/pdf", "pdf"],
				],
			],
			[
				"Microsoft Edge PDF Viewer",
				"Portable Document Format",
				[
					["application/pdf", "pdf"],
					["text/pdf", "pdf"],
				],
			],
			[
				"WebKit built-in PDF",
				"Portable Document Format",
				[
					["application/pdf", "pdf"],
					["text/pdf", "pdf"],
				],
			],
		],
		"13ab": "EPQAAAAASUVORK5CYII=",
		bfe9: "//TgNIfAAAAAZJREFUAwBde+3wgcxEHQAAAABJRU5ErkJggg==",
		a3c1: [
			"extensions:ANGLE_instanced_arrays;EXT_blend_minmax;EXT_clip_control;EXT_color_buffer_half_float;EXT_depth_clamp;EXT_disjoint_timer_query;EXT_float_blend;EXT_frag_depth;EXT_polygon_offset_clamp;EXT_shader_texture_lod;EXT_texture_compression_bptc;EXT_texture_compression_rgtc;EXT_texture_filter_anisotropic;EXT_texture_mirror_clamp_to_edge;EXT_sRGB;KHR_parallel_shader_compile;OES_element_index_uint;OES_fbo_render_mipmap;OES_standard_derivatives;OES_texture_float;OES_texture_float_linear;OES_texture_half_float;OES_texture_half_float_linear;OES_vertex_array_object;WEBGL_blend_func_extended;WEBGL_color_buffer_float;WEBGL_compressed_texture_s3tc;WEBGL_compressed_texture_s3tc_srgb;WEBGL_debug_renderer_info;WEBGL_debug_shaders;WEBGL_depth_texture;WEBGL_draw_buffers;WEBGL_lose_context;WEBGL_multi_draw;WEBGL_polygon_mode",
			"webgl aliased line width range:[1, 1]",
			"webgl aliased point size range:[1, 1024]",
			"webgl alpha bits:8",
			"webgl antialiasing:yes",
			"webgl blue bits:8",
			"webgl depth bits:24",
			"webgl green bits:8",
			"webgl max anisotropy:16",
			"webgl max combined texture image units:32",
			"webgl max cube map texture size:16384",
			"webgl max fragment uniform vectors:1024",
			"webgl max render buffer size:16384",
			"webgl max texture image units:16",
			"webgl max texture size:16384",
			"webgl max varying vectors:30",
			"webgl max vertex attribs:16",
			"webgl max vertex texture image units:16",
			"webgl max vertex uniform vectors:4095",
			"webgl max viewport dims:[32767, 32767]",
			"webgl red bits:8",
			"webgl renderer:WebKit WebGL",
			"webgl shading language version:WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
			"webgl stencil bits:0",
			"webgl vendor:WebKit",
			"webgl version:WebGL 1.0 (OpenGL ES 2.0 Chromium)",
			"webgl unmasked vendor:Google Inc. (NVIDIA)",
			"webgl unmasked renderer:ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
			"webgl vertex shader high float precision:23",
			"webgl vertex shader high float precision rangeMin:127",
			"webgl vertex shader high float precision rangeMax:127",
			"webgl vertex shader medium float precision:23",
			"webgl vertex shader medium float precision rangeMin:127",
			"webgl vertex shader medium float precision rangeMax:127",
			"webgl vertex shader low float precision:23",
			"webgl vertex shader low float precision rangeMin:127",
			"webgl vertex shader low float precision rangeMax:127",
			"webgl fragment shader high float precision:23",
			"webgl fragment shader high float precision rangeMin:127",
			"webgl fragment shader high float precision rangeMax:127",
			"webgl fragment shader medium float precision:23",
			"webgl fragment shader medium float precision rangeMin:127",
			"webgl fragment shader medium float precision rangeMax:127",
			"webgl fragment shader low float precision:23",
			"webgl fragment shader low float precision rangeMin:127",
			"webgl fragment shader low float precision rangeMax:127",
			"webgl vertex shader high int precision:0",
			"webgl vertex shader high int precision rangeMin:31",
			"webgl vertex shader high int precision rangeMax:30",
			"webgl vertex shader medium int precision:0",
			"webgl vertex shader medium int precision rangeMin:31",
			"webgl vertex shader medium int precision rangeMax:30",
			"webgl vertex shader low int precision:0",
			"webgl vertex shader low int precision rangeMin:31",
			"webgl vertex shader low int precision rangeMax:30",
			"webgl fragment shader high int precision:0",
			"webgl fragment shader high int precision rangeMin:31",
			"webgl fragment shader high int precision rangeMax:30",
			"webgl fragment shader medium int precision:0",
			"webgl fragment shader medium int precision rangeMin:31",
			"webgl fragment shader medium int precision rangeMax:30",
			"webgl fragment shader low int precision:0",
			"webgl fragment shader low int precision rangeMin:31",
			"webgl fragment shader low int precision rangeMax:30",
		],
		"6bc5":
			"Google Inc. (NVIDIA)~ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
		ed31: 0,
		"72bd": 0,
		"097b": 0,
		"52cd": [0, 0, 0],
		a658: [
			"Arial",
			"Arial Black",
			"Arial Narrow",
			"Book Antiqua",
			"Bookman Old Style",
			"Calibri",
			"Cambria",
			"Cambria Math",
			"Century",
			"Century Gothic",
			"Century Schoolbook",
			"Comic Sans MS",
			"Consolas",
			"Courier",
			"Courier New",
			"Georgia",
			"Helvetica",
			"Impact",
			"Lucida Bright",
			"Lucida Calligraphy",
			"Lucida Console",
			"Lucida Fax",
			"Lucida Handwriting",
			"Lucida Sans",
			"Lucida Sans Typewriter",
			"Lucida Sans Unicode",
			"Microsoft Sans Serif",
			"Monotype Corsiva",
			"MS Gothic",
			"MS PGothic",
			"MS Reference Sans Serif",
			"MS Sans Serif",
			"MS Serif",
			"Palatino Linotype",
			"Segoe Print",
			"Segoe Script",
			"Segoe UI",
			"Segoe UI Light",
			"Segoe UI Semibold",
			"Segoe UI Symbol",
			"Tahoma",
			"Times",
			"Times New Roman",
			"Trebuchet MS",
			"Verdana",
			"Wingdings",
			"Wingdings 2",
			"Wingdings 3",
		],
		d02f: "124.04347527516074",
	},
	"54ef":
		'{"b_ut":"","home_version":"V8","in_new_ab":true,"ab_version":{"for_ai_home_version":"V8","in_theme_version":"OPEN","enable_web_push":"DISABLE","enable_ai_floor_api":"ENABLE","enable_shortcut_key":"DISABLE","rcmd_timeout_config":"550","home_performance_opt":"ssr_fetch_opt","infra_projection":"OFF"},"ab_split_num":{"for_ai_home_version":54,"in_theme_version":30,"enable_web_push":10,"enable_ai_floor_api":137,"enable_shortcut_key":54,"rcmd_timeout_config":49,"home_performance_opt":49,"infra_projection":49},"uniq_page_id":"1671272756362","is_modern":true}',
	"8b94": "",
	df35: "__UUID__",
	"07a4": "zh-CN",
	"5f45": null,
	db46: 0,
};

const MASK64 = (1n << 64n) - 1n;
const rotl64 = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & MASK64;
function fmix64(k: bigint): bigint {
	let t = k;
	t ^= t >> 33n;
	t = (t * 0xff51afd7ed558ccdn) & MASK64;
	t ^= t >> 33n;
	t = (t * 0xc4ceb9fe1a85ec53n) & MASK64;
	t ^= t >> 33n;
	return t;
}

/** murmur3 x64 128 (seed 31) over ASCII string → buvid_fp. */
function buvidFp(key: string, seed = 31n): string {
	const data = Buffer.from(key, "ascii");
	const C1 = 0x87c37b91114253d5n;
	const C2 = 0x4cf5ad432745937fn;
	let h1 = seed;
	let h2 = seed;
	const len = data.length;
	const blocks = Math.floor(len / 16);

	for (let i = 0; i < blocks; i++) {
		const k1 = data.readBigUInt64LE(i * 16);
		const k2 = data.readBigUInt64LE(i * 16 + 8);
		h1 ^= (rotl64((k1 * C1) & MASK64, 31n) * C2) & MASK64;
		h1 = ((rotl64(h1, 27n) + h2) * 5n + 0x52dce729n) & MASK64;
		h2 ^= (rotl64((k2 * C2) & MASK64, 33n) * C1) & MASK64;
		h2 = ((rotl64(h2, 31n) + h1) * 5n + 0x38495ab5n) & MASK64;
	}

	const tail = data.subarray(blocks * 16);
	if (tail.length) {
		let k1 = 0n;
		let k2 = 0n;
		for (let i = tail.length - 1; i >= 8; i--) k2 ^= BigInt(tail[i]) << BigInt((i - 8) * 8);
		if (tail.length > 8) h2 ^= (rotl64((k2 * C2) & MASK64, 33n) * C1) & MASK64;
		for (let i = Math.min(tail.length, 8) - 1; i >= 0; i--) k1 ^= BigInt(tail[i]) << BigInt(i * 8);
		h1 ^= (rotl64((k1 * C1) & MASK64, 31n) * C2) & MASK64;
	}

	const n = BigInt(len);
	h1 ^= n;
	h2 ^= n;
	h1 = (h1 + h2) & MASK64;
	h2 = (h2 + h1) & MASK64;
	h1 = fmix64(h1);
	h2 = fmix64(h2);
	h1 = (h1 + h2) & MASK64;
	h2 = (h2 + h1) & MASK64;
	return h1.toString(16) + h2.toString(16);
}

function randomUuid(): string {
	const mp = "123456789ABCDEF".split("").concat(["10"]);
	const part = (n: number) => Array.from({ length: n }, () => mp[Math.floor(Math.random() * mp.length)]).join("");
	const t = String(Date.now() % 100000).padEnd(5, "0");
	return [8, 4, 4, 4, 12].map(part).join("-") + t + "infoc";
}

function randomLsid(): string {
	const a = Array.from({ length: 8 }, () =>
		Math.floor(Math.random() * 16)
			.toString(16)
			.toUpperCase(),
	).join("");
	return `${a}_${Math.floor(Date.now() / 1000)
		.toString(16)
		.toUpperCase()}`;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function durationToMS(duration: string | number | undefined | null): number {
	if (typeof duration === "number") return duration * 1000;
	if (typeof duration === "string") return duration.split(":").reduce((p, c) => 60 * p + +c, 0) * 1000 || 0;
	return 0;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
function cleanTitle(raw: unknown): string {
	return String(raw ?? "")
		.replace(/<\/?em[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function fixUrl(u?: string): string | undefined {
	if (!u) return undefined;
	if (u.startsWith("//")) return `https:${u}`;
	return u.replace(/^http:\/\//, "https://");
}

function isAllowedMediaUrl(u: string): boolean {
	try {
		const url = new URL(u);
		return url.protocol === "https:" && MEDIA_HOST_RE.test(url.hostname);
	} catch {
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export class BilibiliPlugin extends BasePlugin {
	name = "bilibili";
	version = "1.0.0";

	private readonly opts: Required<Omit<BilibiliPluginOptions, "sessdata">> & { sessdata?: string };

	// Browser emulation session: buvid3/4 + _uuid + b_lsid + b_nut + buvid_fp + bili_ticket (already activated via ExClimbWuzhi)
	private session?: { jar: Record<string, string>; at: number };
	private sessionPromise?: Promise<{ jar: Record<string, string>; at: number }>;
	// WBI keys
	private wbi?: { img: string; sub: string; at: number };

	constructor(options: BilibiliPluginOptions = {}) {
		super();
		this.opts = {
			sessdata: options.sessdata,
			quality: options.quality ?? "super",
			preferHiRes: options.preferHiRes ?? false,
			multiPartAsPlaylist: options.multiPartAsPlaylist ?? true,
			maxPlaylistItems: options.maxPlaylistItems ?? 100,
			timeout: options.timeout ?? 15_000,
		};
	}

	/* ------------------------------ SourcePlugin ----------------------------- */

	canHandle(query: string): boolean {
		if (!query || typeof query !== "string") return false;
		const q = query.trim();
		return (
			/(?:^|\.)bilibili\.com\//i.test(q.replace(/^https?:\/\//i, "")) ||
			/(?:^|\/\/)b23\.tv\//i.test(q) ||
			/^BV[0-9A-Za-z]{10}$/.test(q) ||
			/^av\d+$/i.test(q) ||
			/^(?:bilibili|bili|b站)\s*[:：]/i.test(q)
		);
	}

	validate(url: string): boolean {
		return this.canHandle(url);
	}

	async search(query: string, requestedBy: Requester, signal?: AbortSignal): Promise<SearchResult> {
		let q = query.trim().replace(/^(?:bilibili|bili|b站)\s*[:：]?\s*/i, "") || query.trim();

		if (/b23\.tv\//i.test(q)) q = await this.resolveShortUrl(q, signal);

		// 1) Link / BV / av → fetch video info directly
		const ref = this.parseVideoRef(q);
		if (ref) {
			const view = await this.getView(ref, signal);
			const tracks = this.tracksFromView(view, requestedBy, ref.page);
			const playlist =
				this.opts.multiPartAsPlaylist && !ref.page && tracks.length > 1 ?
					{ name: cleanTitle(view.title), url: `https://www.bilibili.com/video/${view.bvid}`, thumbnail: fixUrl(view.pic) }
				:	null;
			return { tracks: playlist ? tracks : tracks.slice(0, 1), playlist, query, source: this.name };
		}

		// 2) Keyword → search for videos
		const data = await this.searchVideos(q, 1, signal);
		const tracks = (data?.result ?? []).map((r: any) => this.trackFromSearch(r, requestedBy));
		return { tracks, playlist: null, query, source: this.name };
	}

	async getStream(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		const meta = await this.resolveMeta(track, signal);
		const candidates = await this.getAudioCandidates(meta, signal);
		if (!candidates.length) throw new Error("Bilibili: no valid audio stream found for this video");

		let lastError: unknown;
		for (const url of candidates) {
			try {
				const stream = await this.openMedia(url, meta.bvid ?? String(meta.aid), signal);
				return { stream, type: "arbitrary", track, metadata: { ...track.metadata, ...meta, source: this.name } };
			} catch (err) {
				lastError = err;
				if (signal?.aborted) throw err;
			}
		}
		throw new Error(`Bilibili: unable to open stream (${(lastError as Error)?.message ?? "unknown"})`);
	}

	/**
	 * Video (already combined picture + audio). Bilibili's DASH separates video/audio, so this uses the `durl` stream
	 * (full MP4, up to ~720p, 1080p if SESSDATA is available).
	 */
	async getVideo(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		const meta = await this.resolveMeta(track, signal);
		const data = await this.fetchPlayUrl(
			meta,
			{ fnver: 0, fnval: 0, qn: this.opts.sessdata ? 80 : 64, platform: "html5", high_quality: 1 },
			signal,
		);

		const durl: any[] = data?.durl ?? [];
		const urls = [
			...new Set(
				durl
					.flatMap((d) => [d.url, ...(d.backup_url ?? [])])
					.filter(Boolean)
					.map((u: string) => fixUrl(u)!),
			),
		].filter(isAllowedMediaUrl);
		if (!urls.length) throw new Error("Bilibili: no valid video stream found");

		let lastError: unknown;
		for (const url of urls) {
			try {
				const stream = await this.openMedia(url, meta.bvid ?? String(meta.aid), signal);
				return { stream, type: "arbitrary", track, metadata: { ...track.metadata, ...meta, source: this.name, video: true } };
			} catch (err) {
				lastError = err;
				if (signal?.aborted) throw err;
			}
		}
		throw new Error(`Bilibili: unable to open video (${(lastError as Error)?.message ?? "unknown"})`);
	}

	async getFallback(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		// Retry from the start at the lowest quality (different CDN/bitrate).
		const prev = this.opts.quality;
		this.opts.quality = "low";
		try {
			return await this.getStream(track, signal);
		} finally {
			this.opts.quality = prev;
		}
	}

	async getRelatedTracks(track: Track, opts: RelatedTracksOptions = {}): Promise<Track[]> {
		const meta = track.metadata ?? {};
		const bvid = meta.bvid ?? track.id.match(BVID_RE)?.[0];
		const aid = meta.aid;
		if (!bvid && !aid) return [];

		const res = await this.http({
			url: "https://api.bilibili.com/x/web-interface/archive/related",
			params: bvid ? { bvid } : { aid },
		});
		const list: any[] = res?.data?.data ?? [];
		const seen = new Set((opts.history ?? []).map((t) => t.metadata?.bvid ?? t.id));
		seen.add(bvid);

		const offset = opts.offset ?? 0;
		const limit = opts.limit ?? 10;
		return list
			.filter((v) => v.bvid && !seen.has(v.bvid))
			.slice(offset, offset + limit)
			.map((v) => this.trackFromView(v, track.requestedBy));
	}

	async extractPlaylist(url: string, requestedBy: Requester): Promise<Track[]> {
		if (/b23\.tv\//i.test(url)) url = await this.resolveShortUrl(url);

		// Multi-part videos
		const ref = this.parseVideoRef(url);
		if (ref && !/fid=|\/list\/ml|\/playlist\/pl|favlist/i.test(url)) {
			return this.tracksFromView(await this.getView(ref), requestedBy, ref.page);
		}

		// Favorites
		const fid =
			url.match(/^\s*(\d+)\s*$/)?.[1] ??
			url.match(/[?&]fid=(\d+)/)?.[1] ??
			url.match(/\/list\/ml(\d+)/i)?.[1] ??
			url.match(/\/playlist\/pl(\d+)/i)?.[1];
		if (fid) return this.getFavoriteTracks(fid, requestedBy);

		// UP channel
		const mid = url.match(/space\.bilibili\.com\/(\d+)/i)?.[1];
		if (mid) return this.getUploaderTracks(mid, requestedBy);

		return [];
	}

	/* --------------------------------- HTTP ---------------------------------- */

	private async http(config: AxiosRequestConfig & { signal?: AbortSignal }, retried = false): Promise<any> {
		const extra = (config.headers ?? {}) as Record<string, string>;
		const cookies: string[] = [extra.cookie ?? (await this.buvidCookie())];
		if (this.opts.sessdata) cookies.push(`SESSDATA=${this.opts.sessdata}`);

		const headers: Record<string, string> = {
			"user-agent": UA,
			accept: "application/json, text/plain, */*",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
			referer: "https://www.bilibili.com/",
			origin: "https://www.bilibili.com",
			...extra,
			cookie: cookies.join("; "),
		};

		try {
			const res = await axios.request({ timeout: this.opts.timeout, ...config, headers });
			const code = res?.data?.code;
			if (!retried && (code === -412 || code === -352)) throw Object.assign(new Error("risk-control"), { __risk: true });
			return res;
		} catch (err: any) {
			const status = err?.response?.status;
			const code = err?.response?.data?.code;
			const risk = err?.__risk || status === 412 || status === 403 || code === -412 || code === -352;
			if (!retried && risk && !config.signal?.aborted) {
				// Refresh buvid and retry once.
				this.session = undefined;
				this.wbi = undefined;
				await new Promise((r) => setTimeout(r, 400));
				return this.http({ ...config, headers: { ...extra, cookie: undefined as any } }, true);
			}
			throw err;
		}
	}

	private async ensureSession() {
		if (this.session && Date.now() - this.session.at < 6 * 3600_000) return this.session;
		if (!this.sessionPromise) {
			this.sessionPromise = this.createSession()
				.then((s) => (this.session = s))
				.finally(() => (this.sessionPromise = undefined));
		}
		return this.sessionPromise;
	}

	private async createSession() {
		const base = { "user-agent": UA, referer: "https://www.bilibili.com/", origin: "https://www.bilibili.com" };
		const timeout = this.opts.timeout;

		// 1) buvid3 / buvid4
		const spi = await axios.get("https://api.bilibili.com/x/frontend/finger/spi", { headers: base, timeout });
		const ids = spi.data?.data;
		if (!ids?.b_3) throw new Error(`Bilibili: failed to obtain buvid (code ${spi.data?.code})`);

		const uuid = randomUuid();
		const nowSec = Math.floor(Date.now() / 1000);
		const jar: Record<string, string> = {
			_uuid: uuid,
			b_lsid: randomLsid(),
			b_nut: String(nowSec),
			buvid_fp: buvidFp(UA),
			buvid3: ids.b_3,
			buvid4: ids.b_4,
			CURRENT_FNVAL: "4048",
			CURRENT_QUALITY: "0",
		};
		const cookie = () =>
			Object.entries(jar)
				.map(([k, v]) => `${k}=${v}`)
				.join("; ");

		// 2) bili_ticket (with WBI key in nav)
		try {
			const hexsign = createHmac("sha256", "XgwSnGZ1p").update(`ts${nowSec}`).digest("hex");
			const res = await axios.post("https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket", null, {
				params: { key_id: "ec02", hexsign, "context[ts]": nowSec, csrf: "" },
				headers: { ...base, cookie: cookie() },
				timeout,
			});
			const d = res.data?.data;
			if (d?.ticket) {
				jar.bili_ticket = d.ticket;
				jar.bili_ticket_expires = String(nowSec + 3 * 24 * 3600);
			}
			if (d?.nav?.img && d?.nav?.sub) {
				const strip = (u: string) => u.slice(u.lastIndexOf("/") + 1, u.lastIndexOf("."));
				this.wbi = { img: strip(d.nav.img), sub: strip(d.nav.sub), at: Date.now() };
			}
		} catch {
			/* optional */
		}

		// 3) Activate buvid3 (ExClimbWuzhi)
		try {
			const payload = JSON.parse(JSON.stringify(EXCLIMBWUZHI_TEMPLATE));
			payload["5062"] = String(Date.now());
			payload["3c43"]["b8ce"] = UA;
			payload["df35"] = uuid;
			await axios.post(
				"https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi",
				JSON.stringify({ payload: JSON.stringify(payload) }),
				{
					headers: { ...base, "content-type": "application/json", cookie: cookie() },
					timeout,
				},
			);
		} catch {
			/* optional, but if it fails the API may still return 412 */
		}

		return { jar, at: Date.now() };
	}

	/** Full session cookie string (without SESSDATA). */
	private async buvidCookie() {
		const { jar } = await this.ensureSession();
		return Object.entries(jar)
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
	}

	private async resolveShortUrl(url: string, signal?: AbortSignal): Promise<string> {
		try {
			const res = await axios.get(url, {
				maxRedirects: 0,
				validateStatus: (s: number) => s >= 200 && s < 400,
				headers: { "user-agent": UA },
				timeout: this.opts.timeout,
				signal,
			});
			return (res.headers.location as string) ?? url;
		} catch {
			return url;
		}
	}

	/* ---------------------------------- WBI ---------------------------------- */

	private async getWbiKeys(): Promise<{ img: string; sub: string }> {
		if (this.wbi && Date.now() - this.wbi.at < 6 * 3600_000) return this.wbi;

		await this.ensureSession(); // createSession fills this.wbi if it gets a ticket
		if (this.wbi) return this.wbi;

		// Fallback: x/web-interface/nav (even without login it still returns wbi_img even with code = -101)
		const res = await this.http({ url: "https://api.bilibili.com/x/web-interface/nav" }).catch((e: any) => e?.response);
		const img = res?.data?.data?.wbi_img;
		if (!img?.img_url || !img?.sub_url) throw new Error("Bilibili: failed to obtain WBI key");
		const strip = (u: string) => u.slice(u.lastIndexOf("/") + 1, u.lastIndexOf("."));
		this.wbi = { img: strip(img.img_url), sub: strip(img.sub_url), at: Date.now() };
		return this.wbi;
	}

	/** Sign parameters with WBI → return params including `wts` + `w_rid`. */
	private async signWbi(params: Record<string, any>): Promise<Record<string, any>> {
		const { img, sub } = await this.getWbiKeys();
		const raw = img + sub;
		const mixin = MIXIN_KEY_TAB.map((i) => raw.charAt(i))
			.join("")
			.slice(0, 32);

		const withTs: Record<string, any> = { ...params, wts: Math.round(Date.now() / 1000) };
		const query = Object.keys(withTs)
			.sort()
			.map((k) => {
				const v = typeof withTs[k] === "string" ? withTs[k].replace(/[!'()*]/g, "") : withTs[k];
				return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
			})
			.join("&");
		return { ...withTs, w_rid: md5(query + mixin) };
	}

	/* ------------------------------- Video info ------------------------------ */

	private parseVideoRef(input: string): { bvid?: string; aid?: number; page?: number } | null {
		const bvid = input.match(BVID_RE)?.[0];
		const aidStr = !bvid ? input.match(AID_RE)?.[1] : undefined;
		if (!bvid && !aidStr) return null;
		const p = input.match(/[?&]p=(\d+)/)?.[1];
		return { bvid, aid: aidStr ? Number(aidStr) : undefined, page: p ? Number(p) : undefined };
	}

	private async getView(ref: { bvid?: string; aid?: number }, signal?: AbortSignal) {
		const base = ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid };
		let res: any;
		try {
			res = await this.http({ url: "https://api.bilibili.com/x/web-interface/view", params: base, signal });
		} catch (err) {
			if (signal?.aborted) throw err;
			// Fallback: WBI-signed endpoint
			res = await this.http({
				url: "https://api.bilibili.com/x/web-interface/wbi/view",
				params: await this.signWbi(base),
				signal,
			});
		}
		if (res.data.code !== 0) throw new Error(`Bilibili: ${res.data.message ?? "failed to fetch video info"} (${res.data.code})`);
		return res.data.data;
	}

	private tracksFromView(view: any, requestedBy: Requester, onlyPage?: number): Track[] {
		const pages: any[] =
			view.pages?.length ? view.pages : [{ cid: view.cid, page: 1, part: view.title, duration: view.duration }];
		const selected = onlyPage ? pages.filter((p) => p.page === onlyPage) : pages;
		const list = selected.length ? selected : pages.slice(0, 1);
		const multi = pages.length > 1;

		return list.map((p) => {
			const base = this.trackFromView(view, requestedBy);
			return {
				...base,
				id: multi ? `${view.bvid}_p${p.page}` : view.bvid,
				title: multi ? `${cleanTitle(view.title)} - P${p.page} ${cleanTitle(p.part)}` : cleanTitle(view.title),
				url: multi ? `https://www.bilibili.com/video/${view.bvid}?p=${p.page}` : base.url,
				duration: durationToMS(p.duration ?? view.duration),
				metadata: { ...base.metadata, cid: p.cid, page: p.page },
			} as Track;
		});
	}

	private trackFromView(v: any, requestedBy: Requester): Track {
		return {
			id: v.bvid ?? String(v.aid),
			title: cleanTitle(v.title),
			url: `https://www.bilibili.com/video/${v.bvid ?? "av" + v.aid}`,
			duration: durationToMS(v.duration),
			thumbnail: fixUrl(v.pic),
			author: v.owner?.name ?? v.author,
			requestedBy,
			source: this.name,
			isLive: false,
			metadata: { bvid: v.bvid, aid: v.aid, cid: v.cid, mid: v.owner?.mid ?? v.mid },
		};
	}

	private trackFromSearch(r: any, requestedBy: Requester): Track {
		return {
			id: r.bvid ?? String(r.aid),
			title: cleanTitle(r.title),
			url: `https://www.bilibili.com/video/${r.bvid}`,
			duration: durationToMS(r.duration),
			thumbnail: fixUrl(r.pic),
			author: r.author,
			requestedBy,
			source: this.name,
			isLive: false,
			metadata: { bvid: r.bvid, aid: r.aid, mid: r.mid, tags: r.tag?.split?.(","), play: r.play },
		};
	}

	/* --------------------------------- Search -------------------------------- */

	private async searchVideos(keyword: string, page: number, signal?: AbortSignal) {
		const res = await this.http({
			url: "https://api.bilibili.com/x/web-interface/search/type",
			params: {
				page,
				page_size: SEARCH_PAGE_SIZE,
				keyword,
				search_type: "video",
				order: "",
				highlight: 1,
				platform: "pc",
				__refresh__: true,
				dynamic_offset: 0,
			},
			headers: {
				origin: "https://search.bilibili.com",
				referer: "https://search.bilibili.com/",
				cookie: await this.buvidCookie(),
			},
			signal,
		});
		if (res.data.code !== 0) throw new Error(`Bilibili search: ${res.data.message} (${res.data.code})`);
		return res.data.data;
	}

	/* ------------------------------ Playlist helpers ------------------------- */

	private async getFavoriteTracks(fid: string, requestedBy: Requester): Promise<Track[]> {
		const out: Track[] = [];
		for (let pn = 1; out.length < this.opts.maxPlaylistItems; pn++) {
			const res = await this.http({
				url: "https://api.bilibili.com/x/v3/fav/resource/list",
				params: { media_id: fid, platform: "web", ps: 20, pn },
			});
			const data = res.data?.data;
			if (res.data.code !== 0 || !data?.medias) break;
			for (const m of data.medias) {
				if (!m.bvid || m.attr > 0) continue; // attr > 0: video deleted / hidden
				out.push({
					id: m.bvid,
					title: cleanTitle(m.title),
					url: `https://www.bilibili.com/video/${m.bvid}`,
					duration: durationToMS(m.duration),
					thumbnail: fixUrl(m.cover),
					author: m.upper?.name,
					requestedBy,
					source: this.name,
					isLive: false,
					metadata: { bvid: m.bvid, aid: m.id ?? m.aid, mid: m.upper?.mid },
				});
			}
			if (!data.has_more) break;
		}
		return out.slice(0, this.opts.maxPlaylistItems);
	}

	private async getUploaderTracks(mid: string, requestedBy: Requester): Promise<Track[]> {
		const out: Track[] = [];
		const cookie = await this.buvidCookie();
		for (let pn = 1; out.length < this.opts.maxPlaylistItems; pn++) {
			const params = await this.signWbi({
				mid,
				ps: 30,
				tid: 0,
				pn,
				web_location: 1550101,
				order_avoided: true,
				order: "pubdate",
				keyword: "",
				platform: "web",
				dm_img_list: "[]",
				dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
				dm_cover_img_str:
					"QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDE2NTAgKDB4MDAwMDFGOTEpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE5WSURJQS",
				dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
			});
			const res = await this.http({
				url: "https://api.bilibili.com/x/space/wbi/arc/search",
				params,
				headers: { origin: "https://space.bilibili.com", referer: `https://space.bilibili.com/${mid}/video`, cookie },
			});
			if (res.data.code !== 0) throw new Error(`Bilibili space: ${res.data.message} (${res.data.code})`);
			const list: any[] = res.data.data?.list?.vlist ?? [];
			for (const v of list) out.push(this.trackFromView({ ...v, owner: { name: v.author, mid } }, requestedBy));
			const page = res.data.data?.page;
			if (!list.length || !page || page.pn * page.ps >= page.count) break;
		}
		return out.slice(0, this.opts.maxPlaylistItems);
	}

	/* ------------------------------- Stream helpers -------------------------- */

	private async resolveMeta(track: Track, signal?: AbortSignal): Promise<{ bvid?: string; aid?: number; cid: number }> {
		const m = track.metadata ?? {};
		let bvid: string | undefined = m.bvid ?? track.id?.match(BVID_RE)?.[0] ?? track.url?.match(BVID_RE)?.[0];
		let aid: number | undefined = m.aid;
		let cid: number | undefined = m.cid;

		if (!cid) {
			const page = m.page ?? Number(track.url?.match(/[?&]p=(\d+)/)?.[1] ?? 1);
			const view = await this.getView({ bvid, aid }, signal);
			bvid = view.bvid;
			aid = view.aid;
			cid = (view.pages?.find((p: any) => p.page === page) ?? view.pages?.[0])?.cid ?? view.cid;
		}
		if (!cid) throw new Error("Bilibili: failed to determine cid");
		return { bvid, aid, cid };
	}

	private describeError(label: string, err: any): Error {
		const status = err?.response?.status;
		const code = err?.response?.data?.code;
		const msg = err?.response?.data?.message ?? err?.message ?? "unknown";
		return new Error(`Bilibili ${label}: HTTP ${status ?? "?"} code ${code ?? "?"} - ${msg}`);
	}

	/** Fetch playurl: prefer the WBI-signed endpoint, and fall back to the legacy endpoint on failure. */
	private async fetchPlayUrl(
		meta: { bvid?: string; aid?: number; cid: number },
		extra: Record<string, any>,
		signal?: AbortSignal,
	): Promise<any> {
		const base = { ...(meta.bvid ? { bvid: meta.bvid } : { avid: meta.aid }), cid: meta.cid, ...extra };
		const errors: Error[] = [];

		try {
			const res = await this.http({
				url: "https://api.bilibili.com/x/player/wbi/playurl",
				params: await this.signWbi(base),
				signal,
			});
			if (res.data.code === 0) return res.data.data;
			errors.push(new Error(`wbi/playurl code ${res.data.code} - ${res.data.message}`));
		} catch (err) {
			if (signal?.aborted) throw err;
			errors.push(this.describeError("wbi/playurl", err));
		}

		try {
			const legacy: Record<string, any> = { ...base };
			if (legacy.avid) {
				legacy.aid = legacy.avid;
				delete legacy.avid;
			}
			const res = await this.http({ url: "https://api.bilibili.com/x/player/playurl", params: legacy, signal });
			if (res.data.code === 0) return res.data.data;
			errors.push(new Error(`playurl code ${res.data.code} - ${res.data.message}`));
		} catch (err) {
			if (signal?.aborted) throw err;
			errors.push(this.describeError("playurl", err));
		}

		throw new Error(`Bilibili: failed to fetch playurl (${errors.map((e) => e.message).join(" | ")})`);
	}

	/** Return the list of audio URLs in priority order (baseUrl first, backup later). */
	private async getAudioCandidates(meta: { bvid?: string; aid?: number; cid: number }, signal?: AbortSignal): Promise<string[]> {
		const data = await this.fetchPlayUrl(meta, { qn: 64, fnver: 0, fnval: 4048, fourk: 1 }, signal);

		let urls: string[] = [];
		if (data.dash) {
			const pool: any[] = [...(data.dash.audio ?? [])];
			if (this.opts.preferHiRes) {
				if (data.dash.flac?.audio) pool.push(data.dash.flac.audio);
				if (data.dash.dolby?.audio?.length) pool.push(...data.dash.dolby.audio);
			}
			pool.sort((a, b) => a.bandwidth - b.bandwidth);
			if (pool.length) {
				const idx = { low: 0, standard: 1, high: 2, super: pool.length - 1 }[this.opts.quality];
				const chosen = pool[Math.min(idx, pool.length - 1)];
				// Add the closest alternatives as backups (high → low).
				const ordered = [chosen, ...pool.filter((a) => a !== chosen).reverse()];
				urls = ordered.flatMap((a) => [a.baseUrl ?? a.base_url, ...(a.backupUrl ?? a.backup_url ?? [])]);
			}
		} else if (data.durl?.length) {
			urls = data.durl.flatMap((d: any) => [d.url, ...(d.backup_url ?? [])]);
		}

		return [...new Set(urls.filter(Boolean).map((u) => fixUrl(u)!))].filter(isAllowedMediaUrl);
	}

	/** Bilibili CDNs require Referer + UA, so the stream must be opened locally instead of returning `url`. */
	private async openMedia(url: string, videoId: string, signal?: AbortSignal): Promise<Readable> {
		const res = await axios
			.get(url, {
				responseType: "stream",
				timeout: this.opts.timeout,
				signal,
				maxRedirects: 3,
				headers: {
					"user-agent": UA,
					accept: "*/*",
					"accept-encoding": "identity",
					range: "bytes=0-",
					origin: "https://www.bilibili.com",
					referer: `https://www.bilibili.com/video/${videoId}`,
				},
				validateStatus: (s: number) => s === 200 || s === 206,
				beforeRedirect: (opts: any) => {
					if (!isAllowedMediaUrl(`${opts.protocol}//${opts.hostname}${opts.path}`)) {
						throw new Error("Bilibili: redirect to a disallowed host");
					}
				},
			})
			.catch((err) => {
				if (signal?.aborted) throw err;
				let host = "?";
				try {
					host = new URL(url).hostname;
				} catch {}
				throw this.describeError(`media(${host})`, err);
			});
		return res.data as Readable;
	}
}

export default BilibiliPlugin;
