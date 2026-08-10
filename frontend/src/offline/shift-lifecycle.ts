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

import { getShiftById, listAllShifts, putShift } from "./repos/shifts";
import type { ShiftRow } from "./types";

export interface OpenedShiftInput {
	/** Server doc name, or null when the shift was opened offline. */
	openingServerName: string | null;
	posProfile: Record<string, unknown>;
	openingCashByMop: Record<string, number>;
	cashierUser: string;
	deviceId: string;
}

/**
 * Record a newly opened shift and return its local lifecycle UUID.
 *
 * Idempotent on `openingServerName`: re-registering the same online-opened
 * shift (a reload, a second `check_opening_shift`) returns the existing UUID
 * rather than creating a duplicate row.
 */
export async function registerOpenedShift(
	input: OpenedShiftInput,
): Promise<string> {
	if (input.openingServerName) {
		const existing = await findShiftByServerName(input.openingServerName);
		if (existing) return existing.offline_id;
	}

	const offlineId = crypto.randomUUID();
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
}

/** Look a shift up by its server doc name. Null-safe on unsynced shifts. */
export async function findShiftByServerName(
	serverName: string,
): Promise<ShiftRow | undefined> {
	if (!serverName) return undefined;
	const all = await listAllShifts();
	return all.find((row) => row.opening_server_name === serverName);
}

/** Re-export so callers never reach past this module into the repo. */
export { getShiftById };
