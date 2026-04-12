import { SourcePlugin, Track, SearchResult, StreamInfo } from "../types";

export abstract class BasePlugin implements SourcePlugin {
	abstract name: string;
	abstract version: string;
	priority?: number = 0;

	abstract canHandle(query: string): boolean;
	abstract search(query: string, requestedBy: string): Promise<SearchResult>;
	abstract getStream(track: Track, signal?: AbortSignal): Promise<StreamInfo>;

	getFallback?(track: Track, signal?: AbortSignal): Promise<StreamInfo> {
		throw new Error("getFallback not implemented");
	}

	getRelatedTracks?(trackURL: Track, opts?: { limit?: number; offset?: number; history?: Track[] }): Promise<Track[]> {
		return Promise.resolve([]);
	}

	validate?(url: string): boolean {
		return this.canHandle(url);
	}

	extractPlaylist?(url: string, requestedBy: string): Promise<Track[]> {
		return Promise.resolve([]);
	}
}
