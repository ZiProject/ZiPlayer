/*
 * TEMP MIGRATION PATCH — DO NOT IMPORT.
 *
 * This file is a handoff patch for Player.ts. Copy the relevant members into
 * Player.ts after the corresponding bus/controller contracts are present.
 * It intentionally keeps the public API signatures unchanged where possible.
 */

import type { SearchResult, Track, ProgressBarOptions } from "../types";
import type { BasePlugin } from "../plugins/BasePlugin";
import type { AudioResource } from "@discordjs/voice";
import type { SearchDebugResult } from "../controller/SearchController";

export class PlayerFacadeMigrationTemp {
	/* -----------------------------------------------------------------------
	 * STATE GETTERS — all reads go through PlayerBus, never controllers.
	 * --------------------------------------------------------------------- */

	public get currentTrack(): Track | null {
		return this.bus.querySync("currentTrack");
	}

	public get queueSize(): number {
		return this.bus.querySync("queue").length;
	}

	public get isPlaying(): boolean {
		return this.bus.querySync("isPlaying");
	}

	public get isPaused(): boolean {
		return this.bus.querySync("isPaused");
	}

	public get isLive(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isLive ?? false;
		return Boolean(this.currentTrack?.isLive);
	}

	public get isIdle(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isIdle ?? true;
		return this.bus.querySync("playerState") === "idle";
	}

	public get isBuffering(): boolean {
		if (this.playbackMode === "FORWARD") return this.forwardLeader?.isBuffering ?? false;
		return this.bus.querySync("playerState") === "buffering";
	}

	public get volume(): number {
		return this.bus.querySync("volume");
	}

	public set volume(value: number) {
		this.volumeControllerSetVolumeViaBus(value);
	}

	public get previousTrack(): Track | null {
		return this.bus.querySync("previousTrack");
	}

	public get upcomingTracks(): Track[] {
		return this.bus.querySync("queue");
	}

	public get previousTracks(): Track[] {
		return this.bus.querySync("previousTracks");
	}

	public get availablePlugins(): BasePlugin[] {
		return this.bus.querySync("availablePlugins");
	}

	public get relatedTracks(): Track[] | null {
		return this.bus.querySync("relatedTracks");
	}

	public get currentResource(): AudioResource | null {
		return this.bus.querySync("currentResource") as AudioResource | null;
	}

	/* -----------------------------------------------------------------------
	 * SEARCH — orchestration is RPC-owned by SearchController.
	 * --------------------------------------------------------------------- */

	public search(query: string, requestedBy: string): Promise<SearchResult> {
		return this.bus.requestRpc("search", { query, requestedBy });
	}

	/* Parameterized search/cache operations are RPC because they carry input. */
	public getCachedSearchResult(query: string): Promise<SearchResult | null> {
		return this.bus.requestRpc("search.cache.get", { query });
	}

	public cacheSearchResult(query: string, result: SearchResult): Promise<void> {
		return this.bus.requestRpc("search.cache.set", { query, result });
	}

	public clearSearchCache(): Promise<void> {
		return this.bus.requestRpc("search.cache.clear", {});
	}

	public clearExpiredSearchCache(): Promise<void> {
		return this.bus.requestRpc("search.cache.purge", {});
	}

	public debugSearchQuery(query: string): Promise<SearchDebugResult> {
		return this.bus.requestRpc("search.debug", { query });
	}

	/* -----------------------------------------------------------------------
	 * COMPATIBILITY NOTES
	 *
	 * The methods above intentionally use Promise-returning RPCs for operations
	 * with parameters. If the existing Player public API must remain strictly
	 * synchronous for cache/debug methods, add a dedicated querySync parameter
	 * API instead of reaching into SearchController from Player.
	 * --------------------------------------------------------------------- */

	/* These declarations are placeholders only; Player.ts already owns them. */
	private readonly bus!: any;
	private readonly playbackMode!: any;
	private readonly forwardLeader!: { isLive?: boolean; isIdle?: boolean; isBuffering?: boolean } | null;
	private readonly volumeControllerSetVolumeViaBus!: (value: number) => void;
}

/* -------------------------------------------------------------------------
 * SEARCH CONTROLLER — RPC registrations to add/keep in SearchController.
 * ----------------------------------------------------------------------- */

export const SEARCH_RPC_TYPES = {
	search: "search",
	cacheGet: "search.cache.get",
	cacheSet: "search.cache.set",
	cacheClear: "search.cache.clear",
	cachePurge: "search.cache.purge",
	debug: "search.debug",
} as const;

/*
 * Suggested SearchController constructor registrations:
 *
 * detachSearchCacheGet = bus.registerRpc("search.cache.get", ({ query }) =>
 *   this.getCached(query)
 * );
 *
 * detachSearchCacheSet = bus.registerRpc("search.cache.set", ({ query, result }) =>
 *   this.cacheResult(query, result)
 * );
 *
 * detachSearchCacheClear = bus.registerRpc("search.cache.clear", () => {
 *   this.clear();
 * });
 *
 * detachSearchCachePurge = bus.registerRpc("search.cache.purge", () => {
 *   this.purgeStale();
 * });
 *
 * detachSearchDebug = bus.registerRpc("search.debug", ({ query }) =>
 *   this.debug(query)
 * );
 *
 * Keep the existing "search" RPC as-is.
 */

/* -------------------------------------------------------------------------
 * PLAYER BUS — query keys expected by the Player getters.
 * ----------------------------------------------------------------------- */

export const REQUIRED_PLAYER_QUERIES = [
	"currentTrack",
	"queue",
	"isPlaying",
	"isPaused",
	"playerState",
	"volume",
	"previousTrack",
	"previousTracks",
	"availablePlugins",
	"relatedTracks",
	"currentResource",
] as const;

/*
 * SET_VOLUME remains an action, not a query/RPC. Player should dispatch:
 *
 *   void this.action({ type: "SET_VOLUME", volume: value });
 *
 * If the legacy setter must return the clamped volume synchronously, expose a
 * synchronous volume query after dispatch is not enough because the action is
 * asynchronous. Prefer a dedicated synchronous command bridge only if API
 * compatibility requires it; otherwise make setVolume async in the next major.
 */
