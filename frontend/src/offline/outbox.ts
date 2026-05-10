/**
 * Outbox state machine (Agent 3).
 *
 * Sits on top of `repos/outbox.ts` (which owns Dexie CRUD) and implements the
 * write-ahead log's semantics: enqueue, ready-pickup, retry/backoff, error
 * classification, dependency resolution, void. The sync scheduler
 * (`sync.ts`) consumes this module; no component talks to it directly.
 *
 * Principles honoured (see 01-architecture-principles.md):
 *   P-5:  every queued write carries an immutable `offline_id`.
 *   P-7:  dependency order is mandatory — parents must be `synced` before a
 *         child ships.
 *   P-8:  strict closure — `closing_entry` waits for every invoice in its
 *         shift.
 *   P-11: `posting_date` and `owner_user` are snapshotted at enqueue time.
 *   P-14: persistence failures propagate; we never swallow.
 *
 * The enqueue path is atomic — a single Dexie transaction that writes the
 * outbox row and, for `closing_entry`, updates the owning `shifts` row. If
 * the transaction fails, the caller gets an error and surfaces it to the UI;
 * we do NOT retry the write silently (P-14).
 */

import {
	LS_DEVICE_ID,
	OFFLINE_PREFIX_CLOSING_ENTRY,
	OFFLINE_PREFIX_CUSTOMER,
	OFFLINE_PREFIX_INVOICE,
	OFFLINE_PREFIX_MATERIAL_RECEIPT,
	OFFLINE_PREFIX_OPENING_ENTRY,
	OFFLINE_PREFIX_RETURN,
	buildProvisionalName,
} from "./constants";
import { currentCashier } from "./cashier";
import { canonicalIntegrityHash, IntegrityMismatchError } from "./crypto";
import { db, assertWritable, uuidV4 } from "./db";
import {
	assertOfflineEnabled,
	OfflineDisabledError,
	isOfflineEnabledSync,
} from "./kill-switch";
import { registerOutboxEnqueue } from "./runtime";
import { _internal as outboxRepoInternal } from "./repos/outbox";
import * as outboxRepo from "./repos/outbox";
import type {
	LastErrorCategory,
	OutboxBlockedReason,
	OutboxEnqueueAck,
	OutboxEnqueueOptions,
	OutboxEntry,
	OutboxStatus,
	OutboxType,
	StoredOutboxEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 8 valid outbox types (mirrors `OutboxType`). Runtime-guard for the
 * loosely-typed `call-registry.ts` `outboxType: string` field. */
const VALID_TYPES = new Set<OutboxType>([
	"customer",
	"material_receipt",
	"invoice",
	"return",
	"payment",
	"cash_movement",
	"opening_entry",
	"closing_entry",
]);

/**
 * Terminal error categories — the scheduler may call `markNeedsReview` with
 * any of these. `network_error` / `server_5xx` / `timeout` /
 * `idempotent_duplicate` are transient and must not land here. NOTE:
 * `integrity_mismatch` is a `blocked_reason`, not a `last_error_category`
 * (see `markIntegrityMismatch`).
 */
const NEEDS_REVIEW_CATEGORIES = new Set<NonNullable<LastErrorCategory>>([
	"validation_error",
	"permission_error",
	"customer_missing",
	"parent_not_ready",
	"siblings_not_ready",
	"batch_or_serial_conflict",
	"stock_shortage",
	"accounting_period_closed",
	"retry_exhausted",
	"schema_mismatch",
]);

/** Retry / backoff (05-outbox-and-sync.md §4.3). */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 120_000;
export const BACKOFF_JITTER = 0.25;
export const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Enqueue notifier — the scheduler subscribes so a new entry wakes the loop.
// ---------------------------------------------------------------------------

type EnqueueListener = (entry: OutboxEntry<unknown>) => void;
const enqueueListeners = new Set<EnqueueListener>();

/** Scheduler subscribes via this. Returns an unsubscribe. */
export function onEnqueue(fn: EnqueueListener): () => void {
	enqueueListeners.add(fn);
	return () => enqueueListeners.delete(fn);
}

function notifyEnqueued(entry: OutboxEntry<unknown>): void {
	for (const fn of enqueueListeners) {
		try {
			fn(entry);
		} catch (err) {
			console.error("[outbox] enqueue listener threw", err);
		}
	}
}

/**
 * Sync-event payload. Fires once per row that transitions enqueued/in_flight
 * → synced. Consumers (Customer.vue, Invoice.vue) use this to swap any
 * in-memory references to the old offline name for the freshly-assigned
 * server doc name. The event does NOT fire for entries that voided mid-sync
 * (status stays voided in markSynced — see CAS branch).
 */
export interface SyncEvent {
	offline_id: string;
	type: OutboxType;
	server_doc_name: string;
	provisional_name: string | null;
}

type SyncListener = (event: SyncEvent) => void;
const syncListeners = new Set<SyncListener>();

/**
 * Subscribe to sync notifications. Returns an unsubscribe.
 *
 * The primary consumer is the Vue layer: when a customer that was created
 * offline finally syncs, the cart's in-memory `customer` may still hold the
 * provisional `OFFLINE-CUST-...` name. Subscribers receive
 * `{ offline_id, server_doc_name, provisional_name }` and rename the
 * reference. The fan-in is small (Customer.vue + Invoice.vue), so a simple
 * Set is enough — no need for a typed event bus.
 */
export function onSynced(fn: SyncListener): () => void {
	syncListeners.add(fn);
	return () => syncListeners.delete(fn);
}

function notifySynced(event: SyncEvent): void {
	for (const fn of syncListeners) {
		try {
			fn(event);
		} catch (err) {
			console.error("[outbox] sync listener threw", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Provisional naming
// ---------------------------------------------------------------------------

/**
 * Build the provisional name the component prints on the receipt. Prefix
 * depends on outbox type; returns `null` for types that do not have a
 * user-visible provisional name (payments, cash movements — the owning
 * invoice / shift carries the name).
 */
export function provisionalNameFor(
	type: OutboxType,
	offlineId: string,
): string {
	switch (type) {
		case "customer":
			return buildProvisionalName(OFFLINE_PREFIX_CUSTOMER, offlineId);
		case "invoice":
			return buildProvisionalName(OFFLINE_PREFIX_INVOICE, offlineId);
		case "material_receipt":
			return buildProvisionalName(
				OFFLINE_PREFIX_MATERIAL_RECEIPT,
				offlineId,
			);
		case "opening_entry":
			return buildProvisionalName(OFFLINE_PREFIX_OPENING_ENTRY, offlineId);
		case "closing_entry":
			return buildProvisionalName(OFFLINE_PREFIX_CLOSING_ENTRY, offlineId);
		case "return":
			return buildProvisionalName(OFFLINE_PREFIX_RETURN, offlineId);
		case "payment":
		case "cash_movement":
			// Not user-visible — fall back to a short id for logs/reconciliation.
			return `OFFLINE-${offlineId.slice(0, 8)}`;
	}
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

interface EnqueueExtras {
	/** Method path from call-registry — stashed for the scheduler drain. */
	method?: string;
	/** Parent offline_ids (dependency graph). */
	parentOfflineIds?: string[];
	/** Owning shift (invoice/closing/payment/cash_movement). */
	shiftOfflineId?: string | null;
	/** ISO date; defaults to device `YYYY-MM-DD`. */
	postingDate?: string;
	/** Cashier user; defaults to `frappe.session.user` proxy if available. */
	ownerUser?: string;
}

/**
 * Atomically enqueue an outbox entry. Throws on any failure — P-14 requires
 * we never silently drop. Kill-switch off → throws `OfflineDisabledError`.
 *
 * The returned ack matches `OutboxEnqueueAck` (the shape `call()` expects).
 * Components type-narrow on `offline === true` + `status === 'enqueued'`.
 */
export async function enqueue<T>(
	type: OutboxType,
	payload: T,
	options: EnqueueExtras & { offlineIdempotencyKey?: string } = {},
): Promise<OutboxEnqueueAck> {
	if (!VALID_TYPES.has(type)) {
		throw new TypeError(
			`outbox.enqueue: invalid outbox type "${type}". Must be one of: ${[...VALID_TYPES].join(", ")}.`,
		);
	}
	assertWritable();
	await assertOfflineEnabled(type);

	const offlineId = options.offlineIdempotencyKey ?? uuidV4();
	const provisional = provisionalNameFor(type, offlineId);
	const now = Date.now();
	const postingDate = options.postingDate ?? todayIsoDate();
	const ownerUser = options.ownerUser ?? currentCashier();
	const deviceId = readDeviceId();

	// Payload integrity hash — computed on PLAINTEXT BEFORE encryption. The
	// repo layer re-derives from the envelope and stores it; we compute up
	// front so the value is stable even if a concurrent key rotation happens
	// to re-encrypt the row later.
	const integrityHash = await canonicalIntegrityHash(payload);

	const entry: OutboxEntry<T> = {
		offline_id: offlineId,
		type,
		parent_offline_ids: options.parentOfflineIds ?? [],
		shift_offline_id: options.shiftOfflineId ?? null,
		device_id: deviceId,
		posting_date: postingDate,
		owner_user: ownerUser,
		payload,
		payload_integrity_hash: integrityHash,
		status: "enqueued",
		// IMPORTANT: rows with next_attempt_at === null are invisible to
		// `listReady` (IndexedDB doesn't index null). Stamp `now` so the
		// scheduler picks this up on its next wake.
		next_attempt_at: now,
		attempt_count: 0,
		blocked_reason: null,
		last_error_category: null,
		last_error_detail: null,
		server_doc_name: null,
		// Populated only when the scheduler hands off this row to the
		// server-side `POSpire Offline Sync Review` queue (status
		// transitions to `handed_off` at the same time). null on every
		// fresh enqueue.
		recovery_entry_name: null,
		enqueued_at: now,
		synced_at: null,
	};

	// Prepare the stored row inside the transaction body; encryption happens
	// in `toStored` (repos/outbox.ts internal).
	const stored = await outboxRepoInternal.toStored(entry);

	// Single Dexie transaction. For `closing_entry` we also bump the owning
	// shift's status (closed_pending_sync → syncing is the scheduler's job;
	// here we just mark the closing as queued so the UI stops offering
	// "reopen shift").
	const tables =
		type === "closing_entry" ? [db.outbox, db.shifts] : [db.outbox];

	try {
		await db.transaction("rw", tables, async () => {
			// Idempotency: a scheduler re-send that re-enters `call()` (e.g.
			// connectivity flipped mid-POST) will re-invoke enqueue with the
			// same `offline_id`. We MUST NOT clobber the existing row —
			// attempt_count, status, server_doc_name all need to survive.
			// Only write if the row is new.
			const existing = await db.outbox.get(offlineId);
			if (!existing) {
				await db.outbox.put(stored);
			}

			if (type === "closing_entry" && entry.shift_offline_id) {
				const shift = await db.shifts.get(entry.shift_offline_id);
				if (shift) {
					// Only transition if we're still in `open` or
					// `closed_pending_sync`. Never regress a `syncing`/`synced`
					// shift.
					if (
						shift.status === "open" ||
						shift.status === "closed_pending_sync"
					) {
						await db.shifts.put({
							...shift,
							status: "closed_pending_sync",
							closed_at: shift.closed_at ?? now,
						});
					}
				}
				// If the shift row is missing, we still persist the outbox row
				// (server-side closing handler validates the opening link).
			}
		});
	} catch (err) {
		// Propagate — P-14 demands the caller (usually the sale path) see
		// the failure. QuotaExceededError in particular must block the sale.
		throw err;
	}

	notifyEnqueued(entry as OutboxEntry<unknown>);

	return {
		offline: true,
		offline_id: offlineId,
		provisional_name: provisional,
		status: "enqueued",
	};
}

// ---------------------------------------------------------------------------
// `call()`-compatible wrapper — signature matches `OutboxEnqueueFn`.
// ---------------------------------------------------------------------------

async function enqueueFromCall(
	type: string,
	payload: Record<string, unknown>,
	options: OutboxEnqueueOptions,
): Promise<OutboxEnqueueAck> {
	if (!VALID_TYPES.has(type as OutboxType)) {
		throw new TypeError(
			`outbox.enqueueFromCall: method's outboxType "${type}" is not a valid OutboxType.`,
		);
	}
	// `call()` already injected `offline_id` into the payload. Pull it back
	// out so the outbox column reflects the same id used for server
	// idempotency.
	const keyFromPayload = typeof payload.offline_id === "string" ? payload.offline_id : undefined;
	const idempotencyKey = options.offlineIdempotencyKey ?? keyFromPayload;

	return enqueue(type as OutboxType, payload, {
		offlineIdempotencyKey: idempotencyKey,
		method: options.method,
		parentOfflineIds: options.parentOfflineIds,
		shiftOfflineId: options.shiftOfflineId,
		postingDate: options.postingDate,
		ownerUser: options.ownerUser,
	});
}

// ---------------------------------------------------------------------------
// Ready / pickup
// ---------------------------------------------------------------------------

/**
 * Returns the next ready entry, or `null` if none is eligible. "Ready" =
 * status in {enqueued, retry_pending} AND blocked_reason null AND
 * next_attempt_at <= now. Delegated to the repo.
 *
 * Does NOT claim the entry; the caller must follow up with `markInFlight`
 * (compare-and-swap) to avoid races with other tabs.
 */
export async function nextReady<T = unknown>(
	now = Date.now(),
): Promise<OutboxEntry<T> | null> {
	if (!isOfflineEnabledSync()) {
		// Don't drain while kill switch is off. The scheduler also checks this
		// each loop; belt-and-braces for callers that invoke directly.
		return null;
	}
	const rows = await outboxRepo.listReady<T>(now, 1);
	return rows[0] ?? null;
}

/**
 * Compare-and-swap claim of an entry from `enqueued`/`retry_pending` →
 * `in_flight`. Returns `true` when this caller won the race.
 *
 * Clears `blocked_reason` implicitly (entries with a non-null blocker are
 * filtered out of `listReady` in-memory — the scheduler must NOT call this
 * on a blocked row).
 */
export async function markInFlight(offlineId: string): Promise<boolean> {
	assertWritable();
	return db.transaction("rw", db.outbox, async () => {
		const row = await db.outbox.get(offlineId);
		if (!row) return false;
		if (row.status !== "enqueued" && row.status !== "retry_pending") {
			return false;
		}
		if (row.blocked_reason !== null) return false;
		await db.outbox.put({
			...row,
			status: "in_flight",
			last_error_category: null,
			last_error_detail: null,
		});
		return true;
	});
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

export async function markSynced(
	offlineId: string,
	serverDocName: string,
): Promise<void> {
	assertWritable();
	// Compare-and-swap: if a manager voided the row while the scheduler was
	// mid-POST, leave the `voided` status intact. The server will have an
	// extra doc; idempotency means a future replay returns the same name
	// without inserting a duplicate. The local audit trail (status=voided)
	// stays truthful.
	let cascade = false;
	let syncedEvent: SyncEvent | null = null;
	await db.transaction("rw", db.outbox, async () => {
		const row = await db.outbox.get(offlineId);
		if (!row) return;
		if (row.status === "voided") {
			// Persist the server name so reconciliation can still link the
			// voided local row to the remote doc, but don't change the status.
			await db.outbox.put({
				...row,
				server_doc_name: serverDocName,
			});
			return;
		}
		await db.outbox.put({
			...row,
			status: "synced",
			server_doc_name: serverDocName,
			synced_at: Date.now(),
			last_error_category: null,
			last_error_detail: null,
			blocked_reason: null,
			next_attempt_at: null,
		});
		cascade = true;
		syncedEvent = {
			offline_id: offlineId,
			type: row.type,
			server_doc_name: serverDocName,
			provisional_name: provisionalNameFor(row.type, offlineId),
		};
	});
	// Cascade-unblock any rows that were waiting on this parent (T7). Done
	// outside the synced row's transaction because we want a fresh `rw` txn
	// for the dependent puts and we don't need atomicity across the boundary.
	if (cascade) {
		await clearDependentsBlockedOn(offlineId);
	}
	// Fire after the transaction settles so listeners read durable state.
	// Voided-mid-sync rows (CAS branch above) intentionally do NOT fire —
	// the cart should not switch a voided customer's name to the server doc.
	if (syncedEvent) {
		notifySynced(syncedEvent);
	}
}

export async function markNeedsReview(
	offlineId: string,
	errorCategory: NonNullable<LastErrorCategory>,
	errorDetail: string | null,
): Promise<void> {
	assertWritable();
	if (!NEEDS_REVIEW_CATEGORIES.has(errorCategory)) {
		// `network_error` / `server_5xx` / `timeout` / `idempotent_duplicate`
		// are not terminal — caller used the wrong helper.
		throw new Error(
			`markNeedsReview called with non-terminal category "${errorCategory}"`,
		);
	}
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "needs_review",
		last_error_category: errorCategory,
		last_error_detail: errorDetail,
		// Freeze retries — manager must act.
		next_attempt_at: null,
	});
}

/**
 * Vacuum transition: the server-side `POSpire Offline Sync Review` row
 * for this tombstone has reached a terminal state (Resolved or Voided)
 * and we can upgrade the local row accordingly. The tombstone has done
 * its job — children that referenced this offline_id can now resolve
 * their dependency check (Resolved → server doc exists, name returned;
 * Voided → blocked forever, but at least no longer ambiguous).
 *
 * Cascade behaviour:
 *   Resolved → cascade-unblock dependents (mirrors `markSynced`'s
 *     behavior for the natural-success path). Without this, children
 *     blocked on this parent stay `blocked_reason: waiting_for_parent`
 *     forever, because `evaluateParents` only runs from `nextReady` and
 *     `listReady` excludes blocked rows. Cascading clears the block
 *     flag so the next drain cycle picks them up; if other parents
 *     are still pending, evaluateParents re-blocks the child then.
 *     Also fires `notifySynced` (mirrors `markSynced`) so the cart
 *     swaps a provisional customer name for the real server name when
 *     the manager resolves the customer via the recovery UI.
 *   Voided → do NOT cascade. The parent never produced a server doc,
 *     so the child's offline_id reference is unresolvable. Per the
 *     runbook (§2.3), managers void descendants explicitly. Cascading
 *     here would just thrash: clear → re-evaluate → re-block as
 *     `waiting_for_parent` → noisy audit + wasted cycles.
 *
 * Idempotent. Calling twice with the same target is a no-op the second
 * time because the source state will no longer be `handed_off`.
 */
export async function markVacuumed(
	offlineId: string,
	resolution: "Resolved" | "Voided",
	serverDocName: string | null = null,
): Promise<void> {
	assertWritable();
	// Read the row type before updating so we can build a SyncEvent below.
	// Only needed for the Resolved + serverDocName path, so conditional.
	const rowForNotify =
		resolution === "Resolved" && serverDocName ? await db.outbox.get(offlineId) : null;
	const target: OutboxStatus = resolution === "Resolved" ? "synced" : "voided";
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: target,
		server_doc_name: serverDocName,
		next_attempt_at: null,
		// On Resolved, stamp synced_at so the row's chronology is correct.
		// On Voided, leave it null — the row was never synced in the
		// "we got a successful submit" sense.
		synced_at: resolution === "Resolved" ? Date.now() : null,
	});
	if (resolution === "Resolved") {
		// Cascade-unblock dependents (children that listed this offline_id
		// in `parent_offline_ids` and were marked `waiting_for_parent`).
		// Same call markSynced uses — keeps the two paths' semantics aligned.
		await clearDependentsBlockedOn(offlineId);
		// Mirror markSynced: fire the rename event so listeners (Invoice.vue,
		// Customer.vue) swap the provisional name for the real server name.
		// Resolved rows from the recovery pipeline always carry a server doc
		// name; skip only if somehow absent (defensive guard).
		if (rowForNotify && serverDocName) {
			notifySynced({
				offline_id: offlineId,
				type: rowForNotify.type,
				server_doc_name: serverDocName,
				provisional_name: provisionalNameFor(rowForNotify.type, offlineId),
			});
		}
	}
}

/**
 * Tombstone transition: the row was successfully handed off to the
 * server-side `POSpire Offline Sync Review` queue. The local row stays
 * in IndexedDB so dependent rows (children referencing this offline_id
 * via `parent_offline_ids`, the shift's strict-closure check) can still
 * see it — but `listReady` excludes it, so the scheduler never picks it
 * up again. The `recovery_entry_name` field links to the server row so
 * the local vacuum pass can poll for resolution and eventually flip
 * this tombstone to `synced` (when the manager retries successfully) or
 * `voided` (when the manager voids).
 *
 * Idempotent: callers may invoke this multiple times with the same
 * recovery_entry_name (network retry on the handoff response). The CAS
 * pattern is unnecessary here because handoff itself is idempotent
 * server-side; if the scheduler hands off twice, both calls return the
 * same recovery row name and this transition writes the same value.
 */
export async function markHandedOff(
	offlineId: string,
	recoveryEntryName: string,
): Promise<void> {
	assertWritable();
	if (!recoveryEntryName) {
		throw new Error(
			`markHandedOff called with empty recoveryEntryName for ${offlineId}`,
		);
	}
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "handed_off",
		recovery_entry_name: recoveryEntryName,
		// Tombstones never re-enter the scheduler. Clearing this is a
		// belt-and-braces against a bug in `listReady` ever picking up a
		// `handed_off` row by mistake.
		next_attempt_at: null,
	});
}

/**
 * Specialised transition for integrity-mismatch detection (§8.3). Moves the
 * row to `needs_review` AND flags `blocked_reason=integrity_mismatch` so the
 * reconciliation workspace knows the row should not be retried-as-is even
 * if the manager clicks Retry without editing. Uses `schema_mismatch` as
 * the `last_error_category` (closest terminal fit).
 */
export async function markIntegrityMismatch(
	offlineId: string,
	detail: string | null,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	await db.outbox.put({
		...stored,
		status: "needs_review",
		blocked_reason: "integrity_mismatch",
		last_error_category: "schema_mismatch",
		last_error_detail: detail,
		next_attempt_at: null,
	});
}

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter, capped. Returns the delay (ms) for the
 * given attempt number (1-indexed). Exported so tests can exercise edges
 * without mocking `Date`.
 */
export function computeBackoffMs(attempt: number): number {
	const raw = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(attempt - 1, 0);
	const capped = Math.min(raw, BACKOFF_CAP_MS);
	const jitter = capped * BACKOFF_JITTER;
	// Uniform ±25%.
	const delta = (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.floor(capped + delta));
}

/**
 * Schedule a retry. If `attemptCount >= MAX_ATTEMPTS` we short-circuit to
 * `needs_review` with category `retry_exhausted` (05-outbox-and-sync.md
 * §4.3).
 *
 * `errorCategory` is expected to be a transient one (`network_error`,
 * `server_5xx`, `timeout`). We store it for observability but don't gate
 * on it.
 */
export async function scheduleRetry(
	offlineId: string,
	attemptCount: number,
	errorCategory: LastErrorCategory = "network_error",
	errorDetail: string | null = null,
): Promise<void> {
	assertWritable();
	if (attemptCount >= MAX_ATTEMPTS) {
		await markNeedsReview(offlineId, "retry_exhausted", errorDetail);
		return;
	}

	const nextAt = Date.now() + computeBackoffMs(attemptCount + 1);
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "retry_pending",
		attempt_count: attemptCount,
		next_attempt_at: nextAt,
		last_error_category: errorCategory,
		last_error_detail: errorDetail,
	});
}

