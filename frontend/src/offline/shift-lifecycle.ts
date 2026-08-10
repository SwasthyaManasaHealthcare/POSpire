/**
 * Shift lifecycle authority.
 *
 * `db.shifts` is the durable answer to "which shift is active, which shifts
 * are closing, and is selling allowed right now". The outbox remains the
 * durable command / audit log and the source for startup reconciliation —
 * the two are not competing stores: one holds state, the other holds intent.
 *
 * Before this module, all three of those facts lived in Vue component memory
 * plus a single-slot `localStorage` snapshot that the close path nulled out.
 * A single slot cannot represent "shift A is closing-pending" and "shift B is
 * active" at the same time, which is the normal state right after an offline
 * close — the cashier is routed to the opening dialog and may open B while
 * A's closing waits to sync.
 *
 * Every shift gets a local lifecycle UUID on open, INCLUDING shifts opened
 * online. Without it there is no stable key to hang state on before a server
 * name exists, and the online-opened case is precisely the one that breaks.
 */

import { listClosingEntryStatuses } from "./outbox";
import {
	buildStoredShift,
	getShiftById,
	getShiftByOpeningServerName,
	listPendingClosingShifts,
	putShiftIfAbsent,
	updateShiftStatus,
} from "./repos/shifts";
import type { OutboxStatus, ShiftRow } from "./types";

export interface OpenedShiftInput {
	/**
	 * Server doc name, or null when the shift has no confirmed server
	 * identity yet. NOTE: this is NOT simply "shift opened offline" — a
	 * synced offline shift keeps its (now permanent) `pos_offline_id`
	 * server-side, so callers must key this off a sync-status flag
	 * (e.g. `pospire_pending_sync`), not off `pos_offline_id`'s presence.
	 */
	openingServerName: string | null;
	posProfile: Record<string, unknown>;
	openingCashByMop: Record<string, number>;
	cashierUser: string;
	deviceId: string;
	/**
	 * Durable identity for a shift that has no server name yet (i.e. an
	 * unsynced offline-opened shift) — its outbox `offline_id`
	 * (`pos_offline_id` on the in-memory/provisional shift object).
	 * Without this, every reload of an unsynced offline shift would
	 * `crypto.randomUUID()` a brand-new row, breaking `getOpenShift()`'s
	 * "at most one open shift per device" invariant. Leave undefined for
	 * the online path, where `openingServerName` is the dedupe key.
	 */
	lifecycleId?: string;
}

/**
 * Record a newly opened shift and return its local lifecycle UUID.
 *
 * Idempotent on `openingServerName` when present (online path / synced
 * shift), otherwise on `lifecycleId` (unsynced offline path). Either way,
 * re-registering an existing shift returns its EXISTING row's id unchanged
 * — it never overwrites, since by the time of a re-registration Task 9's
 * closing flow may already have advanced this row past `open`.
 *
 * The row is encrypted (`buildStoredShift`) BEFORE the transactional
 * dedupe-then-put (`putShiftIfAbsent`), never inside it. `crypto.subtle`
 * returns native, non-Dexie promises; awaiting one inside a Dexie
 * transaction's callback lets IndexedDB auto-commit the transaction out
 * from under it (`PrematureCommitError`), which silently defeats both the
 * dedupe check AND the write on every single call — this was tried in an
 * earlier revision and reproduced against this exact function in review.
 * Encrypting a row that turns out to be a duplicate (the dedupe-hit path)
 * is wasted work, but that's a rare path and a cheap price for the
 * transaction actually working.
 */
export async function registerOpenedShift(
	input: OpenedShiftInput,
): Promise<string> {
	const offlineId = input.lifecycleId ?? crypto.randomUUID();
	const row: ShiftRow = {
		offline_id: offlineId,
		device_id: input.deviceId,
		cashier_user: input.cashierUser,
		pos_profile: input.posProfile,
		opening_cash_by_mop: input.openingCashByMop,
		opened_at: Date.now(),
		opening_server_name: input.openingServerName,
		closing_cash_by_mop: null,
		expected_closing_by_mop: null,
		variance_at_close: null,
		variance_at_sync: null,
		closing_notes: null,
		closed_at: null,
		closing_server_name: null,
		pending_closing_offline_id: null,
		status: "open",
		manager_approval_required: false,
	};
	const stored = await buildStoredShift(row);
	return putShiftIfAbsent(stored, {
		openingServerName: input.openingServerName,
		lifecycleId: input.lifecycleId,
	});
}

/**
 * Look a shift up by its server doc name. Null-safe on unsynced shifts.
 * Delegates to the repo's indexed-free `.filter()` lookup so a single
 * corrupt row elsewhere in the table can't take down every registration
 * attempt (as `listAllShifts()` + decrypt-all would).
 */
