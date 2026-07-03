/**
 * @fileoverview Main export file for ZiPlayer extensions.
 *
 * This module exports all available extensions and supporting classes for the ZiPlayer
 * music bot framework. Extensions provide additional functionality beyond basic
 * audio playback, such as Lavalink integration, voice recognition, and lyrics fetching.
 *
 * @example
 * ```typescript
 * import { lavalinkExt, voiceExt, lyricsExt, NodeManager } from "ziplayer/extension";
 *
 * const manager = new PlayerManager({
 *   extensions: [
 *     new lavalinkExt(null, {
 *       nodes: [{ host: "localhost", port: 2333, password: "youshallnotpass" }]
 *     }),
 *     new voiceExt(null, { lang: "en-US" }),
 *     new lyricsExt(null, { provider: "lrclib" })
 *   ]
 * });
 * ```
 *
 * @since 1.0.0
 */

/**
 * Lavalink extension for high-performance audio streaming.
 *
 * Provides integration with Lavalink nodes for:
 * - High-quality audio streaming with low latency
 * - Advanced audio processing and effects
 * - Load balancing across multiple nodes
 * - WebSocket-based real-time updates
 *
 * @example
 * ```typescript
 * const lavalinkExt = new lavalinkExt(null, {
 *   nodes: [{ host: "localhost", port: 2333, password: "youshallnotpass" }]
 * });
 * ```
 */

export * from "./lavalinkExt";

/**
 * Voice extension for real-time speech recognition.
 *
 * Provides voice-to-text functionality including:
 * - Real-time speech recognition in Discord voice channels
 * - Multiple language support
 * - Custom speech resolver support
 * - Audio quality filtering
 *
 * @example
 * ```typescript
 * const voiceExt = new voiceExt(null, {
 *   lang: "en-US",
 *   ignoreBots: true
 * });
 * ```
 */
export { voiceExt } from "./voiceExt";

/**
 * Lyrics extension for automatic lyrics fetching and synchronization.
 *
 * Provides lyrics functionality including:
 * - Automatic lyrics fetching from multiple providers
 * - LRC (synchronized) lyrics support
 * - Real-time line-by-line updates
 * - Title sanitization for better matching
 *
 * @example
 * ```typescript
 * const lyricsExt = new lyricsExt(null, {
 *   provider: "lrclib",
 *   includeSynced: true
 * });
 * ```
 */
export { lyricsExt } from "./lyricsExt";

/**
 * Type definitions for Lavalink integration.
 *
 * Includes:
 * - Lavalink node configuration types
 * - Player state types
 * - Voice connection types
 * - Extension option types
 */
export * from "./types/lavalink";

/**
 * AI Autoplay extension for intelligent music recommendations.
 *
 * Provides AI-powered autoplay functionality including:
 * - Music taste analysis using Gemini 2.5 Flash
 * - Intelligent next track suggestions based on listening history
 * - Seamless integration with player queue
 * - Real-time debugging information
 *
 * @example
 * ```typescript
 * const aiAutoplayExt = new AiAutoplayExtension("your-api-key");
 * ```
 */
export * from "./AiAutoplayExtension";
