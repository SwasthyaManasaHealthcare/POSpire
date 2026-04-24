/**
 * Pinia store: outbox (reactive facade).
 *
 * Components read aggregate outbox counts (for the banner, the navbar badge,
 * and the reconciliation workspace) from this store. The store does NOT
 * copy outbox rows into Pinia state — it subscribes to Dexie via `liveQuery`
 * and exposes derived counts + a short window of rows for the workspace
 * (ReconciliationWorkspace loads `needs_review` rows through its own query;
 * this store only surfaces the summary).
 *
 * Guardrails (D-27, P-1):
 *   - No durability. All source-of-truth state lives in IndexedDB.
 *   - `liveQuery` is the only subscription primitive used here — it already
 *     handles cross-tab updates via Dexie's observable infrastructure.
 *   - No direct network calls. Sync progress (if needed beyond counts) is
 *     observed from a BroadcastChannel — we wire that up here so the store
 *     can render "in flight" without the scheduler pushing Pinia mutations.
 */

import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { liveQuery, type Subscription } from "dexie";

import { db } from "@/offline/db";
import type { OutboxEntry } from "@/offline/types";

/**
 * Status values that count toward `pendingCount`. `in_flight` is counted
 * separately (UI shows "syncing N" vs "N pending"); the banner's "queued"
 * number is pending + in-flight so both contribute to the cashier-visible
 * depth.
 */
type PendingStatus = "enqueued" | "retry_pending";

/**
 * Minimal projection of an outbox row for the reconciliation workspace. The
 * workspace itself may query the full row when the manager opens an entry;
 * this store only needs the identity + display metadata.
 */
export interface NeedsReviewSummary {
	offline_id: string;
	type: OutboxEntry["type"];
	last_error_category: OutboxEntry["last_error_category"];
	enqueued_at: number;
}

