import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";
import { Readable } from "stream";
import { getTTSUrls } from "@zibot/zitts";
import axios from "axios";
import { parseBuffer } from "music-metadata";

/**
 * Configuration options for the TTSPlugin.
 */
export interface TTSPluginOptions {
	/** Default language code for TTS (e.g., "vi", "en", "en-US") */
	defaultLang?: string;
	/** Whether to use slow speech rate */
	slow?: boolean;
	/**
	 * Optional custom TTS hook. If provided, it will be used to
	 * create the audio stream for the given text instead of the
	 * built-in Google TTS wrapper.
	 *
	 * @param text - The text to convert to speech
	 * @param ctx - Context information including language, speed, and track
	 * @returns One of:
	 * - Node Readable (preferred)
	 * - HTTP(S) URL string or URL object
	 * - Buffer / Uint8Array / ArrayBuffer
	 * - Or an object with { stream, type } | { url, type }
	 */
	createStream?: (
		text: string,
		ctx?: { lang: string; slow: boolean; track?: Track },
	) =>
		| Promise<Readable | string | URL | Buffer | Uint8Array | ArrayBuffer>
		| Readable
		| string
		| URL
		| Buffer
		| Uint8Array
		| ArrayBuffer;
}

/**
 * Internal configuration for TTS processing.
 */
interface TTSConfig {
	/** The text to convert to speech */
	text: string;
	/** The language code for TTS */
	lang: string;
	/** Whether to use slow speech rate */
	slow: boolean;
}

/**
 * A plugin for Text-to-Speech (TTS) functionality.
 *
 * This plugin provides support for:
 * - Converting text to speech using Google TTS
 * - Custom TTS providers via the createStream hook
 * - Multiple language support
 * - Configurable speech rate (normal/slow)
 * - TTS query parsing with language and speed options
 * - Accurate duration analysis by generating sample audio
 *
 * @example
 * const ttsPlugin = new TTSPlugin({
 *   defaultLang: "en",
 *   slow: false
 * });
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   plugins: [ttsPlugin]
 * });
 *
 * // Search for TTS content
 * const result = await ttsPlugin.search("tts:Hello world", "user123");
 * const stream = await ttsPlugin.getStream(result.tracks[0]);
 *
 * @example
 * // Custom TTS provider
 * const customTTSPlugin = new TTSPlugin({
 *   defaultLang: "en",
 *   createStream: async (text, ctx) => {
 *     // Custom TTS implementation
 *     return customTTSProvider.synthesize(text, ctx.lang);
 *   }
 * });
 *
 * @since 1.0.0
 */
export class TTSPlugin extends BasePlugin {
	name = "tts";
	version = "1.0.0";
	private opts: { defaultLang: string; slow: boolean; createStream?: TTSPluginOptions["createStream"] };

	/**
	 * Creates a new TTSPlugin instance.
	 *
	 * @param opts - Configuration options for the TTS plugin
	 * @param opts.defaultLang - Default language code for TTS (default: "vi")
	 * @param opts.slow - Whether to use slow speech rate (default: false)
	 * @param opts.createStream - Optional custom TTS provider function
	 *
	 * @example
	 * // Basic TTS with Vietnamese as default
	 * const ttsPlugin = new TTSPlugin();
	 *
	 * // TTS with English as default and slow speech
	 * const slowTTSPlugin = new TTSPlugin({
	 *   defaultLang: "en",
	 *   slow: true
	 * });
	 *
	 * // TTS with custom provider
	 * const customTTSPlugin = new TTSPlugin({
	 *   defaultLang: "en",
	 *   createStream: async (text, ctx) => {
	 *     return await myCustomTTS.synthesize(text, ctx.lang);
	 *   }
	 * });
	 */
	constructor(opts?: TTSPluginOptions) {
		super();
		this.opts = {
			defaultLang: opts?.defaultLang || "vi",
			slow: !!opts?.slow,
			createStream: opts?.createStream,
		};
	}

	/**
	 * Determines if this plugin can handle the given query.
	 *
	 * @param query - The search query to check
	 * @returns `true` if the query starts with "tts:" or "say ", `false` otherwise
	 *
	 * @example
	 * plugin.canHandle("tts:Hello world"); // true
	 * plugin.canHandle("say Hello world"); // true
	 * plugin.canHandle("youtube.com/watch?v=123"); // false
	 */
	canHandle(query: string): boolean {
		if (!query) return false;
		const q = query.trim().toLowerCase();
		return q.startsWith("tts:") || q.startsWith("say ");
	}

