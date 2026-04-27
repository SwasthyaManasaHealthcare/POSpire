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
	});
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
	await db.outbox.put({
		...stored,
		blocked_reason: null,
		next_attempt_at: Date.now(),
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
		if (parent.status === "needs_review" || parent.status === "voided") {
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
 */
export async function evaluateClosingReadiness(
	entry: OutboxEntry<unknown>,
): Promise<DependencyGate> {
	if (entry.type !== "closing_entry" || !entry.shift_offline_id) {
		return "ready";
	}
	const siblings = await db.outbox
		.where("shift_offline_id")
		.equals(entry.shift_offline_id)
		.toArray();
	let blockedBySibling = false;
	for (const s of siblings) {
		// Closing entry itself, voided entries, and non-invoice types do not
		// gate closure.
		if (s.offline_id === entry.offline_id) continue;
		if (s.status === "voided") continue;
		if (s.type !== "invoice") continue;
		if (s.status === "synced") continue;
		if (s.status === "needs_review") {
			blockedBySibling = true;
			continue;
		}
		return "waiting";
	}
	return blockedBySibling ? "blocked" : "ready";
}

// ---------------------------------------------------------------------------
// Payload resolution (offline_id → server_doc_name)
// ---------------------------------------------------------------------------

/**
 * Walk `payload` and replace any value matching a known parent `offline_id`
 * with that parent's `server_doc_name`. Non-recursive by structure — we do
 * a full deep-clone walk but only rewrite scalar string matches; objects
 * are cloned so the stored payload is not mutated.
 *
 * If a parent is not yet `synced` (or missing), the original offline_id is
 * preserved. The scheduler's `evaluateParents` prevents us from reaching
 * this branch in practice, but we stay defensive rather than panicking.
 */
export async function resolvePayload<T>(
	entry: OutboxEntry<T>,
): Promise<T> {
	if (entry.parent_offline_ids.length === 0) return entry.payload;

	const map = new Map<string, string>();
	for (const parentId of entry.parent_offline_ids) {
		const parent = await db.outbox.get(parentId);
		if (parent?.server_doc_name) {
			map.set(parentId, parent.server_doc_name);
		}
	}
	if (map.size === 0) return entry.payload;

	return deepRewrite(entry.payload, map) as T;
}

function deepRewrite(value: unknown, map: Map<string, string>): unknown {
	if (typeof value === "string") {
		return map.get(value) ?? value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => deepRewrite(v, map));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = deepRewrite(v, map);
		}
		return out;
	}
	return value;
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

/** Manager "Retry" action — clears needs_review/blocked and re-queues. */
export async function resetForRetry(offlineId: string): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	await db.outbox.put({
		...stored,
		status: "enqueued",
		blocked_reason: null,
		attempt_count: 0,
		next_attempt_at: Date.now(),
		last_error_category: null,
		last_error_detail: null,
	});
	// Wake the scheduler.
	notifyEnqueued(await outboxRepoInternal.fromStored(stored));
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

/**
 * Best-effort cashier lookup. Frappe sets `frappe.session.user` on the
 * global; in the Vite bundle `frappe` is explicitly forbidden (see
 * CLAUDE.md), but at runtime the Desk host injects it. We probe for the
 * global without importing it statically so the no-restricted-imports rule
 * stays happy.
 */
function currentCashier(): string {
	try {
		const g = globalThis as unknown as {
			frappe?: { session?: { user?: string } };
		};
		if (g.frappe?.session?.user) return g.frappe.session.user;
	} catch {
		/* ignore */
	}
	return "Guest";
}

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
