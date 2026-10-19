<template>
	<div>
		<div class="d-flex align-center">
			<div v-if="showActions && !readonly" class="d-flex align-center mr-2">
				<v-icon
					class="customer-action-icon mr-2"
					color="primary"
					@click.stop="edit_customer"
				>mdi-account-edit</v-icon>
				<v-icon
					class="customer-action-icon"
					color="primary"
					@click.stop="new_customer"
				>mdi-account-plus</v-icon>
			</div>
			<v-autocomplete
				class="flex-grow-1"
				density="compact"
				clearable
				auto-select-first
				variant="outlined"
				color="primary"
				:label="__('Customer')"
				v-model="customer"
				v-model:search="search_text"
				:loading="searching"
				:items="customers"
				item-title="customer_name"
				item-value="name"
				hide-details
				:customFilter="customFilter"
				:disabled="readonly"
			>
				<template v-slot:no-data>
					<v-list-item
						v-if="showActions && !readonly && search_text && !searching"
						prepend-icon="mdi-account-plus"
						:title="__('Create customer with {0}', [search_text])"
						@click="new_customer_from_search"
					/>
					<v-list-item v-else :title="searching ? __('Searching...') : __('Customers not found')" />
				</template>
				<template v-slot:item="{ props, item }">
					<v-list-item v-bind="props">
						<template v-slot:append v-if="isPendingSync(item.raw)">
							<v-chip
								size="x-small"
								color="warning"
								variant="tonal"
								:title="__('This customer was created offline and has not yet synced to the server.')"
							>
								<v-icon start size="x-small">mdi-cloud-sync-outline</v-icon>
								{{ __('pending sync') }}
							</v-chip>
						</template>
						<v-list-item-subtitle v-if="item.raw.mobile_no">
							<div>Mobile No: {{ item.raw.mobile_no }}</div>
						</v-list-item-subtitle>
						<v-list-item-subtitle v-if="item.raw.customer_name != item.raw.name">
							<div>ID: {{ item.raw.name }}</div>
						</v-list-item-subtitle>
						<v-list-item-subtitle v-if="item.raw.tax_id">
							<div>TAX ID: {{ item.raw.tax_id }}</div>
						</v-list-item-subtitle>
						<v-list-item-subtitle v-if="item.raw.email_id">
							<div>Email: {{ item.raw.email_id }}</div>
						</v-list-item-subtitle>
						<v-list-item-subtitle v-if="item.raw.primary_address">
							<div>Primary Address: {{ item.raw.primary_address }}</div>
						</v-list-item-subtitle>
					</v-list-item>
				</template>
			</v-autocomplete>
		</div>

		<UpdateCustomer />
	</div>
</template>