export const useOutboxStore = defineStore("outbox", () => {
	// ---- reactive state -----------------------------------------------------

	const pendingCount = ref<number>(0);
	const inFlightCount = ref<number>(0);
	const needsReviewCount = ref<number>(0);

	/** Milliseconds (from `Date.now()`) — null when there are no pending rows. */
	const oldestPendingAt = ref<number | null>(null);

	/** Derived list for the workspace. Intentionally small projection. */
	const needsReviewEntries = ref<NeedsReviewSummary[]>([]);

	// ---- Dexie live subscriptions ------------------------------------------

	// Track subscription handles so tests can tear them down; production code
	// keeps them alive for the app's lifetime (stores are singletons).
	const subscriptions: Subscription[] = [];

	/**
	 * liveQuery for counts + oldest enqueued_at. One query keeps the index
	 * reads consolidated and fires on any row change. The query returns a
	 * plain object so Dexie diffing is straightforward.
	 */
	const countsSub = liveQuery(async () => {
		// Status-equality queries hit the `status` index.
		const [enqueued, retry, inflight, review] = await Promise.all([
			db.outbox.where("status").equals("enqueued").count(),
			db.outbox.where("status").equals("retry_pending").count(),
			db.outbox.where("status").equals("in_flight").count(),
			db.outbox.where("status").equals("needs_review").count(),
		]);

		// Oldest pending row by `enqueued_at`. We walk only rows in pending
		// statuses — bounded by the queue depth, which stays small in practice.
		// Doing this in the same liveQuery means it recomputes on any outbox
		// change, which is what we want for "oldest pending" staleness.
		let oldest: number | null = null;
		const pendingStatuses: PendingStatus[] = ["enqueued", "retry_pending"];
		for (const s of pendingStatuses) {
			const row = await db.outbox
				.where("status")
				.equals(s)
				.limit(1000)
				.toArray();
			for (const r of row) {
				if (oldest === null || r.enqueued_at < oldest) {
					oldest = r.enqueued_at;
				}
			}
		}

		return {
			enqueued,
			retry,
			inflight,
			review,
			oldest,
		};
	}).subscribe({
		next: (snap) => {
			pendingCount.value = snap.enqueued + snap.retry;
			inFlightCount.value = snap.inflight;
			needsReviewCount.value = snap.review;
			oldestPendingAt.value = snap.oldest;
		},
		error: (err) => {
			// Never mutate durability on failure; log and keep the last-known
			// counts so the UI doesn't flicker to zero on a transient Dexie
			// blip (P-14 — errors surface, but count state is transient).
			console.error("[stores/outbox] counts liveQuery error", err);
		},
	});
	subscriptions.push(countsSub);

	/**
	 * liveQuery for the reconciliation workspace feed. We only surface the
	 * projection fields the list view needs; the workspace loads the full row
	 * when the manager expands an entry.
	 */
	const reviewSub = liveQuery(async () => {
		const rows = await db.outbox
			.where("status")
			.equals("needs_review")
			.toArray();
		return rows.map<NeedsReviewSummary>((r) => ({
			offline_id: r.offline_id,
			type: r.type,
			last_error_category: r.last_error_category,
			enqueued_at: r.enqueued_at,
		}));
	}).subscribe({
		next: (rows) => {
			needsReviewEntries.value = rows;
		},
		error: (err) => {
			console.error("[stores/outbox] review liveQuery error", err);
		},
	});
	subscriptions.push(reviewSub);

	// ---- BroadcastChannel (scheduler status, advisory only) ----------------

	/**
	 * Agent 3's sync scheduler posts progress updates on a BroadcastChannel
	 * so secondary tabs (and this store) can reflect drain progress without
	 * polling. We listen advisory-only — the authoritative state is still
	 * the Dexie rows, observed by `liveQuery` above.
	 */
	const schedulerPhase = ref<"idle" | "draining" | "paused">("idle");
	let channel: BroadcastChannel | null = null;
	try {
		if (typeof BroadcastChannel !== "undefined") {
			channel = new BroadcastChannel("pospire-sync");
			channel.addEventListener("message", (ev) => {
				const data = ev.data as { phase?: string } | undefined;
				if (!data || typeof data.phase !== "string") return;
				if (
					data.phase === "idle" ||
					data.phase === "draining" ||
					data.phase === "paused"
				) {
					schedulerPhase.value = data.phase;
				}
			});
		}
	} catch (err) {
		// BroadcastChannel is best-effort; tabs without support get a static
		// "idle" value and still render correct counts from liveQuery.
		console.warn("[stores/outbox] BroadcastChannel unavailable", err);
	}

	// ---- derived --------------------------------------------------------

	/**
	 * Convenience: total count shown in the banner's "N queued" sub-label.
	 * Includes pending + in-flight because the cashier cares about depth,
	 * not whether a row is currently being POSTed.
	 */
	const queuedCount = computed<number>(
		() => pendingCount.value + inFlightCount.value,
	);

	/**
	 * Minutes since the oldest pending row was enqueued. `null` when no
	 * pending rows exist. Used by the banner escalation copy ("Offline —
	 * 48 min" when over 30 min).
	 */
	const oldestPendingMinutes = computed<number | null>(() => {
		if (oldestPendingAt.value === null) return null;
		return Math.max(
			0,
			Math.floor((Date.now() - oldestPendingAt.value) / 60_000),
		);
	});

	// ---- teardown (test harness) -------------------------------------------

	/**
	 * Cancel subscriptions. Production code never calls this — the store is a
	 * singleton and lives with the app. Tests call it between cases to avoid
	 * cross-test leakage.
	 */
	function dispose(): void {
		for (const sub of subscriptions) {
			try {
				sub.unsubscribe();
			} catch {
				/* ignore */
			}
		}
		subscriptions.length = 0;
		if (channel) {
			try {
				channel.close();
			} catch {
				/* ignore */
			}
			channel = null;
		}
	}

	return {
		// state
		pendingCount,
		inFlightCount,
		needsReviewCount,
		oldestPendingAt,
		needsReviewEntries,
		schedulerPhase,
		// derived
		queuedCount,
		oldestPendingMinutes,
		// test-only
		dispose,
	};
});