// ---------------------------------------------------------------------------
// Blocking / dependency management
// ---------------------------------------------------------------------------

/**
 * Mark an entry as blocked on a parent/sibling. Entry stays `enqueued` (the
 * scheduler's `listReady` filter drops anything with a non-null
 * `blocked_reason`), so no retry clock is ticking.
 */
export async function markBlocked(
	offlineId: string,
	reason: Exclude<OutboxBlockedReason, null>,
	detail: string | null = null,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	await db.outbox.put({
		...stored,
		blocked_reason: reason,
		last_error_detail: detail,
		// Keep status=enqueued; a manager Retry from the workspace will clear
		// `blocked_reason` and re-stamp `next_attempt_at`.
		status: "enqueued",
		next_attempt_at: Date.now(),
	});
}

/** Clear the block (used when a parent transitions to synced). */
export async function clearBlocked(offlineId: string): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) return;
	if (stored.blocked_reason === null) return;
	if (stored.status === "voided") return; // terminal — don't unblock
	await db.outbox.put({
		...stored,
		blocked_reason: null,
		next_attempt_at: Date.now(),
	});
}

/**
 * Find all outbox rows that list `parentOfflineId` in their
 * `parent_offline_ids`, and clear their `blocked_reason` so they re-enter
 * the drain queue. Called from `markSynced` and `resetForRetry` to cascade-
 * unblock dependents when their parent transitions to a syncable state.
 *
 * `evaluateParents` re-runs at drain time, so if OTHER parents are still
 * in needs_review the row will be re-blocked then. Optimistic clearing
 * keeps the state machine moving without coupling the dependency graph
 * traversal into this helper.
 */
