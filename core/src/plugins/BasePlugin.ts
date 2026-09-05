import { SourcePlugin, Track, SearchResult, StreamInfo, RelatedTracksOptions } from "../types";

export abstract class BasePlugin implements SourcePlugin {
	abstract name: string;
	abstract version: string;
	priority?: number = 0; // Higher = run first

	abstract canHandle(query: string): boolean;
	abstract search(query: string, requestedBy: string): Promise<SearchResult>;
	abstract getStream(track: Track, signal?: AbortSignal): Promise<StreamInfo>;

	/** Optional direct video resolver for plugins that expose video media. */
	getVideo?(track: Track, signal?: AbortSignal): Promise<StreamInfo>;

	getFallback?(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		throw new Error("getFallback not implemented");
	}

	getRelatedTracks?(trackURL: Track, opts?: RelatedTracksOptions): Promise<Track[]> {
		return Promise.resolve([]);
	}

	validate?(url: string): boolean {
		return this.canHandle(url);
	}

	extractPlaylist?(url: string, requestedBy: string): Promise<Track[]> {
		return Promise.resolve([]);
	}
}
