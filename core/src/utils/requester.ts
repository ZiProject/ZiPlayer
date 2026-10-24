import type { TrackRequester, SearchResult } from "../types";

export function getRequesterId(requestedBy: TrackRequester | undefined): string | undefined {
	if (typeof requestedBy === "string") return requestedBy;
	if (!requestedBy) return undefined;
	if ("id" in requestedBy && typeof requestedBy.id === "string") return requestedBy.id;
	if ("username" in requestedBy && typeof requestedBy.username === "string") return requestedBy.username;
	return String(requestedBy);
}

export function withTrackRequester(result: SearchResult, requestedBy: TrackRequester): SearchResult {
	return {
		...result,
		tracks: result.tracks.map((track) => ({ ...track, requestedBy })),
	};
}
