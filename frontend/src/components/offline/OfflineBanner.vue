<template>
  <!--
    Connectivity + sync banner. Per 11-ui-ux.md §2: anchored below the navbar,
    non-modal, non-toast. Visibility gated by store-derived state so it never
    rerenders on every connectivity flap (D-31 debounce lives inside
    @/offline/connectivity; by the time the store sees a transition it's
    already debounced).

    State priority (highest first):
      1. needs_review count > 0 → red attention banner (managers)
      2. offline → amber
      3. degraded connectivity → amber "unstable"
      4. online + queuedCount > 0 → blue "syncing"
      5. otherwise → hidden
  -->
  <div v-if="bannerState !== 'hidden'" class="offline-banner" :class="`offline-banner--${bannerState}`" role="status"
    aria-live="polite">
    <v-icon class="offline-banner__icon" :icon="iconForState"></v-icon>
    <span class="offline-banner__label">{{ label }}</span>
    <span v-if="subLabel" class="offline-banner__sub">{{ subLabel }}</span>
    <button v-if="bannerState === 'needs_review'" class="offline-banner__link" @click="$emit('open-reconciliation')">
      {{ __('Review now') }}
    </button>
    <!--
      OFFLINE state: cashier-tappable "Try connection now". Forces an immediate
      ping (bypasses polling cadence). On success, single ping is enough to
      transition the detector to ONLINE; the scheduler then drains naturally.
      On failure we surface a toast so the tap doesn't feel ignored.
    -->
    <button v-if="bannerState === 'offline'" class="offline-banner__link" :disabled="trying"
      @click="onTryConnectionNow">
      <v-icon v-if="trying" size="small" class="mr-1">mdi-loading mdi-spin</v-icon>
      {{ trying ? __('Checking…') : __('Try connection now') }}
    </button>
  </div>
</template>

<script>
/**
 * OfflineBanner.vue
 *
 * Consumes the Pinia `connectivity` and `outbox` stores. No direct network
 * I/O (P-2); no `frappe-ui` imports (component-level rule). The banner is
 * presentational — actions like force-online live on a manager panel.
 */
import { computed, defineComponent, ref } from "vue";
import { storeToRefs } from "pinia";
import { toast } from "vue3-toastify";

import { useConnectivityStore } from "@/stores/connectivity";
import { useOutboxStore } from "@/stores/outbox";
import connectivityModule from "@/offline/connectivity";

export default defineComponent({
  name: "OfflineBanner",
  emits: ["open-reconciliation"],
  setup() {
    const connectivity = useConnectivityStore();
    const outbox = useOutboxStore();
    const trying = ref(false);

    async function onTryConnectionNow() {
      if (trying.value) return;
      trying.value = true;
      try {
        const ok = await connectivityModule.forcePingNow();
        if (!ok) {
          toast.warning(__("Still offline — server unreachable"), { autoClose: 3000 });
        }
        // On success the connectivity transition fires; banner auto-hides.
      } finally {
        trying.value = false;
      }
    }

    // `storeToRefs` preserves reactivity on destructured refs.
    const { connectionQuality } = storeToRefs(connectivity);
    const {
      pendingCount,
      inFlightCount,
      needsReviewCount,
      queuedCount,
      oldestPendingMinutes,
    } = storeToRefs(outbox);

    // State priority (see template comment).
    const bannerState = computed(() => {
      if (needsReviewCount.value > 0) return "needs_review";
      if (connectionQuality.value === "offline") return "offline";
      if (connectionQuality.value === "degraded") return "degraded";
      if (queuedCount.value > 0) return "syncing";
      return "hidden";
    });

    const label = computed(() => {
      switch (bannerState.value) {
        case "needs_review":
          return `${needsReviewCount.value} transaction${needsReviewCount.value === 1 ? "" : "s"} need attention`;
        case "offline": {
          if (oldestPendingMinutes.value !== null && oldestPendingMinutes.value >= 30) {
            return `You are offline — ${oldestPendingMinutes.value} min`;
          }
          return `You are offline — ${queuedCount.value} transaction${queuedCount.value === 1 ? "" : "s"} queued`;
        }
        case "degraded":
          return "Connectivity unstable — saving locally";
        case "syncing":
          return `Syncing ${inFlightCount.value || pendingCount.value} transaction${(inFlightCount.value || pendingCount.value) === 1 ? "" : "s"}…`;
        default:
          return "";
      }
    });

    const subLabel = computed(() => {
      if (bannerState.value === "offline") {
        return "Sales continue; transactions will sync when online.";
      }
      if (bannerState.value === "degraded") {
        return "Do not hard-reload.";
      }
      return "";
    });

    const iconForState = computed(() => {
      switch (bannerState.value) {
        case "needs_review":
          return "mdi-alert-circle-outline";
        case "offline":
          return "mdi-cloud-off-outline";
        case "degraded":
          return "mdi-access-point-network-off";
        case "syncing":
          return "mdi-cloud-sync-outline";
        default:
          return "mdi-circle-outline";
      }
    });

    return {
      bannerState,
      label,
      subLabel,
      iconForState,
      trying,
      onTryConnectionNow,
    };
  },
});
</script>

<style scoped>
.offline-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 0.92rem;
  font-weight: 500;
  width: 100%;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  line-height: 1.3;
  /* Below the navbar; Pos.vue owns the stacking. */
  z-index: 5;
}

.offline-banner__icon {
  font-size: 20px !important;
  flex-shrink: 0;
}

.offline-banner__label {
  font-weight: 600;
}

.offline-banner__sub {
  font-weight: 400;
  opacity: 0.85;
}

.offline-banner__link {
  margin-left: auto;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.offline-banner__link:hover {
  background: rgba(255, 255, 255, 0.35);
}

/* ONLINE (hidden) is handled by v-if; no rule needed. */

.offline-banner--syncing {
  background: #1e88e5;
  color: #ffffff;
}

.offline-banner--degraded {
  background: #ffb300;
  color: #263238;
}

.offline-banner--offline {
  background: #e65100;
  color: #ffffff;
}

.offline-banner--needs_review {
  background: #c62828;
  color: #ffffff;
}
</style>
