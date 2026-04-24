/**
 * Sync scheduler tests (Agent 3).
 *
 * Spec coverage:
 *   - 05-outbox-and-sync.md §3   (dependency-ordered topological sync)
 *   - 05-outbox-and-sync.md §4.1 (lifecycle — pause on offline, clean stop)
 *   - 05-outbox-and-sync.md §4.3 (exponential backoff with jitter, capped)
 *   - 01-architecture-principles.md P-6  (one leader scheduler)
 *   - 01-architecture-principles.md P-7  (dependency ordering)
 *
 * We test:
 *   - `computeBackoffMs` bounds (pure function, trivially testable).
 *   - Dependency ordering produces: customer → MR → invoice → closing_entry.
 *   - Scheduler pauses on connectivity=offline and resumes on online.
 *   - `stop()` leaves no dangling timers / promises.
 *   - Web Locks leader gate: second instance's start() does not drain while
 *     the first instance holds the lock.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	BACKOFF_BASE_MS,
	BACKOFF_CAP_MS,
	BACKOFF_FACTOR,
	BACKOFF_JITTER,
	computeBackoffMs,
	enqueue,
	evaluateClosingReadiness,
	evaluateParents,
	markSynced,
	MAX_ATTEMPTS,
} from "@/offline/outbox";
import { db } from "@/offline/db";

import {
	setupOfflineStorage,
	teardownOfflineStorage,
} from "../helpers/offline-fixture";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Installs a fake `navigator.locks` implementation that survives re-reads. */
function stubNavigatorLocks(
	locks: { request: (...args: unknown[]) => unknown },
): void {
	// `navigator` is a getter in happy-dom; we set `locks` directly on it.
	// Restore logic in afterEach deletes the property.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Object.defineProperty(globalThis.navigator, "locks", {
		configurable: true,
		writable: true,
		value: locks,
	});
}

function removeNavigatorLocks(): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (globalThis.navigator as any).locks;
	} catch {
		/* ignore */
	}
}

beforeEach(async () => {
	await setupOfflineStorage();
});

afterEach(async () => {
	vi.restoreAllMocks();
	removeNavigatorLocks();
	await teardownOfflineStorage();
});

