import { BasePlugin, Track, SearchResult, StreamInfo, Player } from "ziplayer";

import { Innertube, Log } from "youtubei.js";
import {
	createSabrStream,
	createOutputStream,
	createStreamSink,
	DEFAULT_SABR_OPTIONS,
	type StreamResult,
} from "./utils/sabr-stream-factory";
import { webStreamToNodeStream } from "./utils/stream-converter";

export interface PluginOptions {
	player: Player;
	debug?: boolean;
	searchClient?: Innertube;
	client?: Innertube;
}

/**
 * A plugin for handling YouTube audio content including videos, playlists, and search functionality.
 *
 * This plugin provides comprehensive support for:
 * - YouTube video URLs (youtube.com, youtu.be, music.youtube.com)
 * - YouTube playlist URLs and dynamic mixes
 * - YouTube search queries
 * - Audio stream extraction from YouTube videos
 * - Related track recommendations
 *
 * @example
 * const youtubePlugin = new YouTubePlugin();
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   plugins: [youtubePlugin]
 * });
 *
 * // Search for videos
 * const result = await youtubePlugin.search("Never Gonna Give You Up", "user123");
 *
 * // Get audio stream
 * const stream = await youtubePlugin.getStream(result.tracks[0]);
 *
 * @since 1.0.0
 */
export class YouTubePlugin extends BasePlugin {
	name = "youtube";
	version = "1.0.0";

	private client!: Innertube;
	private searchClient!: Innertube;
	private ready: Promise<void>;
	private player: Player | undefined;
	private options: PluginOptions;
	/**
	 * Creates a new YouTubePlugin instance.
	 *
	 * The plugin will automatically initialize YouTube clients for both video playback
	 * and search functionality. Initialization is asynchronous and handled internally.
	 *
	 * @example
	 * const plugin = new YouTubePlugin();
	 * // Plugin is ready to use after initialization completes
	 */
	constructor(options: PluginOptions) {
		super();
		this.player = options?.player ?? undefined;
		this.options = options ?? {};
		this.ready = this.init();
	}

	private async init(): Promise<void> {
		this.client =
			this.options.client ??
			(await Innertube.create({
				client_type: "ANDROID",
				retrieve_player: false,
			} as any));

		// Use a separate web client for search to avoid mobile parser issues
		this.searchClient =
			this.options.searchClient ??
			(await Innertube.create({
				client_type: "WEB",
				retrieve_player: false,
			} as any));
		Log.setLevel(0);
	}

	private debug(message?: any, ...optionalParams: any[]): void {
		if (this.options?.debug && this?.player && this.player?.listenerCount("debug") > 0) {
			this.player.emit("debug", `[YouTubePlugin] ${message}`, ...optionalParams);
		}
	}
	// Build a Track from various YouTube object shapes (search item, playlist item, watch_next feed, basic_info, info)
	private buildTrack(raw: any, requestedBy: string, extra?: { playlist?: string }): Track {
		const pickFirst = (...vals: any[]) => vals.find((v) => v !== undefined && v !== null && v !== "");

		// Try to resolve from multiple common shapes
		const id = pickFirst(
			raw?.id,
			raw?.video_id,
			raw?.videoId,
			raw?.content_id,
			raw?.identifier,
			raw?.basic_info?.id,
			raw?.basic_info?.video_id,
			raw?.basic_info?.videoId,
			raw?.basic_info?.content_id,
		);

		const title = pickFirst(
			raw?.metadata?.title?.text,
			raw?.title?.text,
			raw?.title,
			raw?.headline,
			raw?.basic_info?.title,
			"Unknown title",
		);

		const durationValue = pickFirst(
			raw?.length_seconds,
			raw?.duration?.seconds,
			raw?.duration?.text,
			raw?.duration,
			raw?.length_text,
			raw?.basic_info?.duration,
		);
		const duration = Number(toSeconds(durationValue)) || 0;

		const thumb = pickFirst(
			raw?.thumbnails?.[0]?.url,
			raw?.thumbnail?.[0]?.url,
			raw?.thumbnail?.url,
			raw?.thumbnail?.thumbnails?.[0]?.url,
			raw?.content_image?.image?.[0]?.url,
			raw?.basic_info?.thumbnail?.[0]?.url,
			raw?.basic_info?.thumbnail?.[raw?.basic_info?.thumbnail?.length - 1]?.url,
			raw?.thumbnails?.[raw?.thumbnails?.length - 1]?.url,
		);

		const author = pickFirst(raw?.author?.name, raw?.author, raw?.channel?.name, raw?.owner?.name, raw?.basic_info?.author);

		const views = pickFirst(
			raw?.view_count,
			raw?.views,
			raw?.short_view_count,
			raw?.stats?.view_count,
			raw?.basic_info?.view_count,
		);

		const url = pickFirst(raw?.url, id ? `https://www.youtube.com/watch?v=${id}` : undefined);

		this.debug("Track build:", {
			id: String(id),
			title: String(title),
			url: String(url),
			duration,
			thumbnail: thumb,
			requestedBy,
			source: this.name,
		});
		return {
			id: String(id),
			title: String(title),
			url: String(url),
			duration,
			thumbnail: thumb,
			requestedBy,
			source: this.name,
			metadata: {
				author,
				views,
				...(extra?.playlist ? { playlist: extra.playlist } : {}),
			},
		} as Track;
	}

