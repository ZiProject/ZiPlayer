import { serializeTrack } from "./voice/RemoteVoice";

/** Wire shape of a search result. Tracks are plain JSON; `metadata.net.owner` is set by the receiver, never trusted from the wire. */
export interface WireSearchResult {
	tracks: any[];
	playlist?: { name: string; url?: string; thumbnail?: string } | null;
	query?: string;
	source?: string;
}

export interface NetSearchOptions {
	/** Forwarded as `requestedBy` of the returned tracks. */
	requestedBy?: unknown;
	/** Restrict to one source (plugin name or alias such as `yt`). A `yt:` prefix in the query does the same. */
	source?: string;
	/** Only ask these nodes (default: every online, trusted node that serves search). */
	peers?: string[];
	/**
	 * Where this node's own plugins come in. `first` (default): try them first, ask the others only when nothing is found.
	 * `last`: ask the others first. `only`: never leave this node. `never`: skip them.
	 */
	local?: "first" | "last" | "only" | "never";
	/** `true`: ask every candidate and merge the tracks (de-duplicated). Default `false`: the first non-empty answer wins. */
	merge?: boolean;
	/** Max tracks returned (default 10). */
	limit?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface NetSearchResult {
	tracks: any[];
	playlist?: { name: string; url?: string; thumbnail?: string } | null;
	query?: string;
	source?: string;
	/** Node whose plugins produced the tracks (this node for local results). With `merge`, the first contributor. */
	node: string;
	/** Every node that contributed tracks. */
	nodes: string[];
}

export interface ServeSearchOptions {
	/** Decide per query / caller. Throw or return `false` to refuse. */
	allow?: (query: string, peerId: string) => boolean | Promise<boolean>;
	/** Max tracks sent back per request (default 25). */
	maxResults?: number;
	/** Soft cap for the JSON size of one answer, trailing tracks are dropped (default 200 000). */
	maxResponseBytes?: number;
}

export const DEFAULT_SEARCH_ALIASES: Record<string, string> = {
	yt: "youtube",
	youtube: "youtube",
	sc: "soundcloud",
	soundcloud: "soundcloud",
	sp: "spotify",
	spotify: "spotify",
	tts: "tts",
};

export const MAX_QUERY_CHARS = 512;
export const MAX_IMPORTED_TRACKS = 100;

/**
 * `yt:lofi` → `{ source: "youtube", query: "lofi" }`. The `tts:` prefix stays in the query because the TTS plugin needs it.
 * Anything without a known prefix (including `https://…`) has no source.
 */
export function parseSearchQuery(
	text: string,
	aliases: Record<string, string> = DEFAULT_SEARCH_ALIASES,
	explicitSource?: string,
): { source?: string; query: string } {
	const resolve = (name: string) => aliases[name.toLowerCase()] ?? name.toLowerCase();
	if (explicitSource) return { source: resolve(explicitSource), query: text.trim() };
	const m = text.match(/^(\w+):([\s\S]*)$/);
	const source = m ? aliases[m[1].toLowerCase()] : undefined;
	if (!m || !source) return { query: text.trim() };
	return { source, query: source === "tts" ? text.trim() : m[2].trim() };
}

/** Provider side: turn a plugin SearchResult into something safe and small enough for one control frame. */
export function toWireResult(result: any, limit: number, maxBytes: number): WireSearchResult {
	const tracks: any[] = [];
	let bytes = 0;
	for (const track of (result?.tracks ?? []).slice(0, limit)) {
		const wire = serializeTrack(track);
		if (!wire || typeof wire !== "object") continue;
		// Whoever asked is the requester; the provider's requester (a Discord user object...) is meaningless over there.
		delete wire.requestedBy;
		if (wire.metadata?.net) delete wire.metadata.net;
		const size = Buffer.byteLength(JSON.stringify(wire));
		if (tracks.length && bytes + size > maxBytes) break;
		tracks.push(wire);
		bytes += size;
	}
	const playlist = result?.playlist ? serializeTrack(result.playlist) : null;
	return { tracks, playlist, query: typeof result?.query === "string" ? result.query : undefined, source: result?.source };
}

/**
 * Consumer side: validate what a peer answered and stamp the ONLY owner that matters, the node that answered.
 * The peer cannot point playback at a different node by writing `metadata.net.owner` itself.
 */
export function importWireResult(raw: any, owner: string, requestedBy?: unknown, limit = 10): WireSearchResult {
	const tracks: any[] = [];
	if (Array.isArray(raw?.tracks)) {
		for (const item of raw.tracks.slice(0, Math.min(limit, MAX_IMPORTED_TRACKS))) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			if (item.id === undefined && typeof item.url !== "string") continue;
			const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata : {};
			const track = { ...item, metadata: { ...metadata, net: { owner } } };
			if (requestedBy !== undefined) track.requestedBy = requestedBy;
			tracks.push(track);
		}
	}
	const p = raw?.playlist;
	const playlist = p && typeof p === "object" && typeof p.name === "string" ? { name: p.name, url: p.url, thumbnail: p.thumbnail } : null;
	return {
		tracks,
		playlist,
		query: typeof raw?.query === "string" ? raw.query : undefined,
		source: typeof raw?.source === "string" ? raw.source : undefined,
	};
}

/** Order-preserving de-duplication of tracks that came from the same node with the same id / url. */
export function dedupeNetTracks(tracks: any[]): any[] {
	const seen = new Set<string>();
	return tracks.filter((t) => {
		const key = `${t?.metadata?.net?.owner ?? ""}|${t?.id ?? ""}|${t?.url ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
