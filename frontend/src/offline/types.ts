/**
 * Stub interfaces for modules owned by Agent 1 (Dexie / repos) and Agent 3
 * (outbox). These are intentionally minimal and describe only the surface
 * consumed by `@/utils/call`. They will be replaced at integration time by
 * the real implementations in:
 *   - `@/offline/db.ts`              (Agent 1)
 *   - `@/offline/repos/*.ts`         (Agent 1)
 *   - `@/offline/outbox.ts`          (Agent 3)
 *
 * DO NOT import these types in component code — use `@/utils/call` instead.
 */

// ---------------------------------------------------------------------------
// Read cache — Agent 1
// ---------------------------------------------------------------------------

/**
 * A cached read response. `stale: true` is structural (not an error string)
 * so callers type-narrow on it; see 09-api-boundary.md §7.
 */
export interface CachedRead<T = unknown> {
	data: T;
	cachedAt: number; // epoch ms
	stale: boolean;
}

/**
 * Minimal read-cache surface needed by `call.ts`. Agent 1 will implement
 * this against Dexie (03-storage-layer.md).
 */
export interface ReadCache {
	/** Return a cached value for `cacheKey`, or `null` if absent. */
	read<T = unknown>(cacheKey: string): Promise<CachedRead<T> | null>;
	/** Write/refresh a cached value for `cacheKey` with optional TTL. */
	write<T = unknown>(cacheKey: string, value: T, ttlMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outbox — Agent 3
// ---------------------------------------------------------------------------

/**
 * The shape `outbox.enqueue_and_ack` returns. Matches the placeholder
 * response documented in 09-api-boundary.md §2.3 so components can treat
 * enqueued writes as normal responses with `offline === true`.
 */
export interface OutboxEnqueueAck {
	offline: true;
	offline_id: string;
	provisional_name: string;
	status: "enqueued";
}

/** Options accepted by the outbox enqueue function. */
export interface OutboxEnqueueOptions {
	/** Pre-generated idempotency key. Required for the retry-on-network-error
	 * path so that the same `offline_id` is reused for an already-inflight
	 * write. */
	offlineIdempotencyKey?: string;
	/** Method path as used by the server; mirrors `CallOptions.method`. */
	method: string;
	/** Outbox type bucket from the method registry (invoice, material_receipt, …). */
	outboxType: string;
}

/**
 * Enqueue a write into the durable outbox. Agent 3 owns the real
 * implementation (persistence, dependency graph, scheduler). `call.ts`
 * treats this as a black box.
 */
export type OutboxEnqueueFn = (
	type: string,
	payload: unknown,
	options?: OutboxEnqueueOptions,
) => Promise<OutboxEnqueueAck>;

// ---------------------------------------------------------------------------
// Dexie handle — Agent 1
// ---------------------------------------------------------------------------

/**
 * Opaque handle for the Dexie database. `call.ts` does not use it directly;
 * it flows through `ReadCache` / `OutboxEnqueueFn`. Declared here so the
 * registration surface in `offline/runtime.ts` can accept the real instance
 * when Agent 1 lands.
 */
export interface OfflineDb {
	readonly name: string;
}
