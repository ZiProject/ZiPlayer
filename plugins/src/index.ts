/**
 * @fileoverview Main export file for ZiPlayer plugins.
 *
 * This module exports all available plugins for the ZiPlayer music bot framework.
 * Each plugin provides support for different audio sources and services.
 *
 * @example
 * import { YouTubePlugin, SoundCloudPlugin, SpotifyPlugin, TTSPlugin } from "ziplayer/plugins";
 *
 * const manager = new PlayerManager({
 *   plugins: [
 *     new YouTubePlugin(),
 *     new SoundCloudPlugin(),
 *     new SpotifyPlugin(),
 *     new TTSPlugin({ defaultLang: "en" })
 *   ]
 * });
 *
 * @since 1.0.0
 */

/**
 * YouTube plugin for handling YouTube videos, playlists, and search.
 *
 * Provides comprehensive support for YouTube content including:
 * - Video URLs (youtube.com, youtu.be, music.youtube.com)
 * - Playlist URLs and dynamic mixes
 * - Search functionality
 * - Audio stream extraction
 * - Related track recommendations
 *
 * @example
 * const youtubePlugin = new YouTubePlugin();
 * const result = await youtubePlugin.search("Never Gonna Give You Up", "user123");
 */
export * from "./YouTubePlugin.js";

/**
 * SoundCloud plugin for handling SoundCloud tracks, playlists, and search.
 *
 * Provides comprehensive support for SoundCloud content including:
 * - Track URLs (soundcloud.com)
 * - Playlist URLs
 * - Audio stream extraction
 * - Related track recommendations
 *
 * @example
 * const soundcloudPlugin = new SoundCloudPlugin();
 * const result = await soundcloudPlugin.search("chill music", "user123");
 */
export * from "./SoundCloudPlugin.js";

/**
 * Spotify plugin for metadata extraction and display purposes.
 *
 * **Note:** This plugin only provides metadata extraction and does not support
 * audio streaming. It uses Spotify's public oEmbed endpoint for display purposes.
 */
export * from "./SpotifyPlugin.js";

/**
 * Text-to-Speech (TTS) plugin.
 */
export * from "./TTSPlugin.js";

/**
 * Attachments plugin for Discord attachment URLs and audio files.
 */
export * from "./AttachmentsPlugin.js";

import { YouTubePlugin } from "./YouTubePlugin.js";
import { createSabrSeekStream } from "./utils/sabr-seek.js";

/**
 * Attach SABR seek/recreate support without coupling the core player to the
 * YouTube-specific streaming implementation.
 *
 * The wrapper is installed once when the plugin package is loaded. It only
 * adds `StreamInfo.recreate` for YouTube tracks; all normal getStream behavior
 * and fallback handling remain owned by YouTubePlugin.
 */
const youtubeGetStream = YouTubePlugin.prototype.getStream;
const sabrRecreateInstalled = Symbol.for("ziplayer.youtube.sabr-recreate-installed");

if (!(YouTubePlugin.prototype as any)[sabrRecreateInstalled]) {
	Object.defineProperty(YouTubePlugin.prototype, sabrRecreateInstalled, { value: true });
	YouTubePlugin.prototype.getStream = async function (track: any, signal?: AbortSignal) {
		const streamInfo = await youtubeGetStream.call(this, track, signal);
		if (!streamInfo?.stream || track?.source !== "youtube") return streamInfo;

		const videoId = track?.id || this.extractVideoId(track?.url);
		const client = (this as any).client;
		if (!videoId || !client) return streamInfo;

		return {
			...streamInfo,
			recreate: async (position: number) => {
				const recreated = await createSabrSeekStream(videoId, client, position, signal);
				return recreated;
			},
		};
	};
}