<script>
import { call, unwrapStale } from "@/utils/call";
import UpdateCustomer from "./UpdateCustomer.vue";
import { onSynced } from "@/offline/outbox";
import { renameCustomer, listOfflineCreated } from "@/offline/repos/customers";
import busListeners from "@/utils/busListeners";
import { mobileMatches } from "@/utils/mobileMatch";
import connectivity from "@/offline/connectivity";
export default {
	mixins: [busListeners],
	props: {
		showActions: {
			type: Boolean,
			default: true,
		},
	},

	data: () => ({
		pos_profile: "",
		customers: [],
		customer: "",
		// pos_offline_id of the current customer when it was offline-created
		// (UpdateCustomer.vue emits `set_customer_offline_id` paired with the
		// provisional name). null when the customer is server-resolved.
		customer_offline_id: null,
		readonly: false,
		customer_info: {},
		search_text: "",
		searching: false,
	}),

	components: {
		UpdateCustomer,
	},

	methods: {
		async get_customer_names() {
			var vm = this;
			if (this.customers.length > 0) {
				return;
			}
			const profile_doc = vm.pos_profile.pos_profile;
			if (profile_doc?.posa_local_storage && localStorage.customer_storage) {
				// Defensive unwrap on hydrate: an earlier build path could
				// have stored the StaleReadResult wrapper here. Strip it on
				// read so a device with the bad cache shape recovers without
				// manual intervention.
				const hydrated = unwrapStale(
					JSON.parse(localStorage.getItem("customer_storage")),
				);
				vm.customers = Array.isArray(hydrated) ? hydrated : [];
			}

			let r = null;
			try {
				r = await call("pospire.pospire.api.posapp.get_customer_names", {
					pos_profile: profile_doc,
				});
			} catch {
				// Offline / transport failure. The localStorage hydration above
				// (if posa_local_storage is enabled) has already populated the
				// dropdown, so swallow rather than rejecting upward.
				return;
			}
			if (r) {
				// `get_customer_names` is offline:true; on a stale-cache hit
				// call() returns a StaleReadResult wrapper { data, stale,
				// cachedAt }. Unwrap before persistence + binding.
				const customers = unwrapStale(r);
				vm.customers = Array.isArray(customers) ? customers : [];
				if (profile_doc?.posa_local_storage) {
					localStorage.setItem("customer_storage", "");
					localStorage.setItem("customer_storage", JSON.stringify(vm.customers));
				}
			}

			// M3 — merge offline-created customers from Dexie that haven't
			// yet synced. UpdateCustomer.vue persists each provisional
			// customer to the encrypted Dexie table at create time, but
			// without this rehydrate the picker would only show server-side
			// customers after a reload, dropping the still-pending ones from
			// the cashier's view until the outbox drains.
			try {
				const offlineCustomers = await listOfflineCreated();
				const existingNames = new Set(
					vm.customers.map((c) => (c && typeof c.name === "string" ? c.name : null)),
				);
				for (const oc of offlineCustomers) {
					if (existingNames.has(oc.name)) continue;
					// Mirror the row shape the picker template consumes.
					vm.customers.push({
						name: oc.name,
						customer_name: oc.customer_name,
						mobile_no: oc.mobile_no,
						tax_id: oc.tax_id,
						email_id: oc.email_id,
						customer_group: oc.customer_group,
						pos_offline_id: oc.offline_id,
					});
				}
			} catch (err) {
				console.warn(
					"[Customer] listOfflineCreated rehydrate failed (provisional customers may be missing until next sync)",
					err,
				);
			}
		},
		new_customer() {
			this.eventBus.emit("open_update_customer", null);
		},
		new_customer_from_search() {
			const text = this.search_text.trim();
			let field = "customer_name";
			if (text.includes("@")) field = "email_id";
			else if (/^[\d\s+()-]+$/.test(text)) field = "mobile_no";
			this.eventBus.emit("open_update_customer", { prefill: { [field]: text } });
		},
		edit_customer() {
			this.eventBus.emit("open_update_customer", this.customer_info);
		},
		/**
		 * A customer is "pending sync" when its name is still the provisional
		 * `OFFLINE-CUST-<offline_id>` form. After the outbox row syncs, the
		 * onSynced listener swaps the name to the real server doc name and
		 * this returns false again.
		 *
		 * Falls back to the `pos_offline_id` flag for the brief window where
		 * `add_customer_to_list` ran with the offline_id but the name happens
		 * to be a real server name (defensive — shouldn't happen in practice).
		 */
		isPendingSync(row) {
			if (!row || typeof row.name !== "string") return false;
			if (row.name.startsWith("OFFLINE-CUST-")) return true;
			return false;
		},
		customFilter(itemText, queryText, itemRow) {
			return this.matchesCustomer(itemRow.raw, queryText);
		},
		// Every word must appear in name, ID, tax ID, email or mobile, same as the server search.
		matchesCustomer(item, queryText) {
			const haystack = [item.customer_name, item.name, item.tax_id, item.email_id, item.mobile_no]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			const words = queryText.toLowerCase().split(/\s+/).filter(Boolean);
			return words.every((w) => haystack.includes(w)) || mobileMatches(queryText, item.mobile_no);
		},
		// Customers outside the loaded list (other groups, or created since the list loaded).
		async search_server(text) {
			this.searching = true;
			try {
				const rows = await call("pospire.pospire.api.customer.search_customers", {
					pos_profile: this.pos_profile?.pos_profile?.name,
					query: text,
				});
				const known = new Set(this.customers.map((c) => c.name));
				this.customers.push(...(Array.isArray(rows) ? rows : []).filter((r) => !known.has(r.name)));
			} catch {
				// Offline or server error: the local results stand.
			} finally {
				this.searching = false;
			}
		},
	},

	computed: {},

	created: function () {
		this.$nextTick(function () {
			this.onBus("register_pos_profile", (pos_profile) => {
				this.pos_profile = pos_profile;
				// Reset the list so get_customer_names re-fetches even if customers
				// were already loaded — profile changes can alter customer group filters.
				this.customers = [];
				this.get_customer_names();
			});
			this.onBus("payments_register_pos_profile", (pos_profile) => {
				this.pos_profile = pos_profile;
				this.get_customer_names();
			});
			this.onBus("set_customer", (customer) => {
				this.customer = customer;
				// customer_offline_id is derived in the watcher below from
				// the customers list — single source of truth, avoids
				// emit-ordering bugs.
			});
			this.onBus("add_customer_to_list", (customer) => {
				this.customers.push(customer);
			});
			this.onBus("set_customer_readonly", (value) => {
				this.readonly = value;
			});
			this.onBus("set_customer_info_to_edit", (data) => {
				this.customer_info = data;
			});
			this.onBus("fetch_customer_details", () => {
				this.get_customer_names();
			});

			// Master-data invalidation: Pos.vue emits refresh_customers when
			// a Customer doc is saved/deleted from the desk.
			this.onBus("refresh_customers", () => {
				const profile_doc = this.pos_profile?.pos_profile;
				// Clear stale localStorage so hydration does not serve old data.
				if (profile_doc?.posa_local_storage) {
					try { localStorage.removeItem("customer_storage"); } catch (_e) { /* noop */ }
				}
				this.customers = [];
				this.get_customer_names();
			});

			// Outbox sync notification: when a customer that was created
			// offline finally syncs, the server returns its real customer
			// name. Rename the row in the dropdown, in Dexie, and (via the
			// `customer_renamed` event) in any cart that's still pointing at
			// the provisional `OFFLINE-CUST-...` name.
			this._unsubOnSynced = onSynced((event) => {
				if (event.type !== "customer") return;
				if (!event.provisional_name || !event.server_doc_name) return;
				if (event.provisional_name === event.server_doc_name) return;

				const entry = this.customers.find(
					(c) => c && c.name === event.provisional_name,
				);
				if (entry) {
					entry.name = event.server_doc_name;
					// Clear pos_offline_id once the customer has a real
					// server doc name. Otherwise the watcher below would
					// continue emitting the (now-resolved) offline_id on
					// every customer pick, and Payments.vue's `forceQueue`
					// branch — which checks `customer_offline_id` — would
					// force-queue every future invoice for this customer
					// even when online. The outbox row's pos_offline_id
					// is the audit anchor; the in-memory customers entry
					// no longer needs it.
					entry.pos_offline_id = null;
				}

				// Persist the rename to the local cache so a reload doesn't
				// reintroduce the old name.
				renameCustomer(event.provisional_name, event.server_doc_name).catch(
					(err) => console.warn(
						"[Customer] renameCustomer failed (cache will reload from server)",
						err,
					),
				);

				if (this.customer === event.provisional_name) {
					// Trigger our watcher (which derives offline_id and emits
					// update_customer / update_customer_offline_id together).
					this.customer = event.server_doc_name;
				}

				// Notify the cart layer (Invoice.vue) so an in-flight draft
				// invoice updates its `doc.customer` field too.
				this.eventBus.emit("customer_renamed", {
					old_name: event.provisional_name,
					new_name: event.server_doc_name,
				});
			});
		});
	},

	beforeUnmount() {
		clearTimeout(this._searchTimer);
		if (typeof this._unsubOnSynced === "function") {
			this._unsubOnSynced();
			this._unsubOnSynced = null;
		}
	},

	watch: {
		search_text(query) {
			clearTimeout(this._searchTimer);
			const text = (query || "").trim();
			if (text.length < 3 || !connectivity.isOnline()) return;
			if (this.customers.some((c) => c && this.matchesCustomer(c, text))) return;
			this._searchTimer = setTimeout(() => this.search_server(text), 300);
		},
		customer(newName) {
			// Derive offline_id from the customers list (the single source of
			// truth for offline-created customers — UpdateCustomer.vue pushes
			// new offline customers via add_customer_to_list with pos_offline_id
			// set). Emit both events together so Invoice.vue gets a coherent
			// snapshot in one tick, avoiding the watcher-vs-handler race that
			// previously erased the offline_id.
			const entry = this.customers.find((c) => c && c.name === newName);
			const offlineId = (entry && entry.pos_offline_id) || null;
			this.customer_offline_id = offlineId;
			this.eventBus.emit("update_customer", newName);
			this.eventBus.emit("update_customer_offline_id", offlineId);
		},
	},
};
</script>

<style scoped>
.customer-action-icon {
	cursor: pointer;
	transition: transform 0.15s ease, filter 0.15s ease, color 0.15s ease;
}

.customer-action-icon:hover {
	transform: scale(1.3);
	color: rgb(var(--v-theme-primary)) !important;
	filter: brightness(1.25) drop-shadow(0 0 4px rgba(var(--v-theme-primary), 0.45));
}

.customer-action-icon:active {
	transform: scale(1.1);
}
</style>