export async function clearDependentsBlockedOn(
	parentOfflineId: string,
): Promise<void> {
	assertWritable();
	const all = await db.outbox.toArray();
	const dependents = all.filter(
		(row) =>
			row.parent_offline_ids.includes(parentOfflineId) &&
			(row.blocked_reason === "waiting_for_parent" ||
				row.blocked_reason === "waiting_for_siblings") &&
			row.status !== "voided" &&
			row.status !== "synced",
	);
	if (dependents.length === 0) return;
	await db.transaction("rw", db.outbox, async () => {
		for (const dep of dependents) {
			await db.outbox.put({
				...dep,
				blocked_reason: null,
				next_attempt_at: Date.now(),
			});
		}
	});
}

/**
 * Resolve parent status for an entry. Returns:
 *   `ready`   → every parent is synced; entry may ship.
 *   `waiting` → at least one parent is still in-flight/enqueued; defer.
 *   `blocked` → at least one parent is in needs_review; caller marks the
 *               child blocked with `waiting_for_parent`.
 */
export type DependencyGate = "ready" | "waiting" | "blocked";

export async function evaluateParents(
	entry: OutboxEntry<unknown>,
): Promise<DependencyGate> {
	if (entry.parent_offline_ids.length === 0) return "ready";
	let blockedByParent = false;
	for (const parentId of entry.parent_offline_ids) {
		const parent = await db.outbox.get(parentId);
		if (!parent) {
			// Parent row missing entirely is a hard block — we can't reason
			// about its status. Treat as blocked so the UI surfaces it.
			blockedByParent = true;
			continue;
		}
		if (parent.status === "synced") continue;
		if (
			parent.status === "needs_review" ||
			parent.status === "voided" ||
			// Tombstone for a row handed off to the server-side review queue.
			// The work isn't done on the server yet (recovery row is Pending
			// Review / Retrying), so this child cannot ship — its references
			// to parent_offline_id won't resolve. The local vacuum pass
			// flips the tombstone to `synced` once the server-side recovery
			// row reaches Resolved, at which point the child unblocks.
			parent.status === "handed_off"
		) {
			blockedByParent = true;
			continue;
		}
		// in_flight / retry_pending / enqueued → still waiting
		return "waiting";
	}
	return blockedByParent ? "blocked" : "ready";
}