	/**
	 * Determines if this plugin can handle the given query.
	 *
	 * @param query - The search query or URL to check
	 * @returns `true` if the plugin can handle the query, `false` otherwise
	 *
	 * @example
	 * plugin.canHandle("https://www.youtube.com/watch?v=dQw4w9WgXcQ"); // true
	 * plugin.canHandle("Never Gonna Give You Up"); // true
	 * plugin.canHandle("spotify:track:123"); // false
	 */
	canHandle(query: string): boolean {
		const q = (query || "").trim().toLowerCase();
		const isUrl = q.startsWith("http://") || q.startsWith("https://");
		if (isUrl) {
			try {
				const parsed = new URL(query);
				const allowedHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"];
				return allowedHosts.includes(parsed.hostname.toLowerCase());
			} catch (e) {
				return false;
			}
		}

		// Avoid intercepting explicit patterns for other extractors
		if (q.startsWith("tts:") || q.startsWith("say ")) return false;
		if (q.startsWith("spotify:") || q.includes("open.spotify.com")) return false;
		if (q.includes("soundcloud")) return false;

		// Treat remaining non-URL free text as YouTube-searchable
		return true;
	}

	/**
	 * Validates if a URL is a valid YouTube URL.
	 *
	 * @param url - The URL to validate
	 * @returns `true` if the URL is a valid YouTube URL, `false` otherwise
	 *
	 * @example
	 * plugin.validate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"); // true
	 * plugin.validate("https://youtu.be/dQw4w9WgXcQ"); // true
	 * plugin.validate("https://spotify.com/track/123"); // false
	 */
	validate(url: string): boolean {
		try {
			const parsed = new URL(url);
			const allowedHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "m.youtube.com"];
			return allowedHosts.includes(parsed.hostname.toLowerCase());
		} catch (e) {
			return false;
		}
	}

	/**
	 * Searches for YouTube content based on the given query.
	 *
	 * This method handles both URL-based queries (direct video/playlist links) and
	 * text-based search queries. For URLs, it will extract video or playlist information.
	 * For text queries, it will perform a YouTube search and return up to 10 results.
	 *
	 * @param query - The search query (URL or text)
	 * @param requestedBy - The user ID who requested the search
	 * @returns A SearchResult containing tracks and optional playlist information
	 *
	 * @example
	 * // Search by URL
	 * const result = await plugin.search("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "user123");
	 *
	 * // Search by text
	 * const searchResult = await plugin.search("Never Gonna Give You Up", "user123");
	 * console.log(searchResult.tracks); // Array of Track objects
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		await this.ready;

		if (this.validate(query)) {
			const listId = this.extractListId(query);
			this.debug("List ID:", listId);
			if (listId) {
				if (this.isMixListId(listId)) {
					const anchorVideoId = this.extractVideoId(query);
					if (anchorVideoId) {
						try {
							this.debug("Getting info for anchor video ID:", anchorVideoId);
							const info: any = await (this.searchClient as any).getInfo(anchorVideoId);
							this.debug("Info:", info);
							const feed: any[] = info?.watch_next_feed || [];
							this.debug("Feed:", feed);
							const tracks: Track[] = feed
								.filter((tr: any) => tr?.content_type === "VIDEO")
								.map((v: any) => this.buildTrack(v, requestedBy, { playlist: listId }));
							this.debug("Tracks:", tracks);
							const { basic_info } = info;

							const currTrack = this.buildTrack(basic_info, requestedBy);
							this.debug("Current track:", currTrack);
							tracks.unshift(currTrack);
							this.debug("Tracks:", tracks);
							return {
								tracks,
								playlist: { name: "YouTube Mix", url: query, thumbnail: tracks[0]?.thumbnail },
							};
						} catch {
							// ignore and fall back to normal playlist handling below
						}
					}
				}
				try {
					const playlist: any = await (this.searchClient as any).getPlaylist(listId);
					const videos: any[] = playlist?.videos || playlist?.items || [];
					const tracks: Track[] = videos.map((v: any) => this.buildTrack(v, requestedBy, { playlist: listId }));

					return {
						tracks,
						playlist: {
							name: playlist?.title || playlist?.metadata?.title || `Playlist ${listId}`,
							url: query,
							thumbnail: playlist?.thumbnails?.[0]?.url || playlist?.thumbnail?.url,
						},
					};
				} catch {
					const withoutList = query.replace(/[?&]list=[^&]+/, "").replace(/[?&]$/, "");
					return await this.search(withoutList, requestedBy);
				}
			}

			const videoId = this.extractVideoId(query);
			if (!videoId) throw new Error("Invalid YouTube URL");

			const info = await this.client.getBasicInfo(videoId);
			const track = this.buildTrack(info, requestedBy);
			return { tracks: [track] };
		}

		// Text search → return up to 10 video tracks
		const res: any = await this.searchClient.search(query, {
			type: "video" as any,
		});
		const items: any[] = res?.items || res?.videos || res?.results || [];

		const tracks: Track[] = items.slice(0, 10).map((v: any) => this.buildTrack(v, requestedBy));

		return { tracks };
	}

	/**
	 * Extracts tracks from a YouTube playlist URL.
	 *
	 * @param url - The YouTube playlist URL
	 * @param requestedBy - The user ID who requested the extraction
	 * @returns An array of Track objects from the playlist
	 *
	 * @example
	 * const tracks = await plugin.extractPlaylist(
	 *   "https://www.youtube.com/playlist?list=PLrAXtmRdnEQy6nuLMOV8uM0bMq3MUfHc1",
	 *   "user123"
	 * );
	 * console.log(`Found ${tracks.length} tracks in playlist`);
	 */
	async extractPlaylist(url: string, requestedBy: string): Promise<Track[]> {
		await this.ready;

		const listId = this.extractListId(url);
		if (!listId) return [];

		try {
			// Attempt to handle dynamic Mix playlists via watch_next feed
			if (this.isMixListId(listId)) {
				const anchorVideoId = this.extractVideoId(url);
				if (anchorVideoId) {
					try {
						const info: any = await (this.searchClient as any).getInfo(anchorVideoId);
						const feed: any[] = info?.watch_next_feed || [];
						return feed
							.filter((tr: any) => tr?.content_type === "VIDEO")
							.map((v: any) => this.buildTrack(v, requestedBy, { playlist: listId }));
					} catch {}
				}
			}

			const playlist: any = await (this.client as any).getPlaylist(listId);
			const videos: any[] = playlist?.videos || playlist?.items || [];
			return videos.map((v: any) => {
				return this.buildTrack(v, requestedBy, { playlist: listId }); //ack;
			});
		} catch {
			return [];
		}
	}

	/**
	 * Retrieves the audio stream for a YouTube track using sabr download.
	 *
	 * This method extracts the audio stream from a YouTube video using the sabr download
	 * method which provides better quality and more reliable streaming.
	 *
	 * @param track - The Track object to get the stream for
	 * @returns A StreamInfo object containing the audio stream and metadata
	 * @throws {Error} If the track ID is invalid or stream extraction fails
	 *
	 * @example
	 * const track = { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", ... };
	 * const streamInfo = await plugin.getStream(track);
	 * console.log(streamInfo.type); // "arbitrary"
	 * console.log(streamInfo.stream); // Readable stream
	 */
	async getStream(track: Track): Promise<StreamInfo> {
		await this.ready;

		const id = this.extractVideoId(track.url) || track.id;

		if (!id) throw new Error("Invalid track id");

		try {
			this.debug("🚀 Attempting sabr download for video ID:", id);
			// Use sabr download for better quality and reliability
			const { streamResults } = await createSabrStream(id, DEFAULT_SABR_OPTIONS);
			const { audioStream, selectedFormats, videoTitle } = streamResults;

			this.debug("✅ Sabr download successful, converting Web Stream to Node.js Stream");
			// Convert Web Stream to Node.js Readable Stream
			const nodeStream = webStreamToNodeStream(audioStream);

			this.debug("✅ Stream conversion complete, returning Node.js stream");
			// Return the converted Node.js stream
			return {
				stream: nodeStream,
				type: "arbitrary",
				metadata: {
					...track.metadata,
					itag: selectedFormats.audioFormat.itag,
					mime: selectedFormats.audioFormat.mimeType,
				},
			};
		} catch (e: any) {
			this.debug("⚠️ Sabr download failed, falling back to youtubei.js:", e.message);
			// Fallback to original youtubei.js method if sabr download fails
			try {
				const stream: any = await (this.client as any).download(id, {
					type: "audio",
					quality: "best",
				});

				// Check if it's a Web Stream and convert it
				this.debug("🔍 Checking stream type:", typeof stream, stream?.constructor?.name);
				if (stream && typeof stream.getReader === "function") {
					this.debug("🔄 Converting Web Stream to Node.js Stream");
					const nodeStream = webStreamToNodeStream(stream);
					this.debug("✅ Stream converted successfully");
					return {
						stream: nodeStream,
						type: "arbitrary",
						metadata: track.metadata,
					};
				} else {
					this.debug("⚠️ Stream is not a Web Stream or is null");
				}

				return {
					stream,
					type: "arbitrary",
					metadata: track.metadata,
				};
			} catch (fallbackError: any) {
				try {
					const info: any = await (this.client as any).getBasicInfo(id);

					// Prefer m4a audio-only formats first
					let format: any = info?.chooseFormat?.({
						type: "audio",
						quality: "best",
					});
					if (!format && info?.formats?.length) {
						const audioOnly = info.formats.filter((f: any) => f.mime_type?.includes("audio"));
						audioOnly.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
						format = audioOnly[0];
					}

					if (!format) throw new Error("No audio format available");

					let url: string | undefined = undefined;
					if (typeof format.decipher === "function") {
						url = format.decipher((this.client as any).session.player);
					}
					if (!url) url = format.url;

					if (!url) throw new Error("No valid URL to decipher");
					const res = await fetch(url);

					if (!res.ok || !res.body) {
						throw new Error(`HTTP ${res.status}`);
					}

					// Convert Web Stream to Node.js Stream
					this.debug("🔄 Converting fetch response Web Stream to Node.js Stream");
					const nodeStream = webStreamToNodeStream(res.body);

					return {
						stream: nodeStream,
						type: "arbitrary",
						metadata: {
							...track.metadata,
							itag: format.itag,
							mime: format.mime_type,
						},
					};
				} catch (inner: any) {
					throw new Error(`Failed to get YouTube stream: ${inner?.message || inner}`);
				}
			}
		}
	}

	/**
	 * Gets related tracks for a given YouTube video.
	 *
	 * This method fetches the "watch next" feed from YouTube to find related videos
	 * that are similar to the provided track. It can filter out tracks that are
	 * already in the history to avoid duplicates.
	 *
	 * @param trackURL - The YouTube video URL to get related tracks for
	 * @param opts - Options for filtering and limiting results
	 * @param opts.limit - Maximum number of related tracks to return (default: 5)
	 * @param opts.offset - Number of tracks to skip from the beginning (default: 0)
	 * @param opts.history - Array of tracks to exclude from results
	 * @returns An array of related Track objects
	 *
	 * @example
	 * const related = await plugin.getRelatedTracks(
	 *   "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	 *   { limit: 3, history: [currentTrack] }
	 * );
	 * console.log(`Found ${related.length} related tracks`);
	 */
	async getRelatedTracks(trackURL: string, opts: { limit?: number; offset?: number; history?: Track[] } = {}): Promise<Track[]> {
		await this.ready;
		this.debug("Getting related tracks for:", trackURL);
		const videoId = this.extractVideoId(trackURL);
		this.debug("Video ID:", videoId);
		if (!videoId) {
			// If the last track URL is not a direct video URL (e.g., playlist URL),
			// we cannot fetch related videos reliably.
			return [];
		}
		this.debug("Getting info for video ID:", videoId);
		const info: any = await await (this.searchClient as any).getInfo(videoId);
		const related: any[] = info?.watch_next_feed || [];
		this.debug("Related:", related);
		const offset = opts.offset ?? 0;
		const limit = opts.limit ?? 5;

		const relatedfilter = related.filter(
			(tr: any) => tr.content_type === "VIDEO" && !(opts?.history ?? []).some((t) => t.url === tr.url),
		);

		return relatedfilter.slice(offset, offset + limit).map((v: any) => this.buildTrack(v, "auto"));
	}

	/**
	 * Provides a fallback stream by searching for the track title.
	 *
	 * This method is used when the primary stream extraction fails. It performs
	 * a search using the track's title and attempts to get a stream from the
	 * first search result.
	 *
	 * @param track - The Track object to get a fallback stream for
	 * @returns A StreamInfo object containing the fallback audio stream
	 * @throws {Error} If no fallback track is found or stream extraction fails
	 *
	 * @example
	 * try {
	 *   const stream = await plugin.getStream(track);
	 * } catch (error) {
	 *   // Try fallback
	 *   const fallbackStream = await plugin.getFallback(track);
	 * }
	 */
	async getFallback(track: Track): Promise<StreamInfo> {
		try {
			const result = await this.search(track.title, track.requestedBy);
			const first = result.tracks[0];
			this.debug("Fallback track:", first);
			if (!first) throw new Error("No fallback track found");
			return await this.getStream(first);
		} catch (e: any) {
			throw new Error(`YouTube fallback search failed: ${e?.message || e}`);
		}
	}

	private extractVideoId(input: string): string | null {
		try {
			const u = new URL(input);
			const allowedShortHosts = ["youtu.be"];
			const allowedLongHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"];
			if (allowedShortHosts.includes(u.hostname)) {
				return u.pathname.split("/").filter(Boolean)[0] || null;
			}
			if (allowedLongHosts.includes(u.hostname)) {
				// watch?v=, shorts/, embed/
				if (u.searchParams.get("v")) return u.searchParams.get("v");
				const path = u.pathname;
				if (path.startsWith("/shorts/")) return path.replace("/shorts/", "");
				if (path.startsWith("/embed/")) return path.replace("/embed/", "");
			}
			return null;
		} catch {
			return null;
		}
	}

	private isMixListId(listId: string): boolean {
		// YouTube dynamic mixes typically start with 'RD'
		return typeof listId === "string" && listId.toUpperCase().startsWith("RD");
	}

	private extractListId(input: string): string | null {
		try {
			const u = new URL(input);
			return u.searchParams.get("list");
		} catch {
			return null;
		}
	}
}
function toSeconds(d: any): number | undefined {
	if (typeof d === "number") return d;
	if (typeof d === "string") {
		// mm:ss or hh:mm:ss
		const parts = d.split(":").map(Number);
		if (parts.some((n) => Number.isNaN(n))) return undefined;
		if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
		if (parts.length === 2) return parts[0] * 60 + parts[1];
		const asNum = Number(d);
		return Number.isFinite(asNum) ? asNum : undefined;
	}
	if (d && typeof d === "object") {
		if (typeof (d as any).seconds === "number") return (d as any).seconds;
		if (typeof (d as any).milliseconds === "number") return Math.floor((d as any).milliseconds / 1000);
	}
	return undefined;
}
