import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

import SoundCloud from "@zibot/scdl";
import { URL } from "url";

function isValidSoundCloudHost(maybeUrl: string): boolean {
	const ALLOWED_SOUNDCLOUD_HOSTS = ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"];

	try {
		const parsed = new URL(maybeUrl);
		return !!ALLOWED_SOUNDCLOUD_HOSTS.includes(parsed.hostname);
	} catch {
		// Not a valid URL, not handled as host-based
		return false;
	}
}
/**
 * A plugin for handling SoundCloud audio content including tracks, playlists, and search functionality.
 *
 * This plugin provides comprehensive support for:
 * - SoundCloud track URLs (soundcloud.com)
 * - SoundCloud playlist URLs
 * - SoundCloud search queries
 * - Audio stream extraction from SoundCloud tracks
 * - Related track recommendations
 *
 * @example
 *
 * const soundcloudPlugin = new SoundCloudPlugin();
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   plugins: [soundcloudPlugin]
 * });
 *
 * // Search for tracks
 * const result = await soundcloudPlugin.search("chill music", "user123");
 *
 * // Get audio stream
 * const stream = await soundcloudPlugin.getStream(result.tracks[0]);
 *
 * @since 1.0.0
 */
export class SoundCloudPlugin extends BasePlugin {
	name = "soundcloud";
	version = "1.2.0";
	private client!: SoundCloud;
	private ready: Promise<void>;

	/**
	 * Creates a new SoundCloudPlugin instance.
	 *
	 * The plugin will automatically initialize the SoundCloud client for track
	 * and playlist operations. Initialization is asynchronous and handled internally.
	 *
	 * @example
	 * const plugin = new SoundCloudPlugin();
	 * // Plugin is ready to use after initialization completes
	 */
	constructor() {
		super();
		this.client = new SoundCloud();
		this.ready = this.init();
	}

	private async init(): Promise<void> {
		await this.client.init();
	}

	/**
	 * Determines if this plugin can handle the given query.
	 *
	 * @param query - The search query or URL to check
	 * @returns `true` if the plugin can handle the query, `false` otherwise
	 *
	 * @example
	 * plugin.canHandle("https://soundcloud.com/artist/track"); // true
	 * plugin.canHandle("chill music"); // true
	 * plugin.canHandle("spotify:track:123"); // false
	 */
	canHandle(query: string): boolean {
		const q = (query || "").trim().toLowerCase();
		const isUrl = q.startsWith("http://") || q.startsWith("https://");
		if (isUrl) {
			return isValidSoundCloudHost(query);
		}

		if (q.startsWith("soundcloud:") || q.startsWith("sc:")) return true;

		if (q.startsWith("tts:"))
			// Avoid intercepting explicit patterns for other extractors
			return false;
		if (q.startsWith("spotify:") || q.includes("open.spotify.com")) return false;
		if (q.includes("youtube")) return false;

		// Treat remaining non-URL free text as searchable
		return true;
	}

	/**
	 * Validates if a URL is a valid SoundCloud URL.
	 *
	 * @param url - The URL to validate
	 * @returns `true` if the URL is a valid SoundCloud URL, `false` otherwise
	 *
	 * @example
	 * plugin.validate("https://soundcloud.com/artist/track"); // true
	 * plugin.validate("https://www.soundcloud.com/artist/track"); // true
	 * plugin.validate("https://youtube.com/watch?v=123"); // false
	 */
	validate(url: string): boolean {
		return isValidSoundCloudHost(url);
	}

	/**
	 * Searches for SoundCloud content based on the given query.
	 *
	 * This method handles both URL-based queries (direct track/playlist links) and
	 * text-based search queries. For URLs, it will extract track or playlist information.
	 * For text queries, it will perform a SoundCloud search and return up to 10 results.
	 *
	 * @param query - The search query (URL or text)
	 * @param requestedBy - The user ID who requested the search
	 * @returns A SearchResult containing tracks and optional playlist information
	 *
	 * @example
	 * // Search by URL
	 * const result = await plugin.search("https://soundcloud.com/artist/track", "user123");
	 *
	 * // Search by text
	 * const searchResult = await plugin.search("chill music", "user123");
	 * console.log(searchResult.tracks); // Array of Track objects
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		await this.ready;

		// If the query is a URL but not a SoundCloud URL, do not handle it here
		// This prevents hijacking e.g. YouTube/Spotify links as free-text searches.
		try {
			const q = (query || "").trim().toLowerCase();
			const isUrl = q.startsWith("http://") || q.startsWith("https://");
			if (isUrl && !this.validate(query)) {
				return { tracks: [] };
			}
		} catch {}

		try {
			if (isValidSoundCloudHost(query)) {
				try {
					const info = await this.client.getTrackDetails(query);
					const track: Track = {
						id: info.id.toString(),
						title: info.title,
						url: info.permalink_url || query,
						duration: info.duration,
						thumbnail: info.artwork_url ?? undefined,
						requestedBy,
						source: this.name,
						metadata: {
							author: info.user?.username,
							plays: info.playback_count,
						},
					};
					return { tracks: [track] };
				} catch {
					const playlist = await this.client.getPlaylistDetails(query);
					const tracks: Track[] = playlist.tracks.map((t: any) => ({
						id: t.id.toString(),
						title: t.title,
						url: t.permalink_url,
						duration: t.duration,
						thumbnail: t.artwork_url || playlist.artwork_url,
						requestedBy,
						source: this.name,
						metadata: {
							author: t.user?.username,
							plays: t.playback_count,
							playlist: playlist.id?.toString(),
						},
					}));

					return {
						tracks,
						playlist: {
							name: playlist.title,
							url: playlist.permalink_url || query,
							thumbnail: playlist?.artwork_url ?? undefined,
						},
					};
				}
			}

			const results = await this.client.search({ query, limit: 15 });
			const tracks: Track[] = results.slice(0, 10).map((track: any) => ({
				id: track.id.toString(),
				title: track.title,
				url: track.permalink_url,
				duration: track.duration,
				thumbnail: track.artwork_url,
				requestedBy,
				source: this.name,
				metadata: {
					author: track.user?.username,
					plays: track.playback_count,
				},
			}));

			return { tracks };
		} catch (error: any) {
			throw new Error(`SoundCloud search failed: ${error?.message}`);
		}
	}

	/**
	 * Retrieves the audio stream for a SoundCloud track.
	 *
	 * This method downloads the audio stream from SoundCloud using the track's URL.
	 * It handles the SoundCloud-specific download process and returns the stream
	 * in a format compatible with the player.
	 *
	 * @param track - The Track object to get the stream for
	 * @returns A StreamInfo object containing the audio stream and metadata
	 * @throws {Error} If the track URL is invalid or stream download fails
	 *
	 * @example
	 * const track = { id: "123", title: "Track Title", url: "https://soundcloud.com/artist/track", ... };
	 * const streamInfo = await plugin.getStream(track);
	 * console.log(streamInfo.type); // "arbitrary"
	 * console.log(streamInfo.stream); // Readable stream
	 */
	async getStream(track: Track): Promise<StreamInfo> {
		await this.ready;

		try {
			const stream = await this.client.downloadTrack(track.url);
			if (!stream) {
				throw new Error("SoundCloud download returned null");
			}

			return {
				stream,
				type: "arbitrary",
				metadata: track.metadata,
			};
		} catch (error: any) {
			throw new Error(`Failed to get SoundCloud stream: ${error.message}`);
		}
	}

