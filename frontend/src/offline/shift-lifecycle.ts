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

import { runInTransaction, db } from "./db";
import {
	getShiftById,
	getShiftByOpeningServerName,
	putShift,
} from "./repos/shifts";
import type { ShiftRow } from "./types";

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
 * The find-then-put is wrapped in a single `runInTransaction` because two
 * `applyOpeningSnapshot` calls for the same shift (cached snapshot + live
 * response) can race each other; without the transaction both could pass
 * the "not found" check before either writes, producing two rows.
 */
export async function registerOpenedShift(
	input: OpenedShiftInput,
): Promise<string> {
	return runInTransaction("rw", [db.shifts], async () => {
		if (input.openingServerName) {
			const existing = await findShiftByServerName(input.openingServerName);
			if (existing) return existing.offline_id;
		} else if (input.lifecycleId) {
			const existing = await getShiftById(input.lifecycleId);
			if (existing) return existing.offline_id;
		}

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
		await putShift(row);
		return offlineId;
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
