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
		};
	},
	mounted() {
		// Start the connectivity detector so it drives the banner's state.
		// Pings the server on a cadence; flips ONLINE/OFFLINE based on
		// success/failure thresholds (04-connectivity-detection.md).
		connectivity.start();

		// Start the outbox sync scheduler. Acquires the Web Locks API leader
		// lock; only the leader tab drains. Other tabs read state passively
		// via BroadcastChannel("pospire-offline").
		syncScheduler.start().catch((err) => {
			// Non-fatal — scheduler can't acquire leader lock or no work yet.
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
