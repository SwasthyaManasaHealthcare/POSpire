/**
 * Contributions repo — one row per invoice, keyed by the invoice's
 * `offline_id` (the same id on the live and queued submit paths).
 *
 * Only `by_mop` is encrypted: it is per-invoice money. Everything else is a
 * plaintext scalar so the ledger can query and transition rows without
 * decrypting anything.
 *
 * ENCRYPTION IS NEVER PERFORMED INSIDE A DEXIE TRANSACTION. Awaiting
 * `crypto.subtle` inside one lets IndexedDB auto-commit early and the call
 * throws `PrematureCommitError` — this silently disabled a whole feature in
 * Phase 1. `buildStoredContribution` encrypts outside; the transactional
 * helpers only ever touch plaintext scalars and pre-built stored rows.
 */

import { assertWritable, db, runInTransaction } from "../db";
import { decrypt, encrypt, getActiveKey } from "../crypto";
import type {
	ContributionRow,
	EncryptedEnvelope,
	StoredContributionRow,
} from "../types";

function aadForContribution(offlineId: string): string {
	return `contribution:${offlineId}:by_mop`;
}

/** Encrypt a contribution into its stored form. Call OUTSIDE any transaction. */
export async function buildStoredContribution(
	row: ContributionRow,
): Promise<StoredContributionRow> {
	const { key, id } = getActiveKey();
	const envelope: EncryptedEnvelope = await encrypt(
		row.by_mop,
		key,
		id,
		aadForContribution(row.offline_id),
	);
	return {
		offline_id: row.offline_id,
		shift_lifecycle_id: row.shift_lifecycle_id,
		status: row.status,
		by_mop_envelope: envelope,
		created_at: row.created_at,
		confirmed_at: row.confirmed_at,
	};
}

async function fromStored(
	stored: StoredContributionRow,
): Promise<ContributionRow> {
	const by_mop = await decrypt<Record<string, number>>(
		stored.by_mop_envelope,
		aadForContribution(stored.offline_id),
	);
	return {
		offline_id: stored.offline_id,
		shift_lifecycle_id: stored.shift_lifecycle_id,
		status: stored.status,
		by_mop,
		created_at: stored.created_at,
		confirmed_at: stored.confirmed_at,
	};
}

/** Write a pre-encrypted row. Upsert: re-staging the same invoice overwrites. */
export async function putContribution(
	stored: StoredContributionRow,
): Promise<void> {
	assertWritable();
	await db.contributions.put(stored);
}

export async function getContribution(
	offlineId: string,
): Promise<ContributionRow | undefined> {
	const stored = await db.contributions.get(offlineId);
	if (!stored) return undefined;
	return fromStored(stored);
}

/**
 * All contributions for a shift, decrypted row-by-row.
 *
 * A row whose envelope will not decrypt is SKIPPED and logged, not thrown.
 * One corrupt row must cost only its own contribution — an all-or-nothing
 * failure here would silently zero the cashier's expected amount.
 */
export async function listContributionsForShift(
	shiftLifecycleId: string,
): Promise<ContributionRow[]> {
	const stored = await db.contributions
		.where("shift_lifecycle_id")
		.equals(shiftLifecycleId)
		.toArray();
	const out: ContributionRow[] = [];
	for (const row of stored) {
		try {
			out.push(await fromStored(row));
		} catch (err) {
			console.warn(
				`[contributions] skipping undecryptable row ${row.offline_id}`,
				err,
			);
		}
	}
	return out;
}

/** Pending rows across every shift — the startup reconciliation's input. */
export async function listPendingContributions(): Promise<ContributionRow[]> {
	const stored = await db.contributions
		.where("status")
		.equals("pending")
		.toArray();
	const out: ContributionRow[] = [];
	for (const row of stored) {
		try {
			out.push(await fromStored(row));
		} catch (err) {
			console.warn(
				`[contributions] skipping undecryptable pending row ${row.offline_id}`,
				err,
			);
		}
	}
	return out;
}

/**
 * Flip a row to confirmed. Touches plaintext scalars only — the envelope is
 * carried across untouched, so no crypto runs and the transaction is safe.
 */
export async function markContributionConfirmed(
	offlineId: string,
	confirmedAt: number,
): Promise<void> {
	assertWritable();
	await runInTransaction("rw", [db.contributions], async () => {
		const existing = await db.contributions.get(offlineId);
		if (!existing) return;
		await db.contributions.put({
			...existing,
			status: "confirmed",
			confirmed_at: confirmedAt,
		});
	});
}

/** Drop a shift's contributions once they are no longer needed. */
export async function deleteContributionsForShift(
	shiftLifecycleId: string,
): Promise<number> {
	assertWritable();
	return db.contributions
		.where("shift_lifecycle_id")
		.equals(shiftLifecycleId)
		.delete();
}
