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
export { YouTubePlugin } from "./YouTubePlugin";

/**
 * SoundCloud plugin for handling SoundCloud tracks, playlists, and search.
 *
 * Provides comprehensive support for SoundCloud content including:
 * - Track URLs (soundcloud.com)
 * - Playlist URLs
 * - Search functionality
 * - Audio stream extraction
 * - Related track recommendations
 *
 * @example
 * const soundcloudPlugin = new SoundCloudPlugin();
 * const result = await soundcloudPlugin.search("chill music", "user123");
 */
export { SoundCloudPlugin } from "./SoundCloudPlugin";

/**
 * Spotify plugin for metadata extraction and display purposes.
 *
 * **Note:** This plugin only provides metadata extraction and does not support
 * audio streaming. It uses Spotify's public oEmbed endpoint for display purposes.
 *
 * Provides support for:
 * - Track URLs/URIs (spotify:track:...)
 * - Playlist URLs/URIs (spotify:playlist:...)
 * - Album URLs/URIs (spotify:album:...)
 * - Metadata extraction using oEmbed API
 *
 * @example
 * const spotifyPlugin = new SpotifyPlugin();
 * const result = await spotifyPlugin.search("spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "user123");
 */
export { SpotifyPlugin } from "./SpotifyPlugin";

/**
 * Text-to-Speech (TTS) plugin for converting text to audio.
 *
 * Provides comprehensive TTS functionality including:
 * - Google TTS integration
 * - Custom TTS provider support
 * - Multiple language support
 * - Configurable speech rate
 * - Flexible query parsing
 *
 * @example
 * const ttsPlugin = new TTSPlugin({ defaultLang: "en" });
 * const result = await ttsPlugin.search("tts:Hello world", "user123");
 */
export { TTSPlugin } from "./TTSPlugin";

/**
 * YTSR plugin for advanced YouTube search without streaming.
 *
 * Provides comprehensive YouTube search functionality including:
 * - Advanced video search with filters (duration, upload date, sort by)
 * - Playlist and channel search
 * - Multiple search types (video, playlist, channel, all)
 * - Metadata extraction without streaming
 * - Support for YouTube URLs
 *
 * @example
 * const ytsrPlugin = new YTSRPlugin();
 * const result = await ytsrPlugin.search("Never Gonna Give You Up", "user123");
 * const playlistResult = await ytsrPlugin.searchPlaylist("chill music", "user123");
 */
export { YTSRPlugin } from "./YTSRPlugin";
