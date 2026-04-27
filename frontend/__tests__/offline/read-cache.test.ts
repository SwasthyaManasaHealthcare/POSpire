/**
 * InMemoryReadCache tests (Phase 1).
 *
 * Phase 1 ships an in-memory adapter so `call({intent:'read', cacheKey})`
 * resolves to a real implementation rather than falling through to
 * `OfflineReadUnavailable`. Phase 2 swaps for an IndexedDB-backed cache.
 */

import { describe, expect, it } from "vitest";

import { InMemoryReadCache } from "@/offline/read-cache";

describe("InMemoryReadCache", () => {
	it("returns null for an unknown key", async () => {
		const cache = new InMemoryReadCache();
		expect(await cache.read("missing")).toBeNull();
	});

	it("round-trips a value with cachedAt and stale=false (no TTL)", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("k", { items: [1, 2, 3] });
		const entry = await cache.read<{ items: number[] }>("k");
		expect(entry).not.toBeNull();
		expect(entry!.data).toEqual({ items: [1, 2, 3] });
		expect(typeof entry!.cachedAt).toBe("number");
		expect(entry!.stale).toBe(false);
	});

	it("marks an entry stale once age > ttlMs", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("k", "v", 1); // 1ms TTL
		// Wait deterministically: a setTimeout ≥ 2ms ensures Date.now() advances
		// past the TTL. (Real timers — no fake-timer dependency for this test.)
		await new Promise((r) => setTimeout(r, 5));
		const entry = await cache.read<string>("k");
		expect(entry).not.toBeNull();
		expect(entry!.stale).toBe(true);
		// data is still surfaced — caller chooses what to do with stale.
		expect(entry!.data).toBe("v");
	});

	it("clear() removes all entries", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("a", 1);
		await cache.write("b", 2);
		cache.clear();
		expect(await cache.read("a")).toBeNull();
		expect(await cache.read("b")).toBeNull();
	});
});
