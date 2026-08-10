<template>
	<v-dialog v-model="isOpen" persistent max-width="600px">
		<v-card rounded="xl" elevation="8">
			<v-card-title
				class="d-flex align-center justify-space-between px-6 py-4 enhanced-modal-header"
			>
				<span class="text-h6 font-weight-bold text-primary">
					{{ __("Create POS Opening Shift") }}
				</span>
				<v-btn icon="mdi-close" variant="text" @click="go_desk"></v-btn>
			</v-card-title>

			<v-card-text class="overflow-y-auto"
  			style="max-height: 65vh;">
				<v-container fluid>
					<v-row dense>
						<v-col cols="12">
							<v-autocomplete
								v-model="company"
								:items="companies"
								:label="__('Company')"
								density="comfortable"
								variant="outlined"
								required
							/>
						</v-col>

						<v-col cols="12">
							<v-autocomplete
								v-model="pos_profile"
								:items="pos_profiles"
								:label="__('POS Profile')"
								density="comfortable"
								variant="outlined"
								required
							/>
						</v-col>

						<v-col cols="12">
							<v-data-table
								:headers="payments_methods_headers"
								:items="payments_methods"
								item-key="mode_of_payment"
								class="rounded-lg elevation-1"
								:items-per-page="itemsPerPage"
								density="comfortable"
								hide-default-footer
							>
								<template v-slot:item.amount="props">
									<v-text-field
										v-model.number="props.item.amount"
										type="number"
										min="0"
										density="compact"
										variant="outlined"
										hide-details
										:prefix="currencySymbol(pos_profile.currency)"
										:readonly="
											denominations_enabled ||
											props.item.mode_of_payment !== (denomination_config[pos_profile]?.cash_mode || 'Cash')
										"
										/>
								</template>
							</v-data-table>
							<v-expand-transition>
								<v-card
									v-if="denominations_enabled"
									class="rounded-lg elevation-1 mt-6"
									style="border-top: none !important;"
								>
									<v-card-title class="text-subtitle-2">
									{{ __("Cash Denomination Breakdown") }}
									</v-card-title>

									<v-data-table
									:headers="[
										{ title: 'Denomination', value: 'denomination_name' },
										{ title: 'Value', value: 'denomination_value' },
										{ title: 'Quantity', value: 'quantity' },
										{ title: 'Amount', value: 'amount' }
									]"
									:items="denomination_rows"
									density="compact"
									hide-default-footer
									>

									<template v-slot:item.denomination_value="{ item }">
										{{ formatCurrency(item.denomination_value) }}
									</template>

									<template v-slot:item.quantity="props">
										<v-text-field
										v-model.number="props.item.quantity"
										type="number"
										min="0"
										density="compact"
										variant="outlined"
										:rules="[v => v >= 0 || 'Quantity must be non-negative']"
										hide-details
										/>
									</template>

									<template v-slot:item.amount="{ item }">
										{{ formatCurrency(item.denomination_value * (item.quantity || 0)) }}
									</template>

									</v-data-table>

									<v-card-text class="text-right font-weight-bold">
									{{ __("Total") }}: {{ formatCurrency(denominationTotal) }}
									</v-card-text>

								</v-card>
								</v-expand-transition>
						</v-col>
					</v-row>
				</v-container>
			</v-card-text>

			<v-alert
				v-if="config_unavailable"
				type="warning"
				variant="tonal"
				class="mx-6 mb-2"
			>
				{{ __("POS configuration is not available on this device yet. Connect to the network once to load it, then reopen this dialog.") }}
			</v-alert>
			<v-alert
				v-else-if="config_is_stale"
				type="info"
				variant="tonal"
				density="compact"
				class="mx-6 mb-2"
			>
				{{ __("Showing saved POS configuration. It will refresh when the connection returns.") }}
			</v-alert>
			<v-divider />
			<v-card-actions class="px-6 py-4 enhanced-modal-header">
				<v-spacer />
				<v-btn variant="text" color="grey-darken-1" @click="go_desk">
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					variant="elevated"
					color="primary"
					:disabled="is_loading || config_unavailable"
					@click="submit_dialog"
				>
					{{ __("Submit") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
import { call, isStaleReadResult, unwrapStale } from "@/utils/call";
import { OPENING_DIALOG_CACHE_KEY } from "@/utils/call-registry";
import connectivity from "@/offline/connectivity";
import format from "@/utils/format";
import { toast } from "vue3-toastify";
import { amountRules, isAmountValid } from "@/utils/validation";
export default {
	mixins: [format],
	props: ["dialog"],
	data() {
		return {
			isOpen: this.dialog ? this.dialog : false,
			dialog_data: {},
			is_loading: false,
			companies: [],
			company: "",
			pos_profiles_data: [],
			pos_profiles: [],
			pos_profile: "",
			payments_method_data: [],
			payments_methods: [],
			payments_methods_headers: [
				{
					title: __("Mode of Payment"),
					align: "start",
					sortable: false,
					value: "mode_of_payment",
				},
				{
					title: __("Opening Amount"),
					value: "amount",
					align: "center",
					sortable: false,
				},
			],
			itemsPerPage: 100,
			amountRules,
			pagination: {},
			snack: false, // TODO : need to remove
			snackColor: "", // TODO : need to remove
			snackText: "", // TODO : need to remove
			denomination_config: {},
			denomination_rows: [],
			denominations_enabled: false,
			config_is_stale: false,
			config_unavailable: false,
			unsubConnectivity: null,
		};
	},
	watch: {
		company(val) {
			this.pos_profiles = [];
			this.pos_profiles_data.forEach((element) => {
				if (element.company === val) {
					this.pos_profiles.push(element.name);
				}
				if (this.pos_profiles.length) {
					this.pos_profile = this.pos_profiles[0];
				} else {
					this.pos_profile = "";
				}
			});
		},
		pos_profile(val) {
			this.payments_methods = [];
			this.payments_method_data.forEach((element) => {
				if (element.parent === val) {
					this.payments_methods.push({
						mode_of_payment: element.mode_of_payment,
						amount: 0,
						currency: element.currency,
					});
				}
			});
			const config = this.denomination_config[val];
			if (config?.denominations?.length) {
				this.denominations_enabled = true;
				this.denomination_rows = config.denominations.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: 0,
					amount: 0,
				}));
			} else {
				this.denominations_enabled = false;
				this.denomination_rows = [];
				if (config) {
					toast.warning(__("Cash denominations are enabled for this profile but no denomination rows are configured."), {
						autoClose: 5000,
					});
				}
			}
		},
		denominationTotal(newVal) {
			if (!this.denominations_enabled) return;

			const config = this.denomination_config[this.pos_profile];
			if (!config) return;

			const cashMode = config.cash_mode;

			const cashRow = this.payments_methods.find(
				(p) => p.mode_of_payment === cashMode
			);

			if (cashRow) {
				cashRow.amount = newVal;
			}
		},
	},
	computed:{
			denominationTotal() {
		if (!this.denomination_rows.length) return 0;

		return this.denomination_rows.reduce((sum, row) => {
			return sum + (row.denomination_value * (row.quantity || 0));
		}, 0);
	}

	},
	methods: {
		close_opening_dialog() {
			this.eventBus.emit("close_opening_dialog");
		},
		/**
		 * Single source of truth for populating the dialog from a
		 * `get_opening_dialog_data` payload. Used by BOTH the initial fetch
		 * and the reconnect refresh — a previous version only had
		 * `refresh_dialog_config` update `payments_method_data` /
		 * `denomination_config`, which never repopulated `companies` /
		 * `pos_profiles_data`. Since `company`/`pos_profile` stayed "" on a
		 * cold-boot-offline dialog, reassigning `payments_method_data` alone
		 * never re-fired the `pos_profile` watcher, so Submit flipped
		 * enabled on reconnect while the form was still completely blank —
		 * the exact silent dead end this task exists to remove.
		 *
		 * Assigns `companies` (does NOT push) so re-running this on refresh
		 * doesn't duplicate entries.
		 */
		applyDialogData(r) {
			this.companies = (r.companies || []).map((element) => element.name);
			this.company = this.companies[0];
			this.pos_profiles_data = r.pos_profiles_data || [];
			this.payments_method_data = r.payments_method || [];
			this.denomination_config = r.denomination_config || {};
		},
		async get_opening_dialog_data() {
			// Durable read-cache. The registry marks this method offline:true
			// and OPENING_DIALOG_CACHE_KEY is allowlisted in DURABLE_KEYS, so a
			// successful online call persists to Dexie and is served after a
			// reload while offline. Pos.vue warms it on every online boot,
			// because a terminal that runs all day on an already-open shift
			// never opens this dialog and would otherwise arrive here cold.
			let r = null;
			try {
				const raw = await call({
					method: "pospire.pospire.api.posapp.get_opening_dialog_data",
					args: {},
					intent: "read",
					cacheKey: OPENING_DIALOG_CACHE_KEY,
				});
				// Capture staleness BEFORE unwrapping — unwrapStale discards it.
				this.config_is_stale = isStaleReadResult(raw);
				r = unwrapStale(raw);
			} catch (err) {
				console.warn("[OpeningDialog] get_opening_dialog_data unavailable", err);
				this.config_unavailable = true;
				return;
			}

			if (!r) {
				this.config_unavailable = true;
				return;
			}

			this.config_unavailable = false;
			this.applyDialogData(r);
		},
		async refresh_dialog_config() {
			let fresh = null;
			try {
				const raw = await call({
					method: "pospire.pospire.api.posapp.get_opening_dialog_data",
					args: {},
					intent: "read",
					cacheKey: OPENING_DIALOG_CACHE_KEY,
				});
				this.config_is_stale = isStaleReadResult(raw);
				fresh = unwrapStale(raw);
			} catch {
				return; // still unreachable — keep what we have
			}
			if (!fresh) return;

			this.config_unavailable = false;
			// `previousProfile` lets us tell whether `applyDialogData` just
			// drove the `company` → `pos_profile` watcher chain from a blank
			// selection (cold-boot-offline reconnect): in that case the
			// `pos_profile` watcher below already built payments_methods AND
			// denomination_rows from scratch, so re-deriving them again here
			// would both duplicate work and double the misconfiguration
			// toast. When the profile selection is UNCHANGED, neither
			// watcher fires (Vue only calls a watcher when the value
			// actually changes), so payments_methods/denomination_rows are
			// left exactly as the cashier last saw them — which is what
			// preserves typed quantities across a reconnect.
			const previousProfile = this.pos_profile;
			this.applyDialogData(fresh);
			if (this.pos_profile !== previousProfile) return;

			// Re-derive the grid for the selected profile WITHOUT resetting
			// quantities the cashier has already counted into it. Mirrors
			// the `pos_profile` watcher's gate EXACTLY: `enabled: true` alone
			// does not mean render the grid — {enabled:true, denominations:[]}
			// is a real "misconfigured" state. Locking the cash field on an
			// unconfigured-but-enabled profile (by gating on `enabled` alone)
			// would strand the cashier with no way to enter opening cash.
			const config = this.denomination_config[this.pos_profile];
			if (!config?.denominations?.length) {
				this.denominations_enabled = false;
				this.denomination_rows = [];
				if (config) {
					toast.warning(__("Cash denominations are enabled for this profile but no denomination rows are configured."), {
						autoClose: 5000,
					});
				}
				return;
			}
			const typed = new Map(
				this.denomination_rows.map((row) => [row.denomination, row.quantity]),
			);
			this.denominations_enabled = true;
			this.denomination_rows = config.denominations.map((d) => ({
				denomination: d.denomination,
				denomination_name: d.denomination_name,
				denomination_value: d.denomination_value,
				currency: d.currency,
				quantity: typed.get(d.denomination) ?? 0,
				amount: 0,
			}));
		},
		async submit_dialog() {
			if (!this.payments_methods.length || !this.company || !this.pos_profile) {
				return;
			}

			if (this.denominations_enabled) {
				const invalidQty = this.denomination_rows.some((row) => {
					const qty = row.quantity === "" || row.quantity === null || row.quantity === undefined
						? 0
						: Number(row.quantity);

					return qty < 0 || !Number.isInteger(qty);
				});

				if (invalidQty) {
					toast.error(__("Quantity must be a non-negative integer."), {
						autoClose: 5000,
					});
					return;
				}
			}

			const has_invalid_amount = this.payments_methods.some((p) => !isAmountValid(p.amount));
			if (has_invalid_amount) {
				toast.error(__("Please enter valid non-negative amounts."), {
					autoClose: 5000,
				});
				return;
			}

			this.is_loading = true;

			const balance_details = this.payments_methods.map((p) => ({
				...p,
				amount:
					p.amount === "" || p.amount === null || p.amount === undefined
						? 0
						: Number(p.amount),
			}));

			let denomination_details = null;

			if (this.denominations_enabled) {
				const rows = this.denomination_rows.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: d.quantity || 0,
					amount: (d.denomination_value || 0) * (d.quantity || 0),
				}));

				denomination_details = JSON.stringify(rows);
			}

			// F2: offline shift open. The previous online session left a
			// snapshot under `pospire.opening_shift_snapshot` (Pos.vue) that
			// holds the full POS Profile + Company.
			//
			// M2 fix: load the snapshot UNCONDITIONALLY before the call().
			// `connectivity.isOnline()` is the pre-call snapshot of state —
			// but call() can decide to enqueue mid-flight (e.g. forceQueue,
			// or a network blip after the connectivity probe). If the
			// snapshot was only read in the `offline` branch, the
			// offline-ack handler downstream would dereference a null
			// snapshot when running through an "online but enqueued" path.
			let snapshot = null;
			try {
				const raw = localStorage.getItem("pospire.opening_shift_snapshot");
				if (raw) snapshot = JSON.parse(raw);
			} catch {
				snapshot = null;
			}

			const offline = !connectivity.isOnline();
			if (offline) {
				// F5: chained-shifts hard block. Once 3 opening_entries are
				// stacked unsynced, refuse to enqueue a 4th (we keep the cap
				// at 3 = "warn at 2, block at 3"). Forces the cashier to
				// reconnect before further opens.
				try {
					const { useOutboxStore } = await import("@/stores/outbox");
					const outbox = useOutboxStore();
					if ((outbox.unsyncedOpeningCount ?? 0) >= 3) {
						this.is_loading = false;
						toast.error(
							__("Cannot open another shift offline — 3 shifts are already waiting to sync. Reconnect to clear them first."),
							{ autoClose: 7000 },
						);
						return;
					}
				} catch (err) {
					// Store unavailable (e.g. SSR / pre-init). Fail open: better
					// to allow a fourth than to block legitimate opens because
					// of an init race. The reconciliation workspace would catch
					// any actual oversync.
					console.warn("[OpeningDialog] chained-shifts gate skipped", err);
				}

				if (!snapshot || !snapshot.pos_profile || !snapshot.company) {
					this.is_loading = false;
					toast.warning(
						__("Opening a shift offline needs a recent online session on this device. Reconnect and open one shift online first."),
						{ autoClose: 6000 },
					);
					return;
				}
			}

			try {
				const r = await call("pospire.pospire.api.posapp.create_opening_voucher", {
					pos_profile: this.pos_profile,
					company: this.company,
					balance_details,
					denomination_details,
				});

				// Offline-enqueue ack — synthesise the data shape from the cached
				// snapshot + the provisional shift. The cashier can start selling
				// immediately; subsequent invoices stamp pos_opening_shift_offline_id
				// so the server resolves to the real shift name on sync.
				if (r && r.offline === true && r.status === "enqueued") {
					// M2 — defensive null guard. We pre-loaded the snapshot
					// unconditionally before the call() (so this path covers
					// both "offline → enqueued" and "online classified →
					// enqueued via forceQueue / mid-flight network blip"),
					// but pre-load may have failed (private mode, quota,
					// corrupt JSON, malformed shape). An offline-ack arriving
					// without a USABLE snapshot means we can't fire
					// register_pos_data with the rich shape downstream
					// components expect (pos_profile.payments, company doc
					// fields). Surface a clear error instead of crashing on
					// `snapshot.pos_profile.name`.
					const okSnapshot =
						snapshot &&
						snapshot.pos_profile &&
						typeof snapshot.pos_profile === "object" &&
						snapshot.pos_profile.name &&
						snapshot.company &&
						(typeof snapshot.company === "object"
							? snapshot.company.name
							: snapshot.company);
					if (!okSnapshot) {
						this.is_loading = false;
						toast.error(
							__("Shift queued offline but the cached profile is missing. Reload while online to refresh the snapshot before opening another shift."),
							{ autoClose: 8000 },
						);
						return;
					}
					const provisionalShift = {
						name: r.provisional_name,
						pos_offline_id: r.offline_id,
						pos_profile: this.pos_profile,
						company: this.company,
						posting_date: new Date().toISOString().slice(0, 10),
						period_start_date: new Date().toISOString().replace("T", " ").slice(0, 19),
						user: snapshot.pos_opening_shift?.user || "",
						balance_details,
						denomination_details: denomination_details
							? JSON.parse(denomination_details)
							: [],
						pospire_pending_sync: true,
					};
					const data = {
						pos_opening_shift: provisionalShift,
						pos_profile: snapshot.pos_profile,
						company: snapshot.company,
						stock_settings: snapshot.stock_settings || { allow_negative_stock: 0 },
					};
					this.eventBus.emit("register_pos_data", data);
					this.eventBus.emit("set_company", data.company);
					toast.info(
						__("Shift opened offline — will sync when online."),
						{ autoClose: 4000 },
					);
					this.close_opening_dialog();
					return;
				}

				if (r) {
					this.eventBus.emit("register_pos_data", r);
					this.eventBus.emit("set_company", r.company);
					this.close_opening_dialog();
				}
			} finally {
				this.is_loading = false;
			}
		},
		go_desk() {
			window.location.href = "/app";
		},
	},
	created: function () {
		this.$nextTick(function () {
			this.get_opening_dialog_data();
		});
	},
	mounted() {
		// isOnline() needs THRESHOLD_ONLINE = 3 consecutive successful pings
		// before it flips back, and any offline:false read throws without
		// touching the network during that window. A dialog opened in the
		// gap would otherwise stay on stale config for its whole lifetime.
		this.unsubConnectivity = connectivity.onChange(() => {
			if (!connectivity.isOnline()) return;
			if (!this.config_is_stale && !this.config_unavailable) return;
			this.refresh_dialog_config();
		});
	},
	beforeUnmount() {
		if (this.unsubConnectivity) this.unsubConnectivity();
	},
};
</script>