/**
 * Strict closure (P-8): a `closing_entry` may only ship once every invoice
 * belonging to the same shift has `status=synced`. Returns the same tri-state
 * as `evaluateParents`.
 *
 * Two scan modes:
 *   - Offline-opened shift: index seek on `shift_offline_id` (fast, uses
 *     the existing Dexie index).
 *   - Online-opened shift: `entry.shift_offline_id` is null, so the index
 *     seek would miss every sibling. Fall back to decrypting the closing's
 *     inner doc to learn the real shift name, then scan invoice rows by
 *     inner `posa_pos_opening_shift`. Cost is O(N invoice rows) with one
 *     JSON.parse per row — bounded by outbox depth, runs only when an
 *     online-opened shift's closing is in flight.
 *
 * Without the second branch a closing for an online-opened shift would
 * always report "ready" here, the scheduler would fire it immediately,
 * and the server's strict-closure orphan check would reject it as
 * siblings_not_ready. Manager would then have to void+retry manually.
 */
export async function evaluateClosingReadiness(
	entry: OutboxEntry<unknown>,
): Promise<DependencyGate> {
	if (entry.type !== "closing_entry") return "ready";

	let siblings: typeof entry[] = [];
	if (entry.shift_offline_id) {
		// Fast path — index seek.
		siblings = (await db.outbox
			.where("shift_offline_id")
			.equals(entry.shift_offline_id)
			.toArray()) as unknown as typeof entry[];
	} else {
		// Slow path — derive the shift's real name from the closing's own
		// inner doc, then scan invoice rows by their inner shift reference.
		const closingShiftName = readInnerShiftName(entry.payload);
		if (!closingShiftName) return "ready"; // can't gate without an anchor
		const allInvoices = (await db.outbox
			.where("type")
			.equals("invoice")
			.toArray()) as unknown as typeof entry[];
		siblings = allInvoices.filter((row) => {
			if (row.shift_offline_id) return false; // different (offline) shift
			const inner = readInnerShiftName(row.payload);
			return inner === closingShiftName;
		});
	}

	let blockedBySibling = false;
	for (const s of siblings) {
		// Closing entry itself, voided entries, and non-invoice types do not
		// gate closure.
		if (s.offline_id === entry.offline_id) continue;
		if (s.status === "voided") continue;
		if (s.type !== "invoice") continue;
		if (s.status === "synced") continue;
		if (s.status === "needs_review" || s.status === "handed_off") {
			// `handed_off` mirrors `needs_review` for closure-readiness:
			// the sibling's work hasn't completed server-side, so the
			// strict-closure invariant ("every invoice on this shift is
			// submitted") doesn't hold. Block the closing until the
			// recovery row resolves and the local vacuum upgrades this
			// sibling's tombstone to `synced`.
			blockedBySibling = true;
			continue;
		}
		return "waiting";
	}
	return blockedBySibling ? "blocked" : "ready";
}

