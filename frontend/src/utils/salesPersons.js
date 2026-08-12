/**
 * Shared loader for the Sales Person list.
 *
 * Invoice and Payments each fetched this independently — Invoice on mount,
 * Payments when the cashier opens the payment screen — and each wrote the
 * result to the same `sales_persons_storage` key. The triggers do not overlap,
 * so in-flight deduplication alone would collapse nothing; the second call is
 * only avoidable by sharing the result.
 *
 * Scope of the reuse is one page session. That is strictly fresher than the
 * behaviour it replaces, where both components hydrated from a localStorage
 * entry that had no expiry at all.
 *
 * A rejection is never retained: `cached` is assigned only on success and the
 * in-flight promise is released in `finally`, so the next caller re-requests.
 * That is what lets a load which failed while offline at boot succeed later
 * from the payment screen.
 */

import { call } from "@/utils/call";

const METHOD = "pospire.pospire.api.posapp.get_sales_person_names";
const STORAGE_KEY = "sales_persons_storage";

let inFlight = null;
let cached = null;

/**
 * Last list persisted by a previous session, or null. Callers hydrate from
 * this before awaiting so the dropdown is usable offline.
 */
export function readStoredSalesPersons() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		// Quota, privacy mode, or a corrupt entry — treat as absent.
		return null;
	}
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.persist] mirror the result to localStorage; driven
 *   by the profile's `posa_local_storage` flag, which is per-component state.
 * @param {boolean} [options.force] bypass the session cache. This is the
 *   retry entry point for a master-data invalidation hook; nothing calls it
 *   yet because `pos_master_data_invalidated` carries only `items` and
 *   `customers` flags.
 */
export function loadSalesPersons({ persist = false, force = false } = {}) {
	if (!force) {
		if (cached) return Promise.resolve(cached);
		if (inFlight) return inFlight;
	}

	const promise = call(METHOD)
		.then((r) => {
			if (r) {
				cached = r;
				if (persist) {
					try {
						localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
					} catch {
						/* quota / privacy mode — non-fatal */
					}
				}
			}
			return cached;
		})
		.finally(() => {
			// Only if we still own the slot: a forced reload may have replaced it.
			if (inFlight === promise) inFlight = null;
		});

	inFlight = promise;
	return promise;
}

/** Test seam: drop the session cache and any in-flight request. */
export function resetSalesPersonsCache() {
	inFlight = null;
	cached = null;
}
