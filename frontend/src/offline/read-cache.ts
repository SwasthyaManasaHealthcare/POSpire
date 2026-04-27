/**
 * In-memory ReadCache adapter for `@/utils/call`.
 *
 * Phase 1 ships an in-memory cache (Map) — sufficient for caching `call()`
 * read responses across navigations within a single page session. It is NOT
 * a persistence layer; reload clears it. Persistent cached reads (so the
 * cashier sees items / customers offline after a reload) belong to Phase 2:
 * components migrate from their legacy localStorage caches to either
 *
 *   • `call({ method, intent: 'read', cacheKey, cacheTTLMs })`, or
 *   • Agent 1's domain repos (`getItemByCode` etc.) which already cache in
 *     IndexedDB.
 *
 * Until that migration lands, this in-memory adapter exists only to satisfy
 * the runtime contract: `call.ts` checks for a registered cache before
 * falling through to `OfflineReadUnavailable`. Without registration, any
 * component that DOES start using `cacheKey` in Phase 2 would silently
 * regress to live-only.
 */

import type { CachedRead, ReadCache } from "./types";

interface InMemoryEntry {
	data: unknown;
	cachedAt: number;
	ttlMs: number | null;
}

export class InMemoryReadCache implements ReadCache {
	private readonly store = new Map<string, InMemoryEntry>();

	async read<T>(cacheKey: string): Promise<CachedRead<T> | null> {
		const entry = this.store.get(cacheKey);
		if (!entry) return null;
		const age = Date.now() - entry.cachedAt;
		const stale = entry.ttlMs !== null && age > entry.ttlMs;
		return {
			data: entry.data as T,
			cachedAt: entry.cachedAt,
			stale,
		};
	}

	async write<T>(cacheKey: string, value: T, ttlMs?: number): Promise<void> {
		this.store.set(cacheKey, {
			data: value,
			cachedAt: Date.now(),
			ttlMs: ttlMs ?? null,
		});
	}

	/** Test/diagnostic: drop everything. */
	clear(): void {
		this.store.clear();
	}
}