	/**
	 * Creates a TTS track from the given query.
	 *
	 * This method parses TTS queries and creates a track that can be played as audio.
	 * It supports various query formats including language and speed specifications.
	 *
	 * @param query - The TTS query to process
	 * @param requestedBy - The user ID who requested the TTS
	 * @returns A SearchResult containing a single TTS track
	 *
	 * @example
	 * // Basic TTS
	 * const result = await plugin.search("tts:Hello world", "user123");
	 *
	 * // TTS with specific language
	 * const result2 = await plugin.search("tts:en:Hello world", "user123");
	 *
	 * // TTS with language and slow speed
	 * const result3 = await plugin.search("tts:en:true:Hello world", "user123");
	 *
	 * // Using "say" prefix
	 * const result4 = await plugin.search("say Hello world", "user123");
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (!this.canHandle(query)) {
			return { tracks: [] };
		}
		const { text, lang, slow } = this.parseQuery(query);
		const config: TTSConfig = { text, lang, slow };
		const url = this.encodeConfig(config);
		const title = `TTS (${lang}${slow ? ", slow" : ""}): ${text.slice(0, 64)}${text.length > 64 ? "…" : ""}`;

		// Analyze actual TTS duration
		let duration: number;
		try {
			duration = await this.analyzeTTSDuration(text, lang, slow);
		} catch (error) {
			// Fallback to estimation if analysis fails
			duration = this.estimateDuration(text);
		}

		const track: Track = {
			id: `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			title,
			url,
			duration,
			requestedBy,
			source: this.name,
			metadata: {
				tts: config,
				analyzedDuration: true,
				textLength: text.length,
				language: lang,
				slowMode: slow,
			},
		};

		return { tracks: [track] };
	}

	/**
	 * Analyzes TTS audio duration by generating a small sample and measuring its length.
	 *
	 * @param text - The text to analyze
	 * @param lang - The language code
	 * @param slow - Whether to use slow speech rate
	 * @returns Promise containing duration in seconds
	 */
	private async analyzeTTSDuration(text: string, lang: string, slow: boolean): Promise<number> {
		try {
			// Use a shorter sample text for duration analysis to minimize processing time
			const sampleText = text.length > 50 ? text.slice(0, 50) + "..." : text;

			const urls = getTTSUrls(sampleText, { lang, slow });
			if (!urls || urls.length === 0) {
				return this.estimateDuration(text);
			}

			// Download the sample audio
			const parts = await Promise.all(
				urls.map((u) => axios.get<ArrayBuffer>(u, { responseType: "arraybuffer" }).then((r) => Buffer.from(r.data))),
			);

			const merged = Buffer.concat(parts);

			// Parse metadata to get actual duration
			const metadata = await parseBuffer(merged);
			const actualDuration = metadata.format.duration || 0;

			// Calculate ratio and apply to full text
			const sampleRatio = sampleText.length / text.length;
			const estimatedDuration = actualDuration / sampleRatio;

			return Math.round(estimatedDuration);
		} catch (error) {
			// Fallback to text-based estimation
			return this.estimateDuration(text);
		}
	}

	/**
	 * Estimates TTS duration based on text length and language.
	 *
	 * @param text - The text to estimate duration for
	 * @returns Estimated duration in seconds
	 */
	private estimateDuration(text: string): number {
		// Base estimation: ~12 characters per second for normal speech
		// Adjust based on text complexity and language
		const baseRate = 12; // characters per second
		const wordCount = text.split(/\s+/).length;
		const charCount = text.length;

		// Use word count for better estimation
		const estimatedSeconds = Math.max(1, Math.min(300, Math.ceil(wordCount / 2.5)));

		return estimatedSeconds;
	}

