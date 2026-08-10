/**
 * Contribution ledger.
 *
 * One row per invoice, keyed by the invoice's `offline_id`. Written on BOTH
 * submit paths: `call()` injects that same id into the live request args
 * (call.ts) and the live endpoint persists it (posapp.py), so an online sale
 * and an offline one are recorded identically.
 *
 * The shift total is DERIVED by recomputing over unique contributions, never
 * accumulated. A crash between staging and confirming leaves a recoverable
 * `pending` row; a retry overwrites its own row rather than adding a second.
 * That is what makes this safe for a figure a cashier signs off.
 */

import {
	buildStoredContribution,
	deleteContributionsForShift,
	getContribution,
	listContributionsForShift,
	listPendingContributions,
	markContributionConfirmed,
	putContribution,
} from "./repos/contributions";
import { contributionForInvoice } from "./shift-lifecycle";
import type { ContributionRow } from "./types";

export interface ContributionInput {
	invoiceOfflineId: string;
	shiftLifecycleId: string;
	/** The invoice doc as it will be submitted. */
	invoice: Record<string, unknown>;
	cashMode: string;
	precision: number;
}

/**
 * Record an invoice's contribution as `pending`, BEFORE the submit is
 * attempted. Overwrites any existing row for the same invoice, so a retry is
 * idempotent by construction.
 */
export async function stageContribution(
	input: ContributionInput,
): Promise<void> {
	const byMop = contributionForInvoice(
		input.invoice,
		input.cashMode,
		input.precision,
	);
	const existing = await getContribution(input.invoiceOfflineId);
	const row: ContributionRow = {
		offline_id: input.invoiceOfflineId,
		shift_lifecycle_id: input.shiftLifecycleId,
		// A re-stage of an already-confirmed invoice keeps its confirmed
		// status — the money landed, and demoting it would make the startup
		// reconciliation re-ask the server about a settled sale.
		status: existing?.status === "confirmed" ? "confirmed" : "pending",
		by_mop: byMop,
		created_at: existing?.created_at ?? Date.now(),
		confirmed_at: existing?.confirmed_at ?? null,
	};
	// Encrypt OUTSIDE any transaction. See repos/contributions.ts.
	const stored = await buildStoredContribution(row);
	await putContribution(stored);
}

/** Mark a staged contribution as landed. Safe to call more than once. */
export async function confirmContribution(
	invoiceOfflineId: string,
): Promise<void> {
	await markContributionConfirmed(invoiceOfflineId, Date.now());
}

export interface DerivedExpected {
	byMop: Record<string, number>;
	/** Contributions still unconfirmed — surfaced so the UI can say so. */
	pendingCount: number;
}

/**
 * Recompute the shift's contribution total from its rows.
 *
 * Pending rows ARE included: the cash was physically taken whether or not the
 * record reached the server, so excluding it would show the cashier a
 * shortfall that is not in the drawer. `pendingCount` lets the UI qualify it.
 */
export async function deriveExpectedByMop(
	shiftLifecycleId: string,
	precision: number,
): Promise<DerivedExpected> {
	const rows = await listContributionsForShift(shiftLifecycleId);
	const byMop: Record<string, number> = {};
	let pendingCount = 0;
	const f = 10 ** precision;
	for (const row of rows) {
		if (row.status === "pending") pendingCount += 1;
		for (const [mop, amount] of Object.entries(row.by_mop)) {
			const next = (byMop[mop] ?? 0) + (Number(amount) || 0);
			byMop[mop] = Math.round(next * f) / f;
		}
	}
	return { byMop, pendingCount };
}

/**
 * Confirm any pending contribution whose invoice the server reports as
 * submitted. Runs at startup, after a crash between stage and confirm.
 *
 * The oracle is `offline.get_shift_invoice_offline_ids`, which returns
 * `pos_offline_id` for every submitted Sales Invoice on the shift — and both
 * submit paths persist that id, so it covers live and queued sales alike.
 */
export async function reconcilePendingContributions(opts: {
	openingServerName: string | null;
	openingOfflineId: string | null;
}): Promise<{ confirmed: string[]; stillPending: string[] }> {
	const pending = await listPendingContributions();
	if (!pending.length) return { confirmed: [], stillPending: [] };
	if (!opts.openingServerName && !opts.openingOfflineId) {
		return { confirmed: [], stillPending: pending.map((r) => r.offline_id) };
	}

	let submitted: string[] = [];
	try {
		const { call } = await import("@/utils/call");
		const result = await call<string[]>({
			method: "pospire.pospire.api.offline.get_shift_invoice_offline_ids",
			args: {
				opening_shift_name: opts.openingServerName,
				opening_shift_offline_id: opts.openingOfflineId,
			},
			intent: "read",
		});
		if (Array.isArray(result)) submitted = result.filter(Boolean);
	} catch (err) {
		// Offline, or the endpoint is unreachable. Everything stays pending —
		// that is the safe direction: the amounts still count toward the
		// displayed total, they are just flagged unconfirmed.
		console.warn("[contribution-ledger] reconciliation unavailable", err);
		return { confirmed: [], stillPending: pending.map((r) => r.offline_id) };
	}

	const landed = new Set(submitted);
	const confirmed: string[] = [];
	const stillPending: string[] = [];
	for (const row of pending) {
		if (landed.has(row.offline_id)) {
			await confirmContribution(row.offline_id);
			confirmed.push(row.offline_id);
		} else {
			stillPending.push(row.offline_id);
		}
	}
	return { confirmed, stillPending };
}

/** Re-export so callers never reach past this module into the repo. */
export { deleteContributionsForShift };
