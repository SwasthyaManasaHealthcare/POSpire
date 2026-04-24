# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Install offline-support custom fields and unique indexes.

Runs once post-model-sync (see patches.txt). Execution steps:

1. Install the new custom fields from the fixture. This is idempotent; the
   fixture loader is a no-op for fields that already exist.
2. Backfill `pos_offline_id = None` for existing rows. Historical data was
   created online and does not carry an offline id; we explicitly NULL the
   column so the unique-index creation in step 3 cannot fail on an empty
   string duplicate.
3. Create unique indexes on `pos_offline_id` for every host DocType. Frappe
   already gives us the index because the custom field declares `unique: 1`,
   but we issue `CREATE UNIQUE INDEX IF NOT EXISTS` here as a belt-and-braces
   defence against environments where the fixture loader runs after the
   patch (e.g. a partial apply).

See docs/offline/12-server-side-changes.md §7.
"""

from __future__ import annotations

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

_OFFLINE_CUSTOM_FIELDS: dict[str, list[dict]] = {
	"Sales Invoice": [
		{
			"fieldname": "pos_offline_id",
			"label": "POS Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"unique": 1,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "posa_submit_data",
			"description": "Idempotency key from the offline outbox (UUID v4).",
		},
		{
			"fieldname": "pos_device_id",
			"label": "POS Device ID",
			"fieldtype": "Data",
			"length": 64,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_offline_id",
			"description": "Originating POS device UUID for offline-queued writes.",
		},
		{
			"fieldname": "pos_opening_shift_offline_id",
			"label": "POS Opening Shift Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "pos_device_id",
			"description": "Offline ID of the parent POS Opening Shift when both are queued together.",
		},
		{
			"fieldname": "pos_material_receipt_offline_ids",
			"label": "POS Material Receipt Offline IDs",
			"fieldtype": "Small Text",
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_opening_shift_offline_id",
			"description": "JSON array of Material Receipt offline IDs referenced by this invoice (Feature 2).",
		},
	],
	"POS Opening Shift": [
		{
			"fieldname": "pos_profile_snapshot_allow_negative_stock",
			"label": "Snapshot: Allow Negative Stock",
			"fieldtype": "Check",
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_closing_shift",
			"description": "Snapshot of custom_allow_negative_stock from POS Profile at shift open (P-12).",
		},
		{
			"fieldname": "pos_profile_snapshot_allow_add_to_stock_at_pos",
			"label": "Snapshot: Allow Add to Stock at POS",
			"fieldtype": "Check",
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_profile_snapshot_allow_negative_stock",
			"description": "Snapshot of custom_allow_add_to_stock_at_pos from POS Profile at shift open (P-12).",
		},
		{
			"fieldname": "pos_offline_id",
			"label": "POS Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"unique": 1,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "pos_profile_snapshot_allow_add_to_stock_at_pos",
			"description": "Idempotency key from the offline outbox (UUID v4).",
		},
		{
			"fieldname": "pos_device_id",
			"label": "POS Device ID",
			"fieldtype": "Data",
			"length": 64,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_offline_id",
			"description": "Originating POS device UUID for offline-queued writes.",
		},
	],
	"POS Closing Shift": [
		{
			"fieldname": "pos_offline_id",
			"label": "POS Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"unique": 1,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "amended_from",
			"description": "Idempotency key from the offline outbox (UUID v4).",
		},
		{
			"fieldname": "pos_device_id",
			"label": "POS Device ID",
			"fieldtype": "Data",
			"length": 64,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_offline_id",
			"description": "Originating POS device UUID for offline-queued writes.",
		},
		{
			"fieldname": "variance_at_close",
			"label": "Variance At Close",
			"fieldtype": "Small Text",
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_device_id",
			"description": "Cashier-captured variance snapshot at close (JSON).",
		},
		{
			"fieldname": "variance_at_sync",
			"label": "Variance At Sync",
			"fieldtype": "Small Text",
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "variance_at_close",
			"description": "Server-computed variance at sync (JSON, D-4).",
		},
	],
	"Stock Entry": [
		{
			"fieldname": "pos_offline_id",
			"label": "POS Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"unique": 1,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "amended_from",
			"description": "Idempotency key from the offline outbox (UUID v4).",
		},
		{
			"fieldname": "pos_device_id",
			"label": "POS Device ID",
			"fieldtype": "Data",
			"length": 64,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"insert_after": "pos_offline_id",
			"description": "Originating POS device UUID for offline-queued writes.",
		},
	],
	"Customer": [
		{
			"fieldname": "pos_offline_id",
			"label": "POS Offline ID",
			"fieldtype": "Data",
			"length": 36,
			"unique": 1,
			"read_only": 1,
			"hidden": 1,
			"no_copy": 1,
			"search_index": 1,
			"insert_after": "posa_referral_code",
			"description": "Idempotency key for offline-created customers.",
		},
	],
}


_UNIQUE_INDEX_TARGETS: tuple[tuple[str, str], ...] = (
	("Sales Invoice", "pos_offline_id"),
	("POS Opening Shift", "pos_offline_id"),
	("POS Closing Shift", "pos_offline_id"),
	("Stock Entry", "pos_offline_id"),
	("Customer", "pos_offline_id"),
)


def execute() -> None:
	"""Install custom fields, backfill NULL, create unique indexes."""
	# Step 1: install the offline custom fields.
	create_custom_fields(_OFFLINE_CUSTOM_FIELDS, ignore_validate=True, update=True)

	# Step 2: backfill existing rows. Explicit NULL (not empty string) is
	# required for the unique index to not trip on duplicate "" values.
	for doctype, _fieldname in _UNIQUE_INDEX_TARGETS:
		table = f"tab{doctype}"
		try:
			frappe.db.sql(f"UPDATE `{table}` SET `pos_offline_id` = NULL WHERE `pos_offline_id` = ''")
		except Exception:
			# If the column does not yet exist in some environments (fixture
			# hasn't been applied), skip — the post-migrate reload will pick
			# it up on the next run.
			continue

	# Step 3: ensure a unique index exists. Frappe honours `unique: 1` on the
	# custom field, but explicit CREATE is cheap and makes the constraint
	# discoverable in schema diffs.
	for doctype, fieldname in _UNIQUE_INDEX_TARGETS:
		table = f"tab{doctype}"
		index_name = f"unique_{fieldname}_idx"
		try:
			frappe.db.sql(f"CREATE UNIQUE INDEX `{index_name}` ON `{table}` (`{fieldname}`)")
		except Exception:
			# Index already exists, or column not yet present — idempotent.
			continue

	frappe.db.commit()
	frappe.clear_cache()