/**
 * Best-effort extraction of the inner doc's `posa_pos_opening_shift` from
 * an outbox payload. Outbox payloads for offline-capable writes use the
 * wrapper shape `{ data: "<JSON inner doc>", … }`; for non-wrapper shapes
 * (legacy entries) we read the field directly. Returns `null` if neither
 * shape produces a string.
 */
function readInnerShiftName(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (typeof p.data === "string") {
		try {
			const inner = JSON.parse(p.data) as Record<string, unknown>;
			const name =
				(inner.posa_pos_opening_shift as string | undefined) ??
				(inner.pos_opening_shift as string | undefined);
			return typeof name === "string" && name.length > 0 ? name : null;
		} catch {
			return null;
		}
	}
	const direct =
		(p.posa_pos_opening_shift as string | undefined) ??
		(p.pos_opening_shift as string | undefined);
	return typeof direct === "string" && direct.length > 0 ? direct : null;
}

// ---------------------------------------------------------------------------
// Payload resolution (offline_id → server_doc_name)
// ---------------------------------------------------------------------------

/**
 * Defensively pass payload through unchanged for the wrapper-shaped writes
 * the offline pipeline produces today.
 *
 * **Why this used to rewrite, and why it can't.**
 * The original intent was: if a parent has synced and we know its real
 * server doc name, replace the parent's offline UUID with that name in the
 * payload before sending. That sounds fine until you remember the wrapper
 * shape every offline-capable adapter produces:
 *
 *   { data: "<JSON inner doc>",            // string (NOT walked)
 *     offline_id: "<this row's UUID>",
 *     device_id: "<UUID>",
 *     opening_entry_offline_id: "<UUID>",  // PROTOCOL field — server
 *     material_receipt_offline_ids: [...]  //   resolves these to names
 *   }
 *
 * The wrapper's `opening_entry_offline_id` and `material_receipt_offline_ids`
 * elements ARE the parent UUIDs. A string-match deep-rewrite would replace
 * them with server doc names, after which the server's `_validate_uuid` /
 * `_resolve_opening_shift` / `_resolve_material_receipts` reject the
 * payload as "Invalid uuid". The server is already the authoritative
 * resolver — front-end pre-resolution is a no-op at best (inner doc lives
 * inside a JSON STRING the walker doesn't recurse into) and an active
 * sabotage at worst (wrapper protocol fields get rewritten).
 *
 * The function is kept as an explicit pass-through (not deleted) because
 * `sync.ts` calls it on every send. If a future non-wrapper outbox shape
 * needs front-end resolution, restore a *scoped* rewrite — never one that
 * walks protocol fields.
 *
 * P-7's gating still happens via `evaluateParents` + `evaluateClosingReadiness`
 * (we don't ship until parents are synced/voided). Server-side
 * `_resolve_*` then maps UUIDs to real doc names at submit time.
 */
