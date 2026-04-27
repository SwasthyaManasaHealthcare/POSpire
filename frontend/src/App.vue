<template>
	<v-app class="pospire-app">
		<v-main>
			<Navbar
				@changePage="navigateTo($event)"
				@open-reconciliation="reconciliationOpen = true"
			></Navbar>
			<!--
				Offline banner — anchored below the navbar per 11-ui-ux.md §2.
				Hidden in the steady-state online path; shows automatically when
				the connectivity detector flips to OFFLINE/DEGRADED, or when
				there are pending / needs-review entries in the outbox.
			-->
			<OfflineBanner @open-reconciliation="reconciliationOpen = true"></OfflineBanner>
			<router-view class="mx-4 md-4"></router-view>

			<!--
				Reconciliation workspace — opens via the banner's "Review now"
				button or the Navbar's pending-sync badge. Modal so the user
				doesn't lose their place in the cart.
			-->
			<v-dialog v-model="reconciliationOpen" max-width="900" scrollable>
				<ReconciliationWorkspace />
			</v-dialog>
		</v-main>
	</v-app>
</template>

<script>
import Navbar from "@/components/Navbar.vue";
import OfflineBanner from "@/components/offline/OfflineBanner.vue";
import ReconciliationWorkspace from "@/components/offline/ReconciliationWorkspace.vue";
import connectivity from "@/offline/connectivity";
import { initOfflineStorage } from "@/offline/db";
import { registerReadCache } from "@/offline/runtime";
import { InMemoryReadCache } from "@/offline/read-cache";
import { scheduler as syncScheduler } from "@/offline/sync";

export default {
	components: {
		Navbar,
		OfflineBanner,
		ReconciliationWorkspace,
	},
	data() {
		return {
			reconciliationOpen: false,
			offlineDisabled: false,
		};
	},
	async mounted() {
		// Bootstrap the offline storage layer: opens Dexie, seeds device_id,
		// generates the encryption key (D-24), starts the health probe.
		// On failure (e.g. crypto.subtle unavailable, IndexedDB blocked) we
		// boot in offline-disabled mode rather than crashing the SPA.
		try {
			await initOfflineStorage();
		} catch (err) {
			this.offlineDisabled = true;
			// eslint-disable-next-line no-console
			console.error(
				"[App] initOfflineStorage failed; running in offline-disabled mode",
				err,
			);
			// Skip the rest — without storage, scheduler / connectivity have
			// nothing to do.
			return;
		}

		// Wire the in-memory ReadCache so `call({intent:'read', cacheKey})`
		// returns from cache instead of always falling through to live fetch
		// or `OfflineReadUnavailable`. Phase 2 swaps this for an IndexedDB
		// implementation that survives reload.
		registerReadCache(new InMemoryReadCache());

		// Start the connectivity detector so it drives the banner state.
		connectivity.start();

		// Start the outbox sync scheduler. Acquires the Web Locks API leader
		// lock; only the leader tab drains. Other tabs read state passively
		// via BroadcastChannel("pospire-offline").
		syncScheduler.start().catch((err) => {
			// eslint-disable-next-line no-console
			console.warn("[App] syncScheduler.start failed", err);
		});
	},
	beforeUnmount() {
		// Clean teardown of background timers + in-flight fetches when the
		// SPA is being torn down (e.g. tab close / Frappe logout).
		try {
			syncScheduler.stop();
		} catch {
			/* idempotent */
		}
		try {
			connectivity.stop();
		} catch {
			/* idempotent */
		}
	},
	methods: {
		navigateTo(page) {
			const route = page === "Payments" ? "/payments" : "/pos";
			if (this.$route.path !== route) {
				this.$router.push(route);
			}
		},
	},
};
</script>

<style scoped>
.pospire-app {
	margin-top: 0px;
	height: 100vh;
}
</style>
