<template>
  <!--
    Reconciliation workspace — Phase 1 stub.
    Scope (per AGENTS brief): list view of `needs_review` outbox entries with
    three per-row actions: Retry, Void (with reason), Edit & Retry
    (placeholder — Phase 2, task 2.8).

    Full UX (shift-level grouping, category-specific flows, audit panel) lives
    in Phase 2. See docs/offline/11-ui-ux.md §5.
  -->
  <v-card class="reconciliation-workspace" elevation="1">
    <v-card-title class="reconciliation-workspace__title">
      {{ __('Reconciliation Workspace') }}
      <v-chip v-if="needsReviewCount > 0" size="small" color="error" variant="tonal" class="ml-2">
        {{ needsReviewCount }}
      </v-chip>
    </v-card-title>

    <v-card-subtitle>
      {{ __('Entries that failed to sync and need manager attention.') }}
    </v-card-subtitle>

    <v-divider />

    <div v-if="entries.length === 0" class="reconciliation-workspace__empty">
      <v-icon icon="mdi-check-circle-outline" size="48" color="success" />
      <div>{{ __('No entries currently need review.') }}</div>
    </div>

    <v-list v-else lines="two" class="reconciliation-workspace__list">
      <v-list-item v-for="entry in entries" :key="entry.offline_id" class="reconciliation-workspace__row">
        <template #prepend>
          <v-icon :icon="iconForCategory(entry.last_error_category)" :color="colorForCategory(entry.last_error_category)"
            size="large" />
        </template>

        <v-list-item-title class="reconciliation-workspace__headline">
          <span class="reconciliation-workspace__shortid">OFFLINE-{{ shortId(entry.offline_id) }}</span>
          <v-chip size="x-small" variant="tonal">{{ entry.type }}</v-chip>
          <v-chip size="x-small" variant="tonal" :color="colorForCategory(entry.last_error_category)">
            {{ entry.last_error_category || 'unknown' }}
          </v-chip>
        </v-list-item-title>

        <v-list-item-subtitle>
          {{ __('Enqueued') }} {{ formatEnqueued(entry.enqueued_at) }}
        </v-list-item-subtitle>

        <template #append>
          <div class="reconciliation-workspace__actions">
            <v-btn size="small" color="primary" variant="tonal" :loading="busyIds[entry.offline_id] === 'retry'"
              :disabled="!!busyIds[entry.offline_id]" @click="onRetry(entry.offline_id)">
              {{ __('Retry') }}
            </v-btn>
            <v-btn size="small" color="warning" variant="tonal" :disabled="!!busyIds[entry.offline_id]"
              @click="onEditRetry">
              {{ __('Edit & Retry') }}
            </v-btn>
            <v-btn size="small" color="error" variant="tonal" :loading="busyIds[entry.offline_id] === 'void'"
              :disabled="!!busyIds[entry.offline_id]" @click="openVoidDialog(entry.offline_id)">
              {{ __('Void') }}
            </v-btn>
          </div>
        </template>
      </v-list-item>
    </v-list>

    <!-- Void confirmation dialog -->
    <v-dialog v-model="voidDialog.open" max-width="420" persistent>
      <v-card>
        <v-card-title>{{ __('Void entry') }}</v-card-title>
        <v-card-text>
          <div class="mb-2">
            {{ __('This marks the entry voided for audit. It will not be re-submitted.') }}
          </div>
          <v-text-field v-model="voidDialog.reason" :label="__('Reason (required)')" autofocus variant="outlined"
            density="compact" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeVoidDialog">{{ __('Cancel') }}</v-btn>
          <v-btn color="error" :disabled="!voidDialog.reason.trim()" @click="confirmVoid">
            {{ __('Void') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script>
/**
 * ReconciliationWorkspace.vue (Phase 1 stub).
 *
 * Reads the list of `needs_review` outbox entries from the Pinia outbox
 * store (which subscribes to Dexie via `liveQuery`). Per-row actions call
 * Agent 3's `@/offline/outbox` API directly — those are local state
 * mutations on IndexedDB, not network calls, so they do NOT route through
 * `@/utils/call` (P-2 applies to network I/O).
 *
 * Edit & Retry is Phase 2 (task 2.8) — button is wired to show a toast
 * explaining the feature is pending.
 */
import { computed, defineComponent, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { toast } from "vue3-toastify";

import { useOutboxStore } from "@/stores/outbox";
import { resetForRetry, voidEntry } from "@/offline/outbox";
import { OFFLINE_SHORT_ID_LENGTH } from "@/offline/constants";

export default defineComponent({
  name: "ReconciliationWorkspace",
  setup() {
    const outbox = useOutboxStore();
    const { needsReviewEntries, needsReviewCount } = storeToRefs(outbox);

    // Per-row in-flight guard so double-clicks don't fire duplicate actions.
    // Keyed by offline_id -> action tag (used to drive the right button's
    // loading state).
    const busyIds = reactive({});

    const entries = computed(() => needsReviewEntries.value);

    function shortId(offlineId) {
      return offlineId.slice(0, OFFLINE_SHORT_ID_LENGTH);
    }

    function formatEnqueued(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      // Local-time short format. Not using any Frappe helper because `frappe`
      // global is forbidden in the Vite bundle (CLAUDE.md).
      return d.toLocaleString();
    }

    function iconForCategory(cat) {
      switch (cat) {
        case "validation_error":
          return "mdi-alert-circle-outline";
        case "permission_error":
          return "mdi-lock-outline";
        case "customer_missing":
          return "mdi-account-question-outline";
        case "batch_or_serial_conflict":
          return "mdi-barcode";
        case "stock_shortage":
          return "mdi-package-variant-closed";
        case "accounting_period_closed":
          return "mdi-calendar-lock-outline";
        case "retry_exhausted":
          return "mdi-sync-alert";
        case "schema_mismatch":
          return "mdi-database-alert-outline";
        default:
          return "mdi-help-circle-outline";
      }
    }

    function colorForCategory(cat) {
      switch (cat) {
        case "stock_shortage":
        case "customer_missing":
        case "batch_or_serial_conflict":
          return "warning";
        case "permission_error":
        case "accounting_period_closed":
        case "validation_error":
        case "schema_mismatch":
          return "error";
        default:
          return "grey-darken-1";
      }
    }

    async function onRetry(offlineId) {
      if (busyIds[offlineId]) return;
      busyIds[offlineId] = "retry";
      try {
        // Agent 3 exported `resetForRetry` — clears needs_review + blocked
        // flags and wakes the scheduler via the enqueue notifier.
        await resetForRetry(offlineId);
        toast.success(`Re-queued OFFLINE-${shortId(offlineId)}`);
      } catch (err) {
        console.error("[ReconciliationWorkspace] retry failed", err);
        toast.error(err && err.message ? err.message : "Retry failed");
      } finally {
        delete busyIds[offlineId];
      }
    }

    // ---- Void dialog state ----------------------------------------------

    const voidDialog = ref({
      open: false,
      offlineId: "",
      reason: "",
    });

    function openVoidDialog(offlineId) {
      voidDialog.value = { open: true, offlineId, reason: "" };
    }

    function closeVoidDialog() {
      voidDialog.value = { open: false, offlineId: "", reason: "" };
    }

    async function confirmVoid() {
      const { offlineId, reason } = voidDialog.value;
      if (!offlineId || !reason.trim()) return;
      busyIds[offlineId] = "void";
      try {
        await voidEntry(offlineId, reason.trim());
        toast.success(`Voided OFFLINE-${shortId(offlineId)}`);
        closeVoidDialog();
      } catch (err) {
        console.error("[ReconciliationWorkspace] void failed", err);
        toast.error(err && err.message ? err.message : "Void failed");
      } finally {
        delete busyIds[offlineId];
      }
    }

    function onEditRetry() {
      // Phase 2 (task 2.8). Placeholder toast — the structured editor is the
      // next deliverable.
      toast.info(
        "Edit & Retry is coming in Phase 2. For now, use Retry or Void.",
      );
    }

    return {
      entries,
      needsReviewCount,
      busyIds,
      voidDialog,
      shortId,
      formatEnqueued,
      iconForCategory,
      colorForCategory,
      onRetry,
      onEditRetry,
      openVoidDialog,
      closeVoidDialog,
      confirmVoid,
    };
  },
});
</script>

<style scoped>
.reconciliation-workspace {
  padding: 8px;
}

.reconciliation-workspace__title {
  display: flex;
  align-items: center;
  font-weight: 600;
}

.reconciliation-workspace__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
  color: #64748b;
}

.reconciliation-workspace__list {
  padding: 0;
}

.reconciliation-workspace__row {
  border-bottom: 1px solid #e2e8f0;
}

.reconciliation-workspace__headline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.reconciliation-workspace__shortid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.5px;
}

.reconciliation-workspace__actions {
  display: flex;
  gap: 6px;
}
</style>
