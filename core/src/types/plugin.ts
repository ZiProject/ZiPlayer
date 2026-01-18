import type { SearchResult, StreamInfo, Track } from ".";
/**
 * Plugin interface
 *
 * @example
 * const plugin: SourcePlugin = {
 *   name: "YouTube",
 *   version: "1.0.0"
 * };
 */
export interface SourcePlugin {
	name: string;
	version: string;
	canHandle(query: string): boolean;
	search(query: string, requestedBy: string): Promise<SearchResult>;
	getStream(track: Track): Promise<StreamInfo>;
	getRelatedTracks?(track: string | number, opts?: { limit?: number; offset?: number }): Promise<Track[]>;
	validate?(url: string): boolean;
	extractPlaylist?(url: string, requestedBy: string): Promise<Track[]>;
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