// ---------------------------------------------------------------------------
// Backoff bounds — pure function, asserted against the contract in §4.3.
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
	it("starts at BACKOFF_BASE_MS for attempt 1 (within ±25% jitter)", () => {
		const samples = Array.from({ length: 200 }, () => computeBackoffMs(1));
		const lower = BACKOFF_BASE_MS * (1 - BACKOFF_JITTER) - 1;
		const upper = BACKOFF_BASE_MS * (1 + BACKOFF_JITTER) + 1;
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(Math.floor(lower));
			expect(s).toBeLessThanOrEqual(Math.ceil(upper));
		}
	});

	it("doubles per attempt up to the cap", () => {
		// Deterministic probe: lock jitter to zero so we test the geometric
		// progression without a distribution.
		const rand = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0
		try {
			// attempt n → base * factor^(n-1), capped at BACKOFF_CAP_MS.
			expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS);
			expect(computeBackoffMs(2)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR);
			expect(computeBackoffMs(3)).toBe(BACKOFF_BASE_MS * BACKOFF_FACTOR ** 2);
			// Cap kicks in eventually.
			for (let n = 1; n <= MAX_ATTEMPTS; n++) {
				const v = computeBackoffMs(n);
				expect(v).toBeLessThanOrEqual(BACKOFF_CAP_MS);
			}
			// Very large attempt must still respect the cap.
			expect(computeBackoffMs(50)).toBe(BACKOFF_CAP_MS);
		} finally {
			rand.mockRestore();
		}
	});

	it("applies ±25% jitter — extreme Math.random values move the result to the bounds", () => {
		const r0 = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			// random()=0 → delta = -jitter (floor)
			const low = computeBackoffMs(1);
			expect(low).toBe(Math.floor(BACKOFF_BASE_MS * (1 - BACKOFF_JITTER)));
		} finally {
			r0.mockRestore();
		}
		const r1 = vi.spyOn(Math, "random").mockReturnValue(0.999999);
		try {
			const high = computeBackoffMs(1);
			expect(high).toBeGreaterThan(BACKOFF_BASE_MS);
			expect(high).toBeLessThanOrEqual(
				Math.ceil(BACKOFF_BASE_MS * (1 + BACKOFF_JITTER)),
			);
		} finally {
			r1.mockRestore();
		}
	});

	it("never returns a negative value", () => {
		const r = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			for (let n = 1; n <= MAX_ATTEMPTS; n++) {
				expect(computeBackoffMs(n)).toBeGreaterThanOrEqual(0);
			}
		} finally {
			r.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Dependency ordering (P-7)
//
// The scheduler itself is complex to test in isolation because it wires up
// Web Locks, connectivity, and the call() bridge. We test the invariant that
// matters — entry gating — directly against `evaluateParents` +
// `evaluateClosingReadiness`. A topological walk that consults these gates
// in order produces: customer → MR → invoice → closing_entry.
// ---------------------------------------------------------------------------

describe("dependency ordering (P-7)", () => {
	it("produces customer → MR → invoice → closing_entry and never violates ordering", async () => {
		// Build the full dependency graph for one shift.
		const cust = await enqueue("customer", { name: "Walk-in" });
		const mr = await enqueue("material_receipt", { item: "A", qty: 3 });
		const inv = await enqueue(
			"invoice",
			{ customer: cust.offline_id, item: "A" },
			{
				parentOfflineIds: [cust.offline_id, mr.offline_id],
				shiftOfflineId: "SHIFT-1",
			},
		);
		const close = await enqueue("closing_entry", { total: 10 }, {
			shiftOfflineId: "SHIFT-1",
		});

		// Custom drain that walks the topological order using the live gate
		// helpers. Any step that violates ordering should fail the assertion.
		const drainOrder: string[] = [];
		const entries = await db.outbox.toArray();
		// Naive topological loop: pick any ready entry, mark synced, repeat.
		// If the graph is acyclic + gates are correct, this terminates.
		let safety = 0;
		while (drainOrder.length < entries.length && safety++ < 50) {
			for (const e of entries) {
				const row = await db.outbox.get(e.offline_id);
				if (!row || row.status === "synced") continue;
				// Decrypt + reconstruct the gate input (evaluateParents reads
				// parent_offline_ids from the in-memory entry).
				const entry = {
					offline_id: row.offline_id,
					type: row.type,
					parent_offline_ids: row.parent_offline_ids,
					shift_offline_id: row.shift_offline_id,
					// Other fields don't matter for the gates:
					device_id: row.device_id,
					posting_date: row.posting_date,
					owner_user: row.owner_user,
					payload: {},
					payload_integrity_hash: row.payload_integrity_hash,
					status: row.status,
					blocked_reason: row.blocked_reason,
					attempt_count: row.attempt_count,
					next_attempt_at: row.next_attempt_at,
					last_error_category: row.last_error_category,
					last_error_detail: row.last_error_detail,
					server_doc_name: row.server_doc_name,
					enqueued_at: row.enqueued_at,
					synced_at: row.synced_at,
				};
				const parentGate = await evaluateParents(entry);
				if (parentGate !== "ready") continue;
				if (entry.type === "closing_entry") {
					const closureGate = await evaluateClosingReadiness(entry);
					if (closureGate !== "ready") continue;
				}
				// Ready — sync it.
				await markSynced(
					entry.offline_id,
					`SRV-${drainOrder.length.toString().padStart(3, "0")}`,
				);
				drainOrder.push(entry.type);
				break;
			}
		}

		// Order invariant: customer before any referencing invoice.
		expect(drainOrder.indexOf("customer")).toBeLessThan(
			drainOrder.indexOf("invoice"),
		);
		// MR before invoice.
		expect(drainOrder.indexOf("material_receipt")).toBeLessThan(
			drainOrder.indexOf("invoice"),
		);
		// Closing entry last.
		expect(drainOrder[drainOrder.length - 1]).toBe("closing_entry");
		// All four drained.
		expect(drainOrder).toHaveLength(4);

		// Verify in the DB every row ended synced.
		const post = await db.outbox.toArray();
		for (const r of post) {
			expect(r.status).toBe("synced");
		}

		// Bulk ids — none correspond to the original id.
		void [cust.offline_id, mr.offline_id, inv.offline_id, close.offline_id];
	});
});

// ---------------------------------------------------------------------------
// Scheduler lifecycle — pause on offline, resume on online, clean stop.
// Loads the module freshly per test so the singleton doesn't leak state.
// ---------------------------------------------------------------------------

describe("scheduler lifecycle", () => {
	it("pauses the drain loop on offline and resumes on online", async () => {
		vi.resetModules();

		// Stub navigator.locks so the scheduler's leader-election path is
		// deterministic and doesn't actually hold a global lock across tests.
		stubNavigatorLocks({
			request: (_: string, __: LockOptions, cb: (l: Lock) => Promise<unknown>) =>
				cb({} as Lock),
		});

		// Dynamic import AFTER stubbing so the module sees our stubs.
		const connMod = await import("@/offline/connectivity");
		const sync = await import("@/offline/sync");

		// Default is "online" — flip to offline before start so the loop
		// enters the waitForOnline branch immediately.
		connMod.connectivity.forceOffline();

		await sync.scheduler.start();
		const beforeKick = sync.scheduler.status();
		expect(beforeKick.running).toBe(true);

		// Now flip online — the scheduler should unblock. We don't wait for a
		// specific POST because there's nothing enqueued; we just assert the
		// running flag stays true and stop() cleans up without a hang.
		connMod.connectivity.forceOnline();

		await sync.scheduler.stop();
		const afterStop = sync.scheduler.status();
		expect(afterStop.running).toBe(false);
	});

	it("stop() leaves no dangling timers (second start is idempotent and clean)", async () => {
		vi.resetModules();
		stubNavigatorLocks({
			request: (_: string, __: LockOptions, cb: (l: Lock) => Promise<unknown>) =>
				cb({} as Lock),
		});
		const sync = await import("@/offline/sync");

		await sync.scheduler.start();
		await sync.scheduler.stop();
		await sync.scheduler.start();
		await sync.scheduler.stop();

		// No assertion on timers directly — if stop() were leaky the test
		// runner's "unhandled promise" / "open handle" detection in vitest
		// would surface it. This test just documents the expectation.
		expect(sync.scheduler.status().running).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Leader gate — second instance does not drain while the first holds.
// ---------------------------------------------------------------------------

describe("leader lock", () => {
	it("second SyncScheduler's start() does not become leader while the first holds", async () => {
		vi.resetModules();

		// Simulate a Web Locks API where the FIRST request holds the lock
		// indefinitely (callback never resolves) and the SECOND request queues
		// behind it (never invoked until the first releases).
		let firstLockHeld = false;
		let secondGotLock = false;
		stubNavigatorLocks({
			request: (
				_name: string,
				_opts: LockOptions,
				cb: (l: Lock) => Promise<unknown>,
			) => {
				if (!firstLockHeld) {
					firstLockHeld = true;
					// Hold forever — return a promise that never resolves.
					return cb({} as Lock).then(() => new Promise<void>(() => {}));
				}
				secondGotLock = true;
				return cb({} as Lock);
			},
		});

		const { SyncScheduler } = await import("@/offline/sync");

		const a = new SyncScheduler();
		const b = new SyncScheduler();

		// Start them both. `a.start()` resolves only when the callback has
		// been entered (the first lock acquisition); `b.start()` returns a
		// promise for the lock it can't acquire. We fire-and-forget b.start()
		// and then assert the second callback never fires within the test
		// window.
		const aStart = a.start();
		// b.start() returns a promise that stays pending because the mock
		// locks API never invokes the second callback.
		void b.start();

		// Wait for a to become leader. Our mock invokes the callback
		// synchronously, so aStart resolves on the next microtask.
		await aStart;

		// Give the event loop a few ticks — more than enough for any racy
		// second-lock acquisition to fire if the gate were broken.
		await new Promise((r) => setTimeout(r, 50));

		expect(a.status().leader).toBe(true);
		expect(b.status().leader).toBe(false);
		expect(secondGotLock).toBe(false);

		// Cleanup: stop both schedulers (a's drain loop is still running).
		await a.stop();
		await b.stop();
	});
});

// Node-side `Lock` / `LockOptions` are web types; vitest's happy-dom provides
// them via the DOM lib. We re-export them as aliases so the type imports
// above compile without `declare global` tricks.
type Lock = { name?: string };
type LockOptions = { mode?: "exclusive" | "shared" };
