<template>
	<div fluid class="mt-2 pos-page">
		<ClosingDialog></ClosingDialog>
		<Drafts></Drafts>
		<SalesOrders></SalesOrders>
		<Returns></Returns>
		<NewAddress></NewAddress>
		<MpesaPayments></MpesaPayments>
		<Variants></Variants>
		<OpeningDialog v-if="dialog" :dialog="dialog"></OpeningDialog>

		<!-- Modal Components -->
		<CouponsModal v-model="showCouponsModal"></CouponsModal>
		<OffersModal v-model="showOffersModal"></OffersModal>

		<v-row v-show="!dialog" class="itemselector-section">
			<v-col
				v-show="!payment"
				xl="5"
				lg="5"
				md="5"
				sm="5"
				cols="12"
				class="pos pr-0 test-pos"
			>
				<ItemsSelector></ItemsSelector>
			</v-col>
			<v-col
				v-show="payment"
				xl="5"
				lg="5"
				md="5"
				sm="5"
				cols="12"
				class="pos pr-0 test-pos"
			>
				<Payments></Payments>
			</v-col>

			<v-col xl="7" lg="7" md="7" sm="7" cols="12" class="pos invoice-section">
				<Invoice></Invoice>
			</v-col>
		</v-row>
	</div>
</template>

<script>
import ItemsSelector from "./ItemsSelector.vue";
import Invoice from "./Invoice.vue";
import OpeningDialog from "./OpeningDialog.vue";
import Payments from "./Payments.vue";
import CouponsModal from "./CouponsModal.vue";
import OffersModal from "./OffersModal.vue";
import Drafts from "./Drafts.vue";
import SalesOrders from "./SalesOrders.vue";
import ClosingDialog from "./ClosingDialog.vue";
import NewAddress from "./NewAddress.vue";
import Variants from "./Variants.vue";
import Returns from "./Returns.vue";
import MpesaPayments from "./Mpesa-Payments.vue";
import { call, unwrapStale } from "@/utils/call";
import { toast } from "vue3-toastify";
import { onSynced } from "@/offline/outbox";
import { setBeaconContext } from "@/offline/beacon";
import connectivity from "@/offline/connectivity";