	/**
	 * Generates an audio stream for a TTS track.
	 *
	 * This method converts the text in the track to speech using either the custom
	 * TTS provider (if configured) or the built-in Google TTS service. It handles
	 * various return types from custom providers and ensures proper stream formatting.
	 *
	 * @param track - The TTS track to convert to audio
	 * @returns A StreamInfo object containing the audio stream
	 * @throws {Error} If TTS generation fails or no audio URLs are returned
	 *
	 * @example
	 * const track = { id: "tts-123", title: "TTS: Hello world", ... };
	 * const streamInfo = await plugin.getStream(track);
	 * console.log(streamInfo.type); // "arbitrary"
	 * console.log(streamInfo.stream); // Readable stream with audio
	 */
	async getStream(track: Track): Promise<StreamInfo> {
		const cfg = this.extractConfig(track);
		if (track.source !== this.name) return { stream: null as any, type: "arbitrary" };
		if (this.opts.createStream && typeof this.opts.createStream === "function") {
			const out = await this.opts.createStream(cfg.text, { lang: cfg.lang, slow: cfg.slow, track });
			let type: StreamInfo["type"] | undefined;
			let metadata: Record<string, any> | undefined;
			let stream: Readable | null = null;

			const normType = (t?: any): StreamInfo["type"] | undefined => {
				if (!t || typeof t !== "string") return undefined;
				const v = t.toLowerCase();
				if (v.includes("webm") && v.includes("opus")) return "webm/opus";
				if (v.includes("ogg") && v.includes("opus")) return "ogg/opus";
				return undefined;
			};

			if (out && typeof out === "object") {
				// If it's already a Readable/Buffer/Uint8Array/ArrayBuffer/URL, let toReadable handle it
				if (
					out instanceof Readable ||
					out instanceof Buffer ||
					out instanceof Uint8Array ||
					out instanceof ArrayBuffer ||
					out instanceof URL
				) {
					stream = await this.toReadable(out as any);
				} else if ((out as any).stream) {
					const o = out as any;
					stream = o.stream as Readable;
					type = normType(o.type);
					metadata = o.metadata;
				} else if ((out as any).url) {
					const o = out as any;
					const urlStr = o.url.toString();
					try {
						type =
							normType(o.type) || (urlStr.endsWith(".webm") ? "webm/opus" : urlStr.endsWith(".ogg") ? "ogg/opus" : undefined);
						const res = await axios.get(urlStr, { responseType: "stream" });
						stream = res.data as unknown as Readable;
						metadata = o.metadata;
					} catch (e) {
						throw new Error(`Failed to fetch custom TTS URL: ${e}`);
					}
				}
			}

			if (!stream) {
				stream = await this.toReadable(out as any);
			}
			return { stream, type: type || "arbitrary", metadata: { provider: "custom", ...(metadata || {}) } };
		}

		const urls = getTTSUrls(cfg.text, { lang: cfg.lang, slow: cfg.slow });
		if (!urls || urls.length === 0) {
			throw new Error("TTS returned no audio URLs");
		}

		const parts = await Promise.all(
			urls.map((u) => axios.get<ArrayBuffer>(u, { responseType: "arraybuffer" }).then((r) => Buffer.from(r.data))),
		);

		const merged = Buffer.concat(parts);
		const stream = Readable.from([merged]);
		return { stream, type: "arbitrary", metadata: { size: merged.length } };
	}

	private async toReadable(out: Readable | string | URL | Buffer | Uint8Array | ArrayBuffer): Promise<Readable> {
		if (out instanceof Readable) return out;
		if (typeof out === "string" || out instanceof URL) {
			const url = out instanceof URL ? out.toString() : out;
			if (/^https?:\/\//i.test(url)) {
				const res = await axios.get(url, { responseType: "stream" });
				return res.data as unknown as Readable;
			}
			return Readable.from([Buffer.from(url)]);
		}
		if (out instanceof Buffer) return Readable.from([out]);
		if (out instanceof Uint8Array) return Readable.from([Buffer.from(out)]);
		if (out instanceof ArrayBuffer) return Readable.from([Buffer.from(out)]);
		throw new Error("Unsupported return type from createStream");
	}

	private parseQuery(query: string): TTSConfig {
		const isLangCode = (s: string) => /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(s);

		const raw = query.trim();
		let text = raw;
		let lang = this.opts.defaultLang;
		let slow = this.opts.slow;

		const lower = raw.toLowerCase();
		if (lower.startsWith("say ")) {
			text = raw.slice(4).trim();
		} else if (lower.startsWith("tts:")) {
			const body = raw.slice(4).trim();
			// Supported:
			// - "tts: <text>" (text may contain colons)
			// - "tts:<lang>:<text>"
			// - "tts:<lang>:<slow>:<text>" where slow in {0,1,true,false}
			const firstSep = body.indexOf(":");
			if (firstSep === -1) {
				text = body;
			} else {
				const maybeLang = body.slice(0, firstSep).trim();
				const rest = body.slice(firstSep + 1).trim();
				if (isLangCode(maybeLang)) {
					lang = maybeLang;
					const secondSep = rest.indexOf(":");
					if (secondSep !== -1) {
						const maybeSlow = rest.slice(0, secondSep).trim().toLowerCase();
						const remaining = rest.slice(secondSep + 1).trim();
						if (["0", "1", "true", "false"].includes(maybeSlow)) {
							slow = maybeSlow === "1" || maybeSlow === "true";
							text = remaining;
						} else {
							text = rest;
						}
					} else {
						text = rest;
					}
				} else {
					text = body;
				}
			}
		}

		text = (text || "").trim();
		if (!text) throw new Error("No text provided for TTS");
		return { text, lang, slow };
	}

	private encodeConfig(cfg: TTSConfig): string {
		const payload = encodeURIComponent(JSON.stringify(cfg));
		return `tts://${payload}`;
	}

	private extractConfig(track: Track): TTSConfig {
		const meta = (track.metadata as any)?.tts as TTSConfig | undefined;
		if (meta && meta.text) return meta;
		try {
			const url = track.url || "";
			const encoded = url.startsWith("tts://") ? url.slice("tts://".length) : url;
			const cfg = JSON.parse(decodeURIComponent(encoded));
			return { text: cfg.text, lang: cfg.lang || this.opts.defaultLang, slow: !!cfg.slow };
		} catch {
			return { text: track.title || "", lang: this.opts.defaultLang, slow: this.opts.slow };
		}
	}
}