export async function findShiftByServerName(
	serverName: string,
): Promise<ShiftRow | undefined> {
	if (!serverName) return undefined;
	return getShiftByOpeningServerName(serverName);
}

/** Re-export so callers never reach past this module into the repo. */
export { getShiftById };

/**
 * Outbox statuses that mean "this command has NOT landed on the server yet".
 * `synced` and `voided` are both terminal and both mean the closing is no
 * longer in flight, so neither keeps a shift locked.
 */
const UNSYNCED_OUTBOX_STATUSES: ReadonlySet<OutboxStatus> = new Set([
	"enqueued",
	"in_flight",
	"retry_pending",
	"needs_review",
	"handed_off",
]);

/**
 * Mark a shift as closing-pending against a queued closing entry.
 *
 * The link is `pending_closing_offline_id` — the closing's own outbox id —
 * and NOT `closing_server_name`, which does not exist until the closing has
 * actually synced.
 */
export async function markShiftClosingPending(
	shiftLifecycleId: string,
	closingOfflineId: string,
): Promise<void> {
	await updateShiftStatus(shiftLifecycleId, "closed_pending_sync", {
		closed_at: Date.now(),
		pending_closing_offline_id: closingOfflineId,
	});
}

/**
 * Resolve a synced closing back to its shift.
 *
 * Keys off the CLOSING's own offline_id, never off whatever shift happens to
 * be active — reading the active shift's marker is what let a synced closing
 * for shift A reset shift B, and what made the handler silently no-op after
 * a reload. Returns null when no shift is waiting on this closing, so an
 * unknown id changes nothing.
 */
export async function resolveClosingSynced(
	closingOfflineId: string,
	closingServerName: string | null = null,
): Promise<{ shiftLifecycleId: string; wasActive: boolean } | null> {
	if (!closingOfflineId) return null;
	const pending = await listPendingClosingShifts();
	const match = pending.find(
		(row) => row.pending_closing_offline_id === closingOfflineId,
	);
	if (!match) return null;

	await updateShiftStatus(match.offline_id, "synced", {
		pending_closing_offline_id: null,
		// The server's name for the closing doc. The row would otherwise never
		// learn it — this is the only moment it exists AND we know which shift
		// it belongs to.
		closing_server_name: closingServerName,
	});
	return {
		shiftLifecycleId: match.offline_id,
		// The shift was still awaiting its close (rather than already
		// advanced past it by a reconciliation pass) when this landed.
		wasActive: match.status === "closed_pending_sync",
	};
}

/**
 * Is selling blocked right now?
 *
 * Blocked ONLY when the shift the cashier is actively on is itself closing.
 * A closing-pending shift A must not lock selling on a freshly opened B —
 * chained offline shifts are a supported requirement, and blocking them
 * would halt sales during exactly the outage offline mode exists for.
 */
export async function isSellingBlocked(
	activeShiftLifecycleId: string | null,
): Promise<boolean> {
	if (!activeShiftLifecycleId) return false;
	const row = await getShiftById(activeShiftLifecycleId);
	return row?.status === "closed_pending_sync";
}

/**
 * Rebuild closing-pending state from the outbox after a reload.
 *
 * The outbox is the durable command log and therefore the reconciliation
 * source; `db.shifts` is what the running app reads. Any shift whose queued
 * closing has already left the unsynced set is RELEASED here — it landed (or
 * was voided) while the app was closed.
 *
 * Returns both halves. `released` is not bookkeeping: the caller must
 * invalidate any cached opening snapshot naming a released shift, or an
 * offline boot re-applies that snapshot and rings sales against a shift that
 * is closed server-side.
 */
export async function reconcilePendingClosuresFromOutbox(): Promise<{
	stillPending: string[];
	released: string[];
}> {
	const closingStatusById = new Map(
		(await listClosingEntryStatuses()).map((row) => [
			row.offline_id,
			row.status,
		]),
	);

	const stillPending: string[] = [];
	const released: string[] = [];
	for (const row of await listPendingClosingShifts()) {
		const pendingId = row.pending_closing_offline_id;
		if (!pendingId) continue;
		const closingStatus = closingStatusById.get(pendingId);
		if (closingStatus && UNSYNCED_OUTBOX_STATUSES.has(closingStatus)) {
			stillPending.push(row.offline_id);
			continue;
		}
		await updateShiftStatus(row.offline_id, "synced", {
			pending_closing_offline_id: null,
			// A voided closing means the shift was never closed at all, so it
			// must not keep carrying a close timestamp. An absent row (vacuumed
			// tombstone) tells us nothing either way, so leave `closed_at` be.
			...(closingStatus === "voided" ? { closed_at: null } : {}),
		});
		released.push(row.offline_id);
	}
	return { stillPending, released };
}