export default {
	data: function () {
		return {
				dialog: false,
				pos_profile: "",
				pos_opening_shift: "",
				payment: false,
				showCouponsModal: false,
				showOffersModal: false,
				pendingProfileData: null,
				pendingMasterDataRefresh: { items: false, customers: false },
				cartHasItems: false,
				pendingClosingOfflineId: null,
			};
		},

	components: {
		ItemsSelector,
		Invoice,
		OpeningDialog,
		Payments,
		Drafts,
		ClosingDialog,
		CouponsModal,
		OffersModal,
		Returns,
		NewAddress,
		Variants,
		MpesaPayments,
		SalesOrders,
	},

	methods: {
		async check_opening_entry() {
			// B3 — stale-while-revalidate shift-open hydration.
			//
			// Strategy:
			//   1. Synchronously read the cached snapshot. If fresh (<24h),
			//      register it immediately so the cashier sees a populated UI
			//      in milliseconds, even on a cold boot.
			//   2. Fire the live `check_opening_shift` in the background. If
			//      it returns a meaningfully different snapshot (different
			//      shift name or pos_profile.modified), re-emit
			//      register_pos_profile so downstream panels reload without a
			//      manual refresh.
			//   3. If the live call fails AND no fresh cache exists → fall
			//      through to the opening dialog (cold start, no offline hint).
			//
			// The TTL is 24h: a stale-but-still-valid cache covers a typical
			// overnight outage; older than that and we'd rather make the
			// cashier reconnect than serve potentially-corrupt data.
			const SNAPSHOT_KEY = "pospire.opening_shift_snapshot";
			const SNAPSHOT_META_KEY = "pospire.opening_shift_snapshot.meta";
			const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

			const cachedSnapshot = this.readCachedOpeningSnapshot(
				SNAPSHOT_KEY,
				SNAPSHOT_META_KEY,
				SNAPSHOT_TTL_MS,
			);
			let registeredFromCache = false;
			if (cachedSnapshot) {
				this.applyOpeningSnapshot(cachedSnapshot);
				registeredFromCache = true;
			}

			let r = null;
			let liveCallSucceeded = false;
			try {
				r = await call("pospire.pospire.api.posapp.check_opening_shift", {
					user: window.user,
				});
				liveCallSucceeded = true;
				if (r) {
					this.persistOpeningSnapshot(r, SNAPSHOT_KEY, SNAPSHOT_META_KEY);
				}
			} catch (err) {
				// liveCallSucceeded stays false. If we already registered the
				// cache, swallow — banner tells the cashier they're offline.
				// If we haven't, we'll fall through to the opening dialog.
				if (!registeredFromCache) {
					console.warn(
						"[Pos] check_opening_shift failed and no fresh snapshot cached",
						err,
					);
				}
			}

			if (r) {
				// Compare-and-swap: only re-emit register_pos_profile when the
				// fresh response disagrees with what we already showed. This
				// avoids a re-render storm on every boot when nothing changed.
				if (
					!registeredFromCache ||
					this.openingSnapshotDiffers(cachedSnapshot, r)
				) {
					this.applyOpeningSnapshot(r);
				} else {
					// Still keep the in-memory pos_profile / pos_opening_shift
					// pointing at the live response so any field the cache lost
					// (e.g. the `modified` timestamp) is current.
					this.pos_profile = r.pos_profile;
					this.pos_opening_shift = r.pos_opening_shift;
				}
				console.info("LoadPosProfile");
			} else if (liveCallSucceeded) {
				// Server is reachable AND says there is no open shift. The
				// cached snapshot (if any) is now stale — the shift was closed
				// on another device, expired, or never existed. Invalidate
				// the cache, clear the in-memory references, and route the
				// cashier to the opening dialog so they don't keep selling
				// against a phantom shift.
				this.invalidateOpeningSnapshot(SNAPSHOT_KEY, SNAPSHOT_META_KEY);
				this.pos_profile = "";
				this.pos_opening_shift = "";
				this.create_opening_voucher();
			} else if (!registeredFromCache) {
				// Live call failed AND no cache → cold start, open dialog.
				this.create_opening_voucher();
			}
			// (Live call failed AND we registered from cache → keep using
			// the cache. The cashier is offline; the banner explains it.)
		},

		readCachedOpeningSnapshot(key, metaKey, ttlMs) {
			try {
				const raw = localStorage.getItem(key);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (!parsed || !parsed.pos_profile || !parsed.pos_opening_shift) {
					return null;
				}
				// TTL gate. The meta key holds `cached_at` so the snapshot blob
				// stays exactly the shape the live API returns.
				const metaRaw = localStorage.getItem(metaKey);
				if (!metaRaw) return null;
				const meta = JSON.parse(metaRaw);
				if (
					!meta?.cached_at ||
					typeof meta.cached_at !== "number" ||
					Date.now() - meta.cached_at > ttlMs
				) {
					return null;
				}
				return parsed;
			} catch {
				return null;
			}
		},

		persistOpeningSnapshot(snapshot, key, metaKey) {
			try {
				localStorage.setItem(key, JSON.stringify(snapshot));
				localStorage.setItem(
					metaKey,
					JSON.stringify({ cached_at: Date.now() }),
				);
			} catch {
				/* quota / privacy mode — non-fatal */
			}
		},

		/**
		 * Wipe the cached opening snapshot. Called when the server confirms
		 * that no shift is open — the cache is now actively misleading and
		 * has to be cleared before the cashier can be redirected to the
		 * opening dialog.
		 */
		invalidateOpeningSnapshot(key, metaKey) {
			try {
				localStorage.removeItem(key);
				localStorage.removeItem(metaKey);
			} catch {
				/* private mode */
			}
		},

		/**
		 * Decide whether the live response is materially different from the
		 * cached one. We compare:
		 *   - Opening shift NAME — different shifts entirely.
		 *   - POS Profile modified timestamp — config edited mid-shift.
		 * Anything else (balance_details aging, taxes recomputed) is
		 * downstream and not worth a re-emit.
		 */
		openingSnapshotDiffers(cached, live) {
			if (!cached) return true;
			if (
				cached.pos_opening_shift?.name !== live.pos_opening_shift?.name
			) {
				return true;
			}
			if (
				cached.pos_profile?.modified !== live.pos_profile?.modified
			) {
				return true;
			}
			return false;
		},

		applyOpeningSnapshot(snapshot) {
			if (!snapshot?.pos_profile) return;
			this.pos_profile = snapshot.pos_profile;
			this.pos_opening_shift = snapshot.pos_opening_shift;
			this.get_offers(this.pos_profile.name);
			this.eventBus.emit("register_pos_profile", snapshot);
			this.eventBus.emit("set_company", snapshot.company);
			// H4: if this shift was locked because an offline closing was
			// queued before reload, re-emit the lock event so Invoice.vue
			// re-arms the add_item / show_payment refusals after hydrate.
			if (snapshot.pos_opening_shift?.pospire_closing_pending) {
				this.eventBus.emit("shift_closing_pending", {
					shift_offline_id: snapshot.pos_opening_shift?.pos_offline_id,
					closing_offline_id:
						snapshot.pos_opening_shift?.pospire_pending_closing_offline_id,
				});
			}
			// B5 — feed the observability beacon with the active outlet/shift
			// so dashboards can group device pings by store. Free-form outlet
			// label falls back to the POS Profile name.
			try {
				setBeaconContext({
					outlet:
						snapshot.pos_profile.warehouse ||
						snapshot.pos_profile.name ||
						"",
					active_shift: snapshot.pos_opening_shift?.name || "",
					user: snapshot.pos_opening_shift?.user || "",
				});
			} catch (err) {
				console.warn("[Pos] setBeaconContext failed", err);
			}
			// Warm the customer-form-options read cache (Customer Group /
			// Territory / Gender lists). This path fires on every boot —
			// including reload-from-cache and new-tab — not only when the
			// opening dialog runs. Without this, the cache was only warmed
			// via register_pos_data (emitted by OpeningDialog.vue), so a
			// cashier who reloaded with an existing shift would get empty
			// dropdowns on the Create Customer dialog when offline.
			this.warm_customer_form_options_cache();
		},
		create_opening_voucher() {
			this.dialog = true;
		},
		async get_closing_data() {
			let r = null;
			try {
				r = await call(
					"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening",
					{
						opening_shift: this.pos_opening_shift,
					}
				);
			} catch (err) {
				// Offline / transport failure — synthesise a minimal closing
				// shape from the cached opening shift so the cashier can still
				// enter their physical denominations. Aggregated expected
				// amounts (sum of invoices for this shift) require server-side
				// SQL across synced docs and aren't available offline; the
				// reconciliation banner in the dialog tells the cashier why.
				console.warn("[Pos] make_closing_shift offline fallback", err);
				r = this.buildOfflineClosingStub();
			}
			if (r) {
				this.eventBus.emit("open_ClosingDialog", r);
			}
		},
		/**
		 * Synthesise the data shape `open_ClosingDialog` expects when
		 * `make_closing_shift_from_opening` is unreachable. Opening amounts
		 * come from the cached opening shift; expected_amount is left equal
		 * to opening (the cashier reconciles after sync).
		 */
		buildOfflineClosingStub() {
			const opening = this.pos_opening_shift || {};
			const balance = Array.isArray(opening.balance_details)
				? opening.balance_details
				: [];
			const payment_reconciliation = balance.map((row) => ({
				mode_of_payment: row.mode_of_payment,
				opening_amount: row.amount || 0,
				// expected_amount stays equal to opening — invoices for this
				// shift haven't aggregated server-side yet.
				expected_amount: row.amount || 0,
				closing_amount: 0,
				difference: 0,
			}));
			return {
				name: "",
				pos_opening_shift: opening.name || "",
				pos_opening_shift_offline_id: opening.pos_offline_id || null,
				period_start_date: opening.period_start_date || "",
				pos_profile: opening.pos_profile || (this.pos_profile && this.pos_profile.name),
				user: opening.user || "",
				company: opening.company || (this.pos_profile && this.pos_profile.company),
				grand_total: 0,
				net_total: 0,
				total_quantity: 0,
				payment_reconciliation,
				pos_transactions: [],
				taxes: [],
				denomination_details: opening.denomination_details || [],
				pospire_offline_stub: true,
			};
		},
		async submit_closing_pos(data) {
			// Carry the parent opening's offline_id and the list of invoice
			// offline_ids onto the closing payload so the registry adapter can
			// build parent_offline_ids correctly. The adapter strips these
			// from the persisted doc before sending.
			const closingPayload = {
				...data,
				pos_opening_shift_offline_id:
					data.pos_opening_shift_offline_id ||
					this.pos_opening_shift?.pos_offline_id ||
					null,
				invoice_offline_ids: await this.collectShiftInvoiceOfflineIds(),
			};

			// Pre-flight: if the active shift already has a queued closing OR
			// any unsynced invoice in the local outbox, sending this close via
			// the live path would close the shift on the server before the
			// queued writes drain — orphaning every queued invoice (validate_shift
			// throws "POS Shift X is not open"). forceQueue routes through the
			// offline endpoint so strict-closure waits for siblings to sync.
			const closeRoute = await this.classifyCloseRoute();
			if (closeRoute === "already-queued") {
				toast.warning(
					__("A close-shift is already queued for this shift. It will finalise once every invoice in this shift has synced."),
					{ autoClose: 6000 },
				);
				return;
			}
			let r = null;
			try {
				r = await call({
					method:
						"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift",
					args: { closing_shift: closingPayload },
					intent: "write",
					forceQueue: closeRoute === "force-queue",
				});
			} catch (err) {
				console.error("[Pos] submit_closing_shift failed", err);
				toast.error(err && err.message ? err.message : __("Failed to close shift"));
				return;
			}
				// Offline ack — closing is queued. Server-side strict closure on
				// each retry blocks until every invoice in the shift has synced;
				// once they do, the closing fires automatically.
				if (r && r.offline === true && r.status === "enqueued") {
					this.pendingClosingOfflineId = r.offline_id;
					toast.info(
						__("Shift close queued. It will finalise once every invoice in this shift has synced."),
						{ autoClose: 5000 },
					);
				// Freeze the local shift: any invoice rung up after this point
				// would NOT be in the closing's parent_offline_ids (we
				// captured the sibling list at queue time), so the server
				// would either reject the closing as having orphan siblings
				// or — worse — submit the closing AND then submit a stray
				// invoice under the now-closed shift. Lock the shift locally
				// and re-route to the opening dialog so the cashier opens a
				// new shift if they need to keep selling. The lock releases
				// when the closing's onSynced fires.
				if (this.pos_opening_shift) {
					this.pos_opening_shift = {
						...this.pos_opening_shift,
						pospire_closing_pending: true,
						pospire_pending_closing_offline_id: r.offline_id,
					};
					// Mirror onto the localStorage snapshot so a hard reload
					// preserves the lock. The snapshot is the authoritative
					// boot-time state for the cashier.
					try {
						const raw = localStorage.getItem("pospire.opening_shift_snapshot");
						if (raw) {
							const cached = JSON.parse(raw);
							if (cached?.pos_opening_shift) {
								cached.pos_opening_shift.pospire_closing_pending = true;
								cached.pos_opening_shift.pospire_pending_closing_offline_id = r.offline_id;
								localStorage.setItem(
									"pospire.opening_shift_snapshot",
									JSON.stringify(cached),
								);
							}
						}
					} catch {
						/* non-fatal */
					}
				}
				// Notify the cart layer (Invoice.vue) so add_item /
				// show_payment refuse new actions on the locked shift.
				this.eventBus.emit("shift_closing_pending", {
					shift_offline_id: this.pos_opening_shift?.pos_offline_id,
					closing_offline_id: r.offline_id,
				});
				// Re-route to the opening dialog (completing the intent stated
				// in the comment above). Strip pos_opening_shift from the
				// snapshot so a hard reload also falls through to the dialog
				// rather than re-arming the closing lock. pos_profile and
				// company stay intact — OpeningDialog uses them offline via
				// synthesizeDialogDataFromShiftSnapshot.
				try {
					const raw = localStorage.getItem("pospire.opening_shift_snapshot");
					if (raw) {
						const cached = JSON.parse(raw);
						cached.pos_opening_shift = null;
						localStorage.setItem(
							"pospire.opening_shift_snapshot",
							JSON.stringify(cached),
						);
					}
				} catch {
					/* non-fatal */
				}
				this.pos_opening_shift = "";
				this.create_opening_voucher();
				return;
			}
			if (r) {
				toast.success(__("POS Shift Closed"));
				this.check_opening_entry();
			}
		},
		/**
		 * Collect every invoice offline_id that belongs to the current shift,
		 * regardless of current outbox status. The server's strict-closure
		 * check in `_ensure_all_invoices_submitted` requires the COMPLETE
		 * sibling list — including invoices that are temporarily in
		 * `needs_review`. If a `needs_review` row gets fixed and resyncs
		 * later, the closing's `parent_offline_ids` must include it so the
		 * scheduler unblocks the closing on its sync (cascade-unblock fires
		 * from `markSynced` regardless of category).
		 *
		 * Two collection paths:
		 *   1. Offline-opened shift (pos_offline_id present) — fast: index
		 *      scan via `shift_offline_id` set at enqueue time.
		 *   2. Online-opened shift (no pos_offline_id) — needs the inner
		 *      `posa_pos_opening_shift` field which lives inside the encrypted
		 *      invoice payload. We decrypt and match. Cost is bounded by the
		 *      invoice count for the current shift (typically <100).
		 *
		 * The previous version returned `[]` for online-opened shifts, so
		 * the closing payload shipped without sibling ids and the server's
		 * orphan check rejected the closing as siblings_not_ready. With no
		 * parent_offline_ids on the closing's outbox row, scheduler
		 * cascade-unblock had nothing to react to, leaving the manager to
		 * void + retry by hand.
		 */
		/**
		 * Decide how to route a Close Shift action based on the local outbox
		 * state for the active shift:
		 *
		 *   "already-queued" → an unsynced closing_entry exists for this shift;
		 *     refuse a second close so we don't enqueue a duplicate that the
		 *     server would reject (and so we don't fire a redundant live close
		 *     that closes the shift before sibling invoices drain).
		 *   "force-queue"    → no queued closing yet, but unsynced invoices
		 *     exist for this shift. The closing MUST go through the outbox so
		 *     strict-closure (P-8) waits for every sibling. A live close here
		 *     would orphan the queued invoices via validate_shift.
		 *   "live"           → no queued activity for this shift; the live path
		 *     is safe (call() will still enqueue if currently offline).
		 *
		 * Failure modes (Dexie unavailable, kill switch off, etc.) fall through
		 * to "live" — better to let the cashier close than to wedge the UI.
		 */
		async classifyCloseRoute() {
			const openingOfflineId = this.pos_opening_shift?.pos_offline_id;
			const openingServerName = this.pos_opening_shift?.name;
			if (!openingOfflineId && !openingServerName) return "live";
			try {
				const { listByStatus } = await import("@/offline/outbox");
				const unsyncedStatuses = [
					"enqueued",
					"in_flight",
					"retry_pending",
					"needs_review",
					"handed_off",
				];
				const all = await Promise.all(
					unsyncedStatuses.map((s) => listByStatus(s)),
				);
				const flat = all.flat();
				const matchesShift = (row) => {
					if (openingOfflineId && row.shift_offline_id === openingOfflineId) {
						return true;
					}
					if (!openingServerName) return false;
					if (row.shift_offline_id) return false;
					const inner = this.unwrapInnerInvoicePayload(row.payload);
					return (
						inner &&
						(inner.posa_pos_opening_shift === openingServerName ||
							inner.pos_opening_shift === openingServerName)
					);
				};
				const queuedClosing = flat.find(
					(row) => row.type === "closing_entry" && matchesShift(row),
				);
				if (queuedClosing) return "already-queued";
				const queuedInvoice = flat.find(
					(row) => row.type === "invoice" && matchesShift(row),
				);
				if (queuedInvoice) return "force-queue";
				return "live";
			} catch (err) {
				console.warn("[Pos] classifyCloseRoute failed; defaulting to live", err);
				return "live";
			}
		},

		async collectShiftInvoiceOfflineIds() {
			const openingOfflineId = this.pos_opening_shift?.pos_offline_id;
			const openingServerName = this.pos_opening_shift?.name;
			if (!openingOfflineId && !openingServerName) return [];
			try {
				const { listByStatus } = await import("@/offline/outbox");
				const all = await Promise.all([
					listByStatus("enqueued"),
					listByStatus("in_flight"),
					listByStatus("retry_pending"),
					listByStatus("needs_review"),
					listByStatus("synced"),
				]);
				const flat = all.flat();
				const invoiceRows = flat.filter((row) => row.type === "invoice");

				// Fast path: index match on shift_offline_id.
				if (openingOfflineId) {
					return invoiceRows
						.filter((row) => row.shift_offline_id === openingOfflineId)
						.map((row) => row.offline_id);
				}

				// Slow path (online-opened shift): inspect each invoice's
				// inner doc to match by real shift name. The outbox repo
				// returns rows with the payload field already decrypted.
				const matches = [];
				for (const row of invoiceRows) {
					if (row.shift_offline_id) continue; // belongs to a different (offline) shift
					const inner = this.unwrapInnerInvoicePayload(row.payload);
					if (
						inner &&
						(inner.posa_pos_opening_shift === openingServerName ||
							inner.pos_opening_shift === openingServerName)
					) {
						matches.push(row.offline_id);
					}
				}
				return matches;
			} catch (err) {
				console.warn("[Pos] collectShiftInvoiceOfflineIds failed", err);
				return [];
			}
		},

		/**
		 * Outbox payloads for offline-capable writes follow the wrapper
		 * shape `{ data: "<JSON-stringified inner doc>", offline_id, … }`.
		 * Strip the wrapper so callers can read inner fields like
		 * `posa_pos_opening_shift` without re-implementing the parse on
		 * every site.
		 */
		unwrapInnerInvoicePayload(payload) {
			if (!payload || typeof payload !== "object") return null;
			if (typeof payload.data === "string") {
				try {
					return JSON.parse(payload.data);
				} catch {
					return null;
				}
			}
			return payload;
		},
		async get_offers(pos_profile) {
			// `get_offers` is registered as `offline:true` with a 2h cache.
			// On a stale-cache hit the underlying call() returns a
			// StaleReadResult<T> wrapper { data, stale, cachedAt }. We unwrap
			// uniformly here so neither the localStorage snapshot nor the
			// eventBus consumers (Invoice.vue's posOffers) ever see the
			// wrapper. Without unwrap, posOffers becomes the wrapper object,
			// posOffers.forEach throws, and the offer engine silently no-ops.
			const OFFERS_KEY = "pospire.offers_snapshot." + pos_profile;
			let offers = null;
			try {
				offers = unwrapStale(
					await call("pospire.pospire.api.posapp.get_offers", {
						profile: pos_profile,
					}),
				);
				if (offers) {
					try {
						localStorage.setItem(OFFERS_KEY, JSON.stringify(offers));
					} catch {
						/* non-fatal */
					}
				}
			} catch {
				try {
					const cached = localStorage.getItem(OFFERS_KEY);
					if (cached) {
						// Defensive: a previous build wrote the wrapper into
						// localStorage. Strip it on read so devices don't have
						// to clear their cache to recover.
						const parsed = JSON.parse(cached);
						offers = unwrapStale(parsed);
					}
				} catch {
					/* corrupt cache */
				}
			}
			if (offers) {
				console.info("LoadOffers");
				this.eventBus.emit("set_offers", offers);
			}
		},
		/**
		 * Warm the offline read-cache entry for the Create / Update Customer
		 * dialog's reference-data dropdowns (Customer Group, Territory,
		 * Gender). We hit this on shift-open — when the cashier is reliably
		 * online — so the cache is populated before they ever open the
		 * dialog. Subsequent dialog opens (including offline ones) read from
		 * cache and the dropdowns render normally instead of empty.
		 *
		 * Fire-and-forget: the dialog itself also calls the same endpoint
		 * lazily, so a transient failure here just defers the warm to first
		 * dialog open. Catch swallows because there is no graceful UI for
		 * "warm-up failed" — the dialog will surface the real error if and
		 * when it can't load.
		 */
		async warm_customer_form_options_cache() {
			try {
				await call({
					method:
						"pospire.pospire.api.offline.get_customer_form_options",
					intent: "read",
					cacheKey: "offline.customer_form_options",
				});
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(
					"[Pos] warm_customer_form_options_cache failed (non-fatal)",
					err,
				);
			}
		},
		async get_pos_setting() {
			const KEY = "pospire.pos_settings_snapshot";
			let doc = null;
			try {
				doc = await call("frappe.client.get", { doctype: "POS Settings", name: "POS Settings" });
				if (doc) {
					try {
						localStorage.setItem(KEY, JSON.stringify(doc));
					} catch {
						/* non-fatal */
					}
				}
			} catch {
				try {
					const cached = localStorage.getItem(KEY);
					if (cached) doc = JSON.parse(cached);
				} catch {
					/* corrupt cache */
				}
			}
			if (doc) {
				this.eventBus.emit("set_pos_settings", doc);
			}
		},
	},

	mounted: function () {
		// Re-warm customer form options whenever the device comes back online.
		// Covers the case where the POS opened while offline (empty Dexie)
		// and connectivity was restored later in the session.
		this._unsubConnectivity = connectivity.onChange(() => {
			if (connectivity.isOnline()) {
				this.warm_customer_form_options_cache();
			}
		});

		this.$nextTick(function () {
			this.check_opening_entry();
			this.get_pos_setting();
			this.eventBus.on("close_opening_dialog", () => {
				this.dialog = false;
			});
			this.eventBus.on("register_pos_data", (data) => {
				this.pos_profile = data.pos_profile;
				this.get_offers(this.pos_profile.name);
				this.pos_opening_shift = data.pos_opening_shift;
				this.eventBus.emit("register_pos_profile", data);
				// Warm the offline read-cache for the Create / Update
				// Customer dialog's dropdowns (Customer Group, Territory,
				// Gender) while we're definitely online (shift just opened).
				// Fire-and-forget: a failure here is non-fatal — the dialog
				// will retry on its own first open and surface any error
				// there if the cashier never had a successful warm fetch.
				this.warm_customer_form_options_cache();
				console.info("LoadPosProfile");
			});
			this.eventBus.on("show_payment", (data) => {
				this.payment = data === "true";
			});
			this.eventBus.on("show_offers", (data) => {
				this.showOffersModal = data === "true";
			});
			this.eventBus.on("show_coupons", (data) => {
				this.showCouponsModal = data === "true";
			});
			this.eventBus.on("open_closing_dialog", () => {
				this.get_closing_data();
			});
			this.eventBus.on("submit_closing_pos", (data) => {
				this.submit_closing_pos(data);
			});

			// Track whether the cart has items so the profile refresh
			// can decide to apply immediately or defer.
			this.eventBus.on("add_item", () => {
				this.cartHasItems = true;
			});
			this.eventBus.on("load_invoice", () => {
				this.cartHasItems = true;
			});
			this.eventBus.on("load_order", () => {
				this.cartHasItems = true;
			});
			this.eventBus.on("load_return_invoice", () => {
				this.cartHasItems = true;
			});

			// Shared handler: reset cart flag and apply any pending refreshes.
			// Priority: pendingProfileData (register_pos_profile already cascades
			// get_items + get_customer_names downstream, so standalone refresh
			// events are skipped to avoid redundant fetches).
			const onCartEmpty = () => {
				this.cartHasItems = false;
				if (this.pendingProfileData) {
					this.get_offers(this.pendingProfileData.pos_profile.name);
					this.eventBus.emit("register_pos_profile", this.pendingProfileData);
				} else {
					if (this.pendingMasterDataRefresh.items) {
						this.eventBus.emit("refresh_items");
					}
					if (this.pendingMasterDataRefresh.customers) {
						this.eventBus.emit("refresh_customers");
					}
				}
				// Unconditionally reset all pending state — even when
				// pendingProfileData took priority, so stale master-data
				// flags cannot replay on the next cart-clear.
				this.pendingProfileData = null;
				this.pendingMasterDataRefresh = { items: false, customers: false };
				this._deferredRefreshToastShown = false;
			};

			// Cart cleared via payment or Save-and-Clear.
			this.eventBus.on("clear_invoice", onCartEmpty);
			// Cart emptied by manually removing the last item.
			this.eventBus.on("cart_emptied", onCartEmpty);

			// F2: when an offline-opened shift finally syncs, swap the cart's
			// `pos_opening_shift.name` from the provisional `OFFLINE-OPN-...`
			// to the real server doc name. Subsequent invoices stop needing
			// the offline_id forwarding (Invoice.vue's get_invoice_doc only
			// emits `pos_opening_shift_offline_id` when that field is set).
			this._unsubShiftSync = onSynced((event) => {
				if (event.type === "opening_entry") {
					if (!event.server_doc_name || !event.provisional_name) return;
					if (
						this.pos_opening_shift &&
						this.pos_opening_shift.name === event.provisional_name
					) {
						this.pos_opening_shift.name = event.server_doc_name;
						this.pos_opening_shift.pos_offline_id = null;
						this.pos_opening_shift.pospire_pending_sync = false;
					}
					// Refresh the localStorage snapshot so a hard reload picks up
					// the resolved name instead of the now-stale provisional one.
					try {
						const raw = localStorage.getItem("pospire.opening_shift_snapshot");
						if (raw) {
							const cached = JSON.parse(raw);
							if (
								cached?.pos_opening_shift?.name === event.provisional_name
							) {
								cached.pos_opening_shift.name = event.server_doc_name;
								cached.pos_opening_shift.pos_offline_id = null;
								cached.pos_opening_shift.pospire_pending_sync = false;
								localStorage.setItem(
									"pospire.opening_shift_snapshot",
									JSON.stringify(cached),
								);
							}
						}
					} catch {
						/* localStorage parse failure is non-fatal */
					}
					toast.success(
						`Shift ${event.server_doc_name} now synced`,
						{ autoClose: 3000 },
					);
					return;
				}

					// H4: closing entry synced. The shift is now genuinely closed
					// on the server. If the cashier is still on the locked shift,
					// release the local lock and route to the opening dialog. If
					// they already opened the next shift, keep that active shift
					// untouched and just clear the pending-close marker.
					if (event.type === "closing_entry") {
						const expected =
							this.pos_opening_shift?.pospire_pending_closing_offline_id ||
							this.pendingClosingOfflineId;
						if (!expected || expected !== event.offline_id) return;
						const stillOnLockedShift =
							this.pos_opening_shift?.pospire_pending_closing_offline_id ===
							event.offline_id;
						this.pendingClosingOfflineId = null;
						toast.success(__("Shift closed and synced"), { autoClose: 3000 });
						this.eventBus.emit("shift_closing_complete", {
							closing_offline_id: event.offline_id,
							closing_server_name: event.server_doc_name,
						});
						if (stillOnLockedShift) {
							this.invalidateOpeningSnapshot(
								"pospire.opening_shift_snapshot",
								"pospire.opening_shift_snapshot.meta",
							);
							this.pos_opening_shift = "";
							this.pos_profile = "";
							this.create_opening_voucher();
						}
					}
				});

			// Shared deferred-refresh toast guard — one neutral toast for
			// both pos_profile_updated and pos_master_data_invalidated.
			this._deferredRefreshToastShown = false;

			// When the POS Profile is saved from the desk mid-shift, re-fetch it and:
			// - If cart is empty  → apply immediately.
			// - If cart has items → hold as pending; applies after current invoice clears.
			window.frappe?.realtime?.on("pos_profile_updated", (data) => {
				if (this.pos_profile && data.pos_profile === this.pos_profile.name) {
					call("pospire.pospire.api.posapp.check_opening_shift", {
						user: window.user,
					}).then((r) => {
						if (!r) return;
						this.pos_profile = r.pos_profile;
						if (!this.cartHasItems) {
							this.get_offers(r.pos_profile.name);
							this.eventBus.emit("register_pos_profile", r);
						} else {
							this.pendingProfileData = r;
							if (!this._deferredRefreshToastShown) {
								this._deferredRefreshToastShown = true;
								toast.info(
									__("Updates detected. Catalog will refresh after this transaction."),
									{ autoClose: 4000 }
								);
							}
						}
					});
				}
			});

			// When master data (Item, Customer, etc.) changes, the backend
			// publishes pos_master_data_invalidated with scoped flags.
			window.frappe?.realtime?.on("pos_master_data_invalidated", (data) => {
				if (!data || typeof data !== "object") return;
				if (!this.cartHasItems) {
					if (data.items) this.eventBus.emit("refresh_items");
					if (data.customers) this.eventBus.emit("refresh_customers");
				} else {
					if (data.items) this.pendingMasterDataRefresh.items = true;
					if (data.customers) this.pendingMasterDataRefresh.customers = true;
					if (!this._deferredRefreshToastShown) {
						this._deferredRefreshToastShown = true;
						toast.info(
							__("Updates detected. Catalog will refresh after this transaction."),
							{ autoClose: 4000 }
						);
					}
				}
			});
		});
	},
	beforeUnmount() {
		this.eventBus.off("close_opening_dialog");
		this.eventBus.off("register_pos_data");
		this.eventBus.off("LoadPosProfile");
		this.eventBus.off("show_offers");
		this.eventBus.off("show_coupons");
		this.eventBus.off("show_payment");
		this.eventBus.off("open_closing_dialog");
		this.eventBus.off("submit_closing_pos");
		this.eventBus.off("add_item");
		this.eventBus.off("load_invoice");
		this.eventBus.off("load_order");
		this.eventBus.off("load_return_invoice");
		this.eventBus.off("clear_invoice");
		this.eventBus.off("cart_emptied");
		window.frappe?.realtime?.off("pos_profile_updated");
		window.frappe?.realtime?.off("pos_master_data_invalidated");
		if (typeof this._unsubConnectivity === "function") {
			this._unsubConnectivity();
			this._unsubConnectivity = null;
		}
		if (typeof this._unsubShiftSync === "function") {
			this._unsubShiftSync();
			this._unsubShiftSync = null;
		}
	},
};
</script>

<style scoped>
/*
 * Height chain: viewport -> pos-page -> itemselector-section -> columns -> panels
 * Only pos-page calculates from viewport. Children use 100% to fill parent.
 */
.pos-page {
	/*
	 * Subtract navbar (--v-layout-top, written by Vuetify when v-app-bar
	 * registers) AND the offline banner (--pospire-banner-height, set on
	 * <v-app> in App.vue, 0px when hidden / 44px when visible). Without
	 * the banner term the cart's bottom edge runs off-screen whenever
	 * the banner is showing.
	 */
	height: calc(
		100dvh - var(--v-layout-top, 48px) - var(--pospire-banner-height, 0px)
	);
	max-height: calc(
		100dvh - var(--v-layout-top, 48px) - var(--pospire-banner-height, 0px)
	);
	overflow: hidden;
}

.itemselector-section {
	/* Fill parent height using explicit height, not flex */
	/* v-row children need explicit parent height for height: 100% to work */
	height: 100% !important;
	max-height: 100% !important;
	overflow: hidden;
}

/* Ensure columns pass height to children */
.pos {
	height: 100%;
	max-height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.invoice-section {
	height: 100%;
	max-height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
</style>
