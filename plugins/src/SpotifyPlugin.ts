import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

/**
 * A minimal Spotify plugin for metadata extraction and display purposes.
 *
 * This plugin provides support for:
 * - Spotify track URLs/URIs (spotify:track:...)
 * - Spotify playlist URLs/URIs (spotify:playlist:...)
 * - Spotify album URLs/URIs (spotify:album:...)
 * - Metadata extraction using Spotify's public oEmbed endpoint
 *
 * **Important Notes:**
 * - This plugin does NOT provide audio streams (player is expected to redirect/fallback upstream)
 * - This plugin does NOT expand playlists/albums (no SDK; oEmbed doesn't enumerate items)
 * - This plugin only provides display metadata for Spotify content
 *
 * @example
 *
 * const spotifyPlugin = new SpotifyPlugin();
 *
 * // Add to PlayerManager
 * const manager = new PlayerManager({
 *   plugins: [spotifyPlugin]
 * });
 *
 * // Get metadata for a Spotify track
 * const result = await spotifyPlugin.search("spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "user123");
 * console.log(result.tracks[0].metadata); // Contains Spotify metadata
 *
 *
 * @since 1.1.0
 */
export class SpotifyPlugin extends BasePlugin {
	name = "spotify";
	version = "1.1.0";
	priority = 1; // Higher priority to handle Spotify URLs before more generic plugins
	/**
	 * Determines if this plugin can handle the given query.
	 *
	 * @param query - The search query or URL to check
	 * @returns `true` if the query is a Spotify URL/URI, `false` otherwise
	 *
	 * @example
	 *
	 * plugin.canHandle("spotify:track:4iV5W9uYEdYUVa79Axb7Rh"); // true
	 * plugin.canHandle("https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh"); // true
	 * plugin.canHandle("youtube.com/watch?v=123"); // false
	 *
	 */
	canHandle(query: string): boolean {
		const q = query.toLowerCase().trim();
		if (q.startsWith("spotify:")) return true;
		try {
			const u = new URL(q);
			return u.hostname === "open.spotify.com";
		} catch {
			return false;
		}
	}

	/**
	 * Validates if a URL/URI is a valid Spotify URL/URI.
	 *
	 * @param url - The URL/URI to validate
	 * @returns `true` if the URL/URI is a valid Spotify URL/URI, `false` otherwise
	 *
	 * @example
	 *
	 * plugin.validate("spotify:track:4iV5W9uYEdYUVa79Axb7Rh"); // true
	 * plugin.validate("https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh"); // true
	 * plugin.validate("https://youtube.com/watch?v=123"); // false
	 *
	 */
	validate(url: string): boolean {
		if (url.startsWith("spotify:")) return true;
		try {
			const u = new URL(url);
			return u.hostname === "open.spotify.com";
		} catch {
			return false;
		}
	}

	/**
	 * Extracts metadata from Spotify URLs/URIs using the oEmbed API.
	 *
	 * This method handles Spotify track, playlist, and album URLs/URIs by fetching
	 * display metadata from Spotify's public oEmbed endpoint. It does not provide
	 * audio streams or expand playlists/albums.
	 *
	 * @param query - The Spotify URL/URI to extract metadata from
	 * @param requestedBy - The user ID who requested the extraction
	 * @returns A SearchResult containing a single track with metadata (no audio stream)
	 *
	 * @example
	 *
	 * // Extract track metadata
	 * const result = await plugin.search("spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "user123");
	 * console.log(result.tracks[0].metadata); // Contains Spotify metadata
	 *
	 * // Extract playlist metadata
	 * const playlistResult = await plugin.search("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "user123");
	 * console.log(playlistResult.tracks[0].metadata.kind); // "playlist"
	 *
	 */
	async search(query: string, requestedBy: string): Promise<SearchResult> {
		if (!this.validate(query)) {
			return { tracks: [] };
		}

		const kind = this.identifyKind(query);

		if (kind === "track") {
			const t = await this.buildTrackFromUrlOrUri(query, requestedBy);
			return { tracks: t ? [t] : [] };
		}

		if (kind === "playlist") {
			const t = await this.buildHeaderItem(query, requestedBy, "playlist");
			return { tracks: t ? [t] : [] };
		}

		if (kind === "album") {
			const t = await this.buildHeaderItem(query, requestedBy, "album");
			return { tracks: t ? [t] : [] };
		}

		return { tracks: [] };
	}

	/**
	 * Extracts tracks from a Spotify playlist URL.
	 *
	 * **Note:** This method is not implemented as this plugin does not support
	 * playlist expansion. It always returns an empty array.
	 *
	 * @param _input - The Spotify playlist URL (unused)
	 * @param _requestedBy - The user ID who requested the extraction (unused)
	 * @returns An empty array (playlist expansion not supported)
	 *
	 * @example
	 *
	 * const tracks = await plugin.extractPlaylist("spotify:playlist:123", "user123");
	 * console.log(tracks); // [] - empty array
	 *
	 */
	async extractPlaylist(_input: string, _requestedBy: string): Promise<Track[]> {
		return [];
	}