	/**
	 * Gets related tracks for a given SoundCloud track.
	 *
	 * This method fetches related tracks from SoundCloud's recommendation system
	 * based on the provided track URL or ID. It can filter out tracks that are
	 * already in the history to avoid duplicates.
	 *
	 * @param trackURL - The SoundCloud track URL or ID to get related tracks for
	 * @param opts - Options for filtering and limiting results
	 * @param opts.limit - Maximum number of related tracks to return (default: 1)
	 * @param opts.offset - Number of tracks to skip from the beginning (default: 0)
	 * @param opts.history - Array of tracks to exclude from results
	 * @returns An array of related Track objects
	 *
	 * @example
	 * const related = await plugin.getRelatedTracks(
	 *   "https://soundcloud.com/artist/track",
	 *   { limit: 3, history: [currentTrack] }
	 * );
	 * console.log(`Found ${related.length} related tracks`);
	 */
	async getRelatedTracks(
		track: string | number | Track,
		opts: { limit?: number; offset?: number; history?: Track[] } = {},
	): Promise<Track[]> {
		await this.ready;
		try {
			const trackURL = (track as Track)?.url ?? track;
			const trackTitle = (track as Track)?.title ?? track;
			let tracks;
			if (this.validate(trackURL)) {
				tracks = await this.client.getRelatedTracks(trackURL, {
					limit: 30,
				});
			}
			// If no related tracks found, try searching by title as fallback
			if (!tracks || !tracks?.length) {
				const SearchTrack = await this.search(trackTitle, "SoundCloud_Related");

				if (!SearchTrack || !SearchTrack.tracks?.length) {
					return [];
				}
				tracks = await this.client.getRelatedTracks(SearchTrack.tracks[0].url, {
					limit: 30,
				});
			}

			if (!tracks || !tracks?.length) {
				return [];
			}

			const relatedfilter = tracks.filter((tr: any) => !(opts?.history ?? []).some((t) => t.url === tr.permalink_url));

			const related = relatedfilter.slice(0, opts.limit || 1);

			return related.map((t: any) => ({
				id: t.id.toString(),
				title: t.title,
				url: t.permalink_url,
				duration: t.duration,
				thumbnail: t.artwork_url,
				requestedBy: "auto",
				source: this.name,
				metadata: {
					author: t.user?.username,
					plays: t.playback_count,
				},
			}));
		} catch {
			return [];
		}
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
		const trackfall = await this.search(track.title, track.requestedBy);
		const fallbackTrack = trackfall.tracks?.[0];
		if (!fallbackTrack) {
			throw new Error(`No fallback track found for ${track.title}`);
		}
		return await this.getStream(fallbackTrack);
	}

	/**
	 * Extracts tracks from a SoundCloud playlist URL.
	 *
	 * @param url - The SoundCloud playlist URL
	 * @param requestedBy - The user ID who requested the extraction
	 * @returns An array of Track objects from the playlist
	 *
	 * @example
	 * const tracks = await plugin.extractPlaylist(
	 *   "https://soundcloud.com/artist/sets/playlist-name",
	 *   "user123"
	 * );
	 * console.log(`Found ${tracks.length} tracks in playlist`);
	 */
	async extractPlaylist(url: string, requestedBy: string): Promise<Track[]> {
		await this.ready;
		try {
			const playlist = await this.client.getPlaylistDetails(url);
			return playlist.tracks.map((t: any) => ({
				id: t.id.toString(),
				title: t.title,
				url: t.permalink_url,
				duration: t.duration,
				thumbnail: t.artwork_url || playlist.artwork_url,
				requestedBy,
				source: this.name,
				metadata: {
					author: t.user?.username,
					plays: t.playback_count,
					playlist: playlist.id?.toString(),
				},
			}));
		} catch {
			return [];
		}
	}
}
