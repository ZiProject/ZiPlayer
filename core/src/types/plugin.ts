import type { SearchResult, StreamInfo, Track } from ".";
/**
 * Plugin interface
 *
 * @example
 * const plugin: SourcePlugin = {
 *   name: "YouTube",
 *   version: "1.0.0"
 *   priority: 0, // Optional, default is 0. Lower priority plugins are tried first in getStream fallback.
 * };
 */
export interface SourcePlugin {
	name: string;
	version: string;
	priority?: number; // Higher = run first, default is 0. Lower priority plugins are tried first in getStream fallback.
	canHandle(query: string): boolean;
	search(query: string, requestedBy: string): Promise<SearchResult>;
	getStream(track: Track, signal?: AbortSignal): Promise<StreamInfo>;
	/** Optional direct video resolver. Plugins that only expose audio can omit it. */
	getVideo?(track: Track, signal?: AbortSignal): Promise<StreamInfo>;
	getRelatedTracks?(track: Track, opts?: { limit?: number; offset?: number }): Promise<Track[]>;
	validate?(url: string): boolean;
	extractPlaylist?(url: string, requestedBy: string): Promise<Track[]>;
	getFallback?(track: Track, signal?: AbortSignal): Promise<StreamInfo>;
}

/**
 * Constructor for a SourcePlugin
 *
 * @example
 * const plugin = new YouTubePlugin();
 * console.log(`Plugin: ${plugin.name}`);
 */
export type SourcePluginCtor<T extends SourcePlugin = SourcePlugin> = new (...args: any[]) => T;

/**
 * SourcePlugin or SourcePluginCtor
 *
 * @example
 * const plugin = new YouTubePlugin();
 * console.log(`Plugin: ${plugin.name}`);
 */
export type SourcePluginLike = SourcePlugin | SourcePluginCtor;

/**
 * Configuration options for creating a PlayerManager instance.
 *
 * @example
 * const managerOptions: PlayerManagerOptions = {
 *   plugins: [
 *     new YouTubePlugin(),
 *     new SoundCloudPlugin(),
 *     new SpotifyPlugin(),
 *     new TTSPlugin({ defaultLang: "en" })
 *   ],
 *   extensions: [
 *     new voiceExt(null, { lang: "en-US" }),
 *     new lavalinkExt(null, { nodes: [...] })
 *   ],
 *   extractorTimeout: 10000
 * };
 */

export type VideoResolveOptions = {
	signal?: AbortSignal;
};