	/**
	 * Extracts tracks from a Spotify album URL.
	 *
	 * **Note:** This method is not implemented as this plugin does not support
	 * album expansion. It always returns an empty array.
	 *
	 * @param _input - The Spotify album URL (unused)
	 * @param _requestedBy - The user ID who requested the extraction (unused)
	 * @returns An empty array (album expansion not supported)
	 *
	 * @example
	 *
	 * const tracks = await plugin.extractAlbum("spotify:album:123", "user123");
	 * console.log(tracks); // [] - empty array
	 *
	 */
	async extractAlbum(_input: string, _requestedBy: string): Promise<Track[]> {
		return [];
	}

	/**
	 * Attempts to get an audio stream for a Spotify track.
	 *
	 * **Note:** This method always throws an error as this plugin does not support
	 * audio streaming. The player is expected to redirect to other plugins or
	 * use fallback mechanisms for actual audio playback.
	 *
	 * @param _track - The Track object (unused)
	 * @throws {Error} Always throws "Spotify streaming is not supported by this plugin"
	 *
	 * @example
	 *
	 * try {
	 *   const stream = await plugin.getStream(track);
	 * } catch (error) {
	 *   console.log(error.message); // "Spotify streaming is not supported by this plugin"
	 * }
	 *
	 */
	async getStream(_track: Track): Promise<StreamInfo> {
		throw new Error("Spotify streaming is not supported by this plugin");
	}

	private identifyKind(input: string): "track" | "playlist" | "album" | "unknown" {
		if (input.startsWith("spotify:")) {
			if (input.includes(":track:")) return "track";
			if (input.includes(":playlist:")) return "playlist";
			if (input.includes(":album:")) return "album";
			return "unknown";
		}
		try {
			const u = new URL(input);
			const parts = u.pathname.split("/").filter(Boolean);
			const kind = parts[0];
			if (kind === "track") return "track";
			if (kind === "playlist") return "playlist";
			if (kind === "album") return "album";
			return "unknown";
		} catch {
			return "unknown";
		}
	}

	private extractId(input: string): string | null {
		if (!input) return null;
		if (input.startsWith("spotify:")) {
			const parts = input.split(":");
			return parts[2] || null;
		}
		try {
			const u = new URL(input);
			const parts = u.pathname.split("/").filter(Boolean);
			return parts[1] || null; // /track/<id>
		} catch {
			return null;
		}
	}

	private async buildTrackFromUrlOrUri(input: string, requestedBy: string): Promise<Track | null> {
		const id = this.extractId(input);
		if (!id) return null;

		const url = this.toShareUrl(input, "track", id);
		const meta = await this.fetchOEmbed(url).catch(() => undefined);
		const title = meta?.title || `Spotify Track ${id}`;
		const thumbnail = meta?.thumbnail_url;

		const track: Track = {
			id,
			title,
			url,
			duration: 0,
			thumbnail,
			requestedBy,
			source: this.name,
			metadata: {
				author: meta?.author_name,
				provider: meta?.provider_name,
				spotify_id: id,
			},
		};
		return track;
	}

	private async buildHeaderItem(input: string, requestedBy: string, kind: "playlist" | "album"): Promise<Track | null> {
		const id = this.extractId(input);
		if (!id) return null;
		const url = this.toShareUrl(input, kind, id);
		const meta = await this.fetchOEmbed(url).catch(() => undefined);

		const title = meta?.title || `Spotify ${kind} ${id}`;
		const thumbnail = meta?.thumbnail_url;

		return {
			id,
			title,
			url,
			duration: 0,
			thumbnail,
			requestedBy,
			source: this.name,
			metadata: {
				author: meta?.author_name,
				provider: meta?.provider_name,
				spotify_id: id,
				kind,
			},
		};
	}

	private toShareUrl(input: string, expectedKind: string, id: string): string {
		if (input.startsWith("spotify:")) {
			return `https://open.spotify.com/${expectedKind}/${id}`;
		}
		try {
			const u = new URL(input);
			const parts = u.pathname.split("/").filter(Boolean);
			const kind = parts[0] || expectedKind;
			const realId = parts[1] || id;
			return `https://open.spotify.com/${kind}/${realId}`;
		} catch {
			return `https://open.spotify.com/${expectedKind}/${id}`;
		}
	}

	private async fetchOEmbed(pageUrl: string): Promise<{
		title?: string;
		thumbnail_url?: string;
		provider_name?: string;
		author_name?: string;
	}> {
		const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}`;
		const res = await fetch(endpoint);
		if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
		return res.json() as Promise<{
			title?: string;
			thumbnail_url?: string;
			provider_name?: string;
			author_name?: string;
		}>;
	}
}
