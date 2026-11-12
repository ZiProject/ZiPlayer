/** Shared timing and sizing defaults. Keep cache/timeout numbers here instead of repeating literals. */

const MINUTE_MS = 60 * 1000;

/** How long manager-level and extension-level search results stay cached. */
export const SEARCH_CACHE_TTL_MS = MINUTE_MS;
/** How long plugin and per-player search results stay cached (also the plugin `searchCacheTTL` default). */
export const PLUGIN_SEARCH_CACHE_TTL_MS = 2 * MINUTE_MS;
/** How long resolved stream info stays cached. */
export const STREAM_CACHE_TTL_MS = 5 * MINUTE_MS;
/** Maximum entries kept in the manager/extension caches before the oldest is evicted. */
export const MAX_CACHE_ENTRIES = 100;
/** Interval at which expired cache entries are pruned. */
export const CACHE_CLEANUP_INTERVAL_MS = 5 * MINUTE_MS;
/** Default time a stream may take to resolve before it is abandoned. */
export const DEFAULT_STREAM_TIMEOUT_MS = 5 * MINUTE_MS;
