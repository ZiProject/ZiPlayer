interface TtlCacheEntry<V> {
	value: V;
	timestamp: number;
	expiresAt: number;
}

/**
 * Removes the entry with the smallest `timestamp` from `cache` (single O(n) scan,
 * no sorting). Does nothing for an empty map.
 */
export function evictOldest<K, V extends { timestamp: number }>(cache: Map<K, V>): void {
	let oldestKey: K | undefined;
	let oldestTime = Infinity;
	for (const [key, entry] of cache) {
		if (entry.timestamp < oldestTime) {
			oldestTime = entry.timestamp;
			oldestKey = key;
		}
	}
	if (oldestTime !== Infinity) cache.delete(oldestKey as K);
}

/**
 * Small in-memory cache with per-entry expiry and an optional size cap.
 * Expired entries are dropped lazily on `get()` or eagerly via `pruneExpired()`;
 * when the cap is reached the oldest entry is evicted to make room for a new key.
 */
export class TtlCache<V> {
	private readonly entries = new Map<string, TtlCacheEntry<V>>();

	constructor(
		private readonly defaultTtlMs: number,
		private readonly maxSize: number = Infinity,
	) {}

	public get size(): number {
		return this.entries.size;
	}

	public get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (Date.now() >= entry.expiresAt) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	public set(key: string, value: V, ttlMs: number = this.defaultTtlMs): void {
		if (!this.entries.has(key) && this.entries.size >= this.maxSize) evictOldest(this.entries);
		const now = Date.now();
		this.entries.set(key, { value, timestamp: now, expiresAt: now + ttlMs });
	}

	public delete(key: string): boolean {
		return this.entries.delete(key);
	}

	public clear(): void {
		this.entries.clear();
	}

	public keys(): string[] {
		return Array.from(this.entries.keys());
	}

	/** Deletes every entry whose key starts with `prefix`; returns how many were removed. */
	public deleteByPrefix(prefix: string): number {
		let removed = 0;
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix) && this.entries.delete(key)) removed++;
		}
		return removed;
	}

	/** Deletes every expired entry; returns how many were removed. */
	public pruneExpired(): number {
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of this.entries) {
			if (now >= entry.expiresAt) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}
}
