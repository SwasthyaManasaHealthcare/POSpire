# Phase 2 follow-ups discovered during Phase 1

This document collects items that were intentionally deferred from Phase 1
because they fit better with Phase 2's observability + maturity scope. Each
entry has the file location of the relevant Phase 1 stub so the Phase 2
implementer can pick up where Phase 1 left off.

---

## 1. DEGRADED connectivity state — wire detector logic

**Phase 1 status:** type union and UI state are present; detector never emits.

**What ships in Phase 1:**
- `ConnectivityStatus` type union includes `"degraded"`
  ([`frontend/src/offline/connectivity.ts:24`](../../../frontend/src/offline/connectivity.ts#L24))
- OfflineBanner has a fully styled DEGRADED state with copy + icon + amber
  background ([`frontend/src/components/offline/OfflineBanner.vue:62, 173`](../../../frontend/src/components/offline/OfflineBanner.vue))
- Pinia store handles the three-way `connectionQuality` correctly
  ([`frontend/src/stores/connectivity.ts:83`](../../../frontend/src/stores/connectivity.ts#L83))

**What's missing:** `reportRequestOutcome()` only transitions between
ONLINE and OFFLINE. There is no code path that calls
`transition('degraded', ...)`.

**Phase 2 work:**
1. Track per-ping RTT in a rolling window (already partly tracked via
   `state.lastPingRttMs`).
2. Introduce an RTT band: e.g. `> 500ms` median over the last 5 pings
   → DEGRADED; `< 200ms` over the last 5 → back to ONLINE.
3. Add transitions in `recordSuccess` / `recordFailure` (or a new helper)
   that consult the RTT band.
4. Add a unit test in `__tests__/offline/connectivity.test.ts` that drives
   a DEGRADED transition by feeding slow pings.
5. Once DEGRADED actually fires, add the "Sync now" button on the
   DEGRADED banner state — calls `scheduler.kick()` to nudge the drain
   loop without waiting for the next idle wake.

**Estimate:** ~30 lines + 1 test in connectivity, ~10 lines in OfflineBanner.

---

## 2. ReconciliationWorkspace — full UX

**Phase 1 ship:** list view with three tabs.
- "Needs review" tab: per-row Retry, Edit & Retry (placeholder toast),
  Void with confirmation
- "Pending" tab: read-only list of in-flight / retry-pending / queued rows
- Empty states for both tabs

**Phase 2 work** (per [`docs/offline/11-ui-ux.md`](../11-ui-ux.md) §5):
- Shift-level grouping (roll-up of invoices under each shift, with a
  "waiting for N invoices" line on the closing entry).
- Filter bar (by shift, status, device, cashier).
- **Edit & Retry**: structured per-field editor with audit-logged diff —
  task 2.8 in the phase plan. Currently surfaces a "coming soon" toast.
- Category-specific actions:
  - `customer_missing` → "Map to existing customer" picker
  - `accounting_period_closed` → "Reopen period and post" / "Void and
    reissue in current period"
  - `batch_or_serial_conflict` → "Pick different batch / serial"
  - `integrity_mismatch` → shadow-journal surface + recover-or-void
- Audit-trail side panel (enqueue → every attempt → every manager action).

---

## 3. `stores/connectivity.ts` — module-level subscribe guard

**Phase 1 ship:** working in production; surfaces in tests.

**Issue:** the store uses a module-level `let unsubscribe: (() => void) | null`
guard ([`frontend/src/stores/connectivity.ts:51-63`](../../../frontend/src/stores/connectivity.ts#L51-L63)).
When the Pinia instance is recreated at runtime — Vite HMR, test isolation,
or a tab that re-bootstraps the app — `ensureSubscribed()` short-circuits
because `unsubscribe` from the previous lifecycle is still set, and the new
store instance never receives `onChange` events.

**Workaround in tests:** `vi.resetModules()` + dynamic import per test
(see [`__tests__/stores/connectivity.test.ts`](../../../frontend/__tests__/stores/connectivity.test.ts)).

**Phase 2 fix:** move `unsubscribe` into the setup closure (per-instance).
Each new Pinia store gets its own listener; no leaks because the previous
store instance + its closure are GC'd when Pinia drops them. ~5 lines.

---

## 4. `pospire.api.offline.create_return` endpoint missing

**Phase 1 ship:** client-side outbox `'return'` type is implemented
(D-30); `methodForEntry` in `sync.ts` routes to
`pospire.pospire.api.offline.create_return`.

**Issue:** the server endpoint does not exist in `offline.py`. Returns
queued offline today will land in `needs_review` with HTTP 404 once the
client tries to POST.

**Phase 2 work:** implement the endpoint, mirroring `submit_invoice`:
- Idempotent on `pos_offline_id`
- Resolves `parent_offline_ids` (the original invoice's `offline_id` →
  server name) before creating the Sales Invoice (return) / Stock Entry
- Same error taxonomy as `submit_invoice`

---

## 5. `POSpire Offline Settings` doctype + kill switch

**Phase 1 ship:** client-side kill-switch logic complete
([`frontend/src/offline/kill-switch.ts`](../../../frontend/src/offline/kill-switch.ts)).
Default is `true` (offline enabled) when the doctype is missing.

**Phase 2 work:** create the Single doctype with `enabled: bool` field +
audit fields (who toggled, when, reason). System Manager only.

---

## 6. `Pos.vue` lifecycle handoff for the SyncScheduler

**Phase 1 ship:** scheduler exported as a singleton at the tail of
[`frontend/src/offline/sync.ts`](../../../frontend/src/offline/sync.ts).
Not auto-started on import (would break tests + Storybook).

**Phase 2 work:** `Pos.vue` (or whoever owns app bootstrap) calls
`scheduler.start()` on mount and `scheduler.stop()` on unmount.

Same component should also listen for the navbar / banner
`open-reconciliation` event (now emitted by both Navbar.vue and
OfflineBanner.vue) and route to the ReconciliationWorkspace.

---

## 7. AbortSignal not forwarded by `call()` to frappe-ui

**Phase 1 ship:** `call({ abortSignal })` is accepted in the `CallOptions`
interface but not passed through to frappe-ui's `call(method, args)`.
[`frontend/src/utils/call.ts`](../../../frontend/src/utils/call.ts) has
an inline TODO marker.

**Implication:** `scheduler.stop()` cannot hard-abort an in-flight fetch;
it waits for natural completion. Acceptable for v1 since drain entries
are short HTTP requests.

**Phase 2 work:** thread the signal through frappe-ui's request, or
replace frappe-ui call with a thin fetch wrapper inside `call.ts`.

---

## 8. `was_already_submitted` in error-branch path (sync.ts)

**Phase 1 ship:** 2xx success path correctly classifies
`was_already_submitted` as synced. But the error-branch classifier in
[`frontend/src/offline/sync.ts:772-778`](../../../frontend/src/offline/sync.ts#L772)
maps it to `kind: "retry"` with category `idempotent_duplicate`, which
wastes a retry cycle before the next POST returns 2xx.

**Phase 2 work:** treat `error_code === 'was_already_submitted'` as
synced in the error branch too; extract `server_doc_name` from the error
envelope so we mark the row complete on the same response.

---

## 9. Customer row plaintext fields — security review gate

**Phase 1 ship:** `name`, `mobile_no`, `customer_group`, `offline_created`,
`cached_at` are stored plaintext on the customer row to enable prefix
search without per-row decryption
([`frontend/src/offline/repos/customers.ts`](../../../frontend/src/offline/repos/customers.ts)).
Tax_id, email, addresses, loyalty stay encrypted.

**Phase 2 gate:** security review must sign off on `mobile_no` plaintext
before release. PII per GDPR / [`docs/offline/13-security.md`](../13-security.md) §3.
If declined, switch to a hashed-prefix index that supports search without
exposing the full number.

---

## 10. Spec doc rename: "POS Opening Entry" → "POS Opening Shift"

**Phase 1 ship:** code uses the actual v16 doctype names ("POS Opening
Shift" / "POS Closing Shift") correctly.

**Spec drift:** [`docs/offline/12-server-side-changes.md`](../12-server-side-changes.md)
still references "POS Opening Entry" / "POS Closing Entry" in §2, §4.4-4.5.

**Phase 2 work:** rename across the spec for consistency. Pure docs change.

---

## 11. Test-suite improvements

- DEGRADED transition test (depends on item #1)
- Pause-on-offline drain test should observe call-count (not just `running`
  flag) — see Agent 7 reviewer notes
- E2E specs (offline-sale, offline-return, session-expiry, three chaos
  scenarios) currently `test.skip` with TODOs — unlock via the CI plan
  (live Frappe + Playwright route interception)

---

**Last updated:** 2026-04-25
