/**
 * Shared helpers for offline unit/integration tests.
 *
 * Responsibilities:
 *   - Initialise `@/offline/db` so crypto is bootstrapped and the schema is
 *     open. Tests that only exercise outbox/repos can call
 *     `setupOfflineStorage()` in a `beforeEach` and get a clean slate.
 *   - Re-clear all object stores between tests so state doesn't leak.
 *   - Tear down Dexie between test FILES (vitest's `isolate: true` already
 *     gives us a fresh module graph, but `delete` is explicit insurance).
 */

import {
	db,
	initOfflineStorage,
	exitSafeMode,
	journalDb,
	stopHealthProbe,
} from "@/offline/db";

export async function setupOfflineStorage(): Promise<void> {
	// `initOfflineStorage` is idempotent and handles the crypto-key bootstrap.
	// On a fresh module graph + fresh indexedDB we get a new key every time.
	await initOfflineStorage();
	// Tests may trigger safe mode accidentally (e.g. health probe in
	// constrained environments). Force-exit so subsequent tests are writable.
	exitSafeMode();
	await clearAllTables();
}

/** Clears every object store. Does not reset the crypto key (module-level). */
export async function clearAllTables(): Promise<void> {
	try {
		await db.transaction(
			"rw",
			[db.items, db.customers, db.shifts, db.outbox, db.metadata, db._health],
			async () => {
				await db.items.clear();
				await db.customers.clear();
				await db.shifts.clear();
				await db.outbox.clear();
				// Keep the crypto key rows alive — the active key was registered at
				// init; wiping metadata would leave the module with a stale key id.
				// We delete everything else by key.
				const metaRows = await db.metadata.toArray();
				for (const r of metaRows) {
					if (r.key.startsWith("crypto.")) continue;
					await db.metadata.delete(r.key);
				}
				await db._health.clear();
			},
		);
	} catch {
		/* table might not exist yet — first-time setup handles itself */
	}
	try {
		await journalDb.journal.clear();
	} catch {
		/* not always open */
	}
}

/** Delete and re-open the DB — used between test files that need a hard reset. */
export async function teardownOfflineStorage(): Promise<void> {
	try {
		stopHealthProbe();
	} catch {
		/* not running */
	}
	try {
		await db.close();
	} catch {
		/* ignore */
	}
	try {
		await journalDb.close();
	} catch {
		/* ignore */
	}
}