export async function resolvePayload<T>(
	entry: OutboxEntry<T>,
): Promise<T> {
	return entry.payload;
}

// ---------------------------------------------------------------------------
// Void (business action — row stays, never deleted)
// ---------------------------------------------------------------------------

/**
 * Void an outbox entry. Business action: row remains for audit with
 * `status=voided`; `last_error_detail` stores the reason. Never deletes.
 */
export async function voidEntry(
	offlineId: string,
	reason: string,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "synced") {
		throw new Error(
			`Cannot void ${offlineId}: already synced as ${stored.server_doc_name}. Use a reversal, not a void.`,
		);
	}
	await db.outbox.put({
		...stored,
		status: "voided",
		last_error_category: stored.last_error_category,
		last_error_detail: reason,
		next_attempt_at: null,
	});
}

// ---------------------------------------------------------------------------
// Integrity verification (called by scheduler before POST)
// ---------------------------------------------------------------------------

/**
 * Re-decrypt + re-hash the payload and confirm the integrity hash matches
 * what was stored at enqueue. Mismatch / decrypt failure → the row is marked
 * needs_review with category `integrity_mismatch` and the caller must skip
 * sending. Returns the plaintext payload on success (saves the scheduler a
 * second decrypt).
 */
export async function verifyIntegrity<T>(
	entry: OutboxEntry<T>,
): Promise<{ ok: true; payload: T } | { ok: false; detail: string }> {
	try {
		// The repo's `fromStored` already verifies via the envelope's own
		// hash (IntegrityMismatchError in crypto.ts). We also confirm the
		// sibling column `payload_integrity_hash` agrees — if it's been
		// tampered with in-place the values will diverge.
		const recomputed = await canonicalIntegrityHash(entry.payload);
		if (recomputed !== entry.payload_integrity_hash) {
			return {
				ok: false,
				detail: `stored_hash=${entry.payload_integrity_hash} recomputed=${recomputed}`,
			};
		}
		return { ok: true, payload: entry.payload };
	} catch (err) {
		if (err instanceof IntegrityMismatchError) {
			return { ok: false, detail: err.message };
		}
		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// Light read helpers re-exposed (scheduler, UI badge)
// ---------------------------------------------------------------------------

export async function getEntry<T = unknown>(
	offlineId: string,
): Promise<OutboxEntry<T> | undefined> {
	return outboxRepo.getOutboxEntry<T>(offlineId);
}

export async function listByStatus<T = unknown>(
	status: OutboxStatus,
): Promise<OutboxEntry<T>[]> {
	return outboxRepo.listByStatus<T>(status);
}

export async function countPending(): Promise<number> {
	return outboxRepo.countPending();
}

/**
 * F7 — Edit & Retry. Mutates the queued payload, re-encrypts, and re-queues
 * for the scheduler.
 *
 * Used by the per-category fix flows in the reconciliation workspace
 * (date-retry, serial-swap, detach-parent, detach-sibling). The caller
 * decrypts via `getEntry`, computes the desired payload, and hands the
 * mutated value back here. We:
 *   1. Re-encrypt under the same AAD (offline_id) so the audit hash chain
 *      stays bound to the original row identity.
 *   2. Recompute `payload_integrity_hash` so `verifyIntegrity` agrees.
 *   3. Update the indexed sibling columns `posting_date` / `parent_offline_ids`
 *      when the caller patches them (otherwise the scheduler's parent
 *      evaluator and the accounting-period check still see the old values).
 *   4. Reset status to `enqueued`, clear error fields, attempt_count=0.
 *   5. Notify enqueue listeners so the scheduler wakes immediately.
 *
 * Refuses on `voided` or `synced` rows — those are terminal. A synced row
 * already has a real server doc; the right tool is a reversal, not an edit.
 */
export async function patchPayloadAndReset(
	offlineId: string,
	patchedPayload: unknown,
	indexedOverrides: {
		posting_date?: string;
		parent_offline_ids?: string[];
	} = {},
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "voided") {
		throw new Error(
			`Cannot edit ${offlineId}: row is voided. Re-create the entry instead.`,
		);
	}
	if (stored.status === "synced") {
		throw new Error(
			`Cannot edit ${offlineId}: already synced as ${stored.server_doc_name}. Use a reversal, not an edit.`,
		);
	}

	// Re-encrypt + re-hash the patched payload. Keep the existing top-level
	// fields the caller didn't override (device_id, owner_user, type, etc.) —
	// those are bound to the original write context and changing them would
	// change attribution.
	const integrityHash = await canonicalIntegrityHash(patchedPayload);
	const newEntry: OutboxEntry<unknown> = {
		// Decrypt the existing entry so we have the full plain shape, then
		// override the mutable bits. Avoids the caller having to re-supply
		// fields they don't intend to touch.
		...(await outboxRepoInternal.fromStored(stored)),
		payload: patchedPayload,
		payload_integrity_hash: integrityHash,
		// Reset the lifecycle so the scheduler picks it back up.
		status: "enqueued",
		blocked_reason: null,
		attempt_count: 0,
		next_attempt_at: Date.now(),
		last_error_category: null,
		last_error_detail: null,
	};
	if (indexedOverrides.posting_date !== undefined) {
		newEntry.posting_date = indexedOverrides.posting_date;
	}
	if (indexedOverrides.parent_offline_ids !== undefined) {
		newEntry.parent_offline_ids = indexedOverrides.parent_offline_ids;
	}

	const newStored = await outboxRepoInternal.toStored(newEntry);
	await db.outbox.put(newStored);

	// Wake the scheduler. Pass the in-memory entry so listeners don't need
	// to decrypt again.
	notifyEnqueued(newEntry);

	// Cascade-unblock dependents (mirrors resetForRetry — same reason).
	await clearDependentsBlockedOn(offlineId);
}

/** Manager "Retry" action — clears needs_review/blocked and re-queues. */
export async function resetForRetry(offlineId: string): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "voided") return; // terminal — refuse to revive

	// Build the post-update on-disk row, then persist it. Notify listeners
	// with the SAME post-update shape (decrypted) — the prior version
	// notified with the pre-update row, so subscribers (Pinia store, sync
	// scheduler, telemetry) saw stale `status` / `last_error_category` /
	// `attempt_count` immediately after a Retry click.
	const updatedStored = {
		...stored,
		status: "enqueued" as const,
		blocked_reason: null,
		attempt_count: 0,
		next_attempt_at: Date.now(),
		last_error_category: null,
		last_error_detail: null,
	};
	await db.outbox.put(updatedStored);
	// Wake the scheduler with the fresh state, not the stale snapshot.
	notifyEnqueued(await outboxRepoInternal.fromStored(updatedStored));
	// Cascade-unblock dependents that were parked on this parent (T7).
	// They'll re-evaluate parents on the next drain — if this one is now
	// in retry_pending/in_flight, they'll move to "waiting" not "blocked",
	// keeping them out of the workspace's manual-action queue.
	await clearDependentsBlockedOn(offlineId);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readDeviceId(): string {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem(LS_DEVICE_ID) ?? "unknown-device";
		}
	} catch {
		/* strict-privacy browsers */
	}
	return "unknown-device";
}

// `currentCashier` is sourced from the shared module at @/offline/cashier
// so call-registry.ts adapters and outbox.ts agree on one implementation
// (and one fallback ladder). The earlier two-copy state silently bypassed
// the cookie fallback whenever an adapter pre-stamped owner_user via
// `options.ownerUser`, since adapters used a less-safe local helper.

function todayIsoDate(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Runtime registration — wires `@/utils/call` to this module. Executed at
// module-init time so any component that imports from `@/offline/outbox`
// also triggers the registration.
// ---------------------------------------------------------------------------

registerOutboxEnqueue(enqueueFromCall);

// Re-export the error type so callers (UI banner) can catch by type without
// knowing about the kill-switch module.
export { OfflineDisabledError };

// Re-export the raw stored row type for the audit-export module.
export type { StoredOutboxEntry };
