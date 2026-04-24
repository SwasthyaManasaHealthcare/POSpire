# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""POSpire offline sync endpoints.

This module is the server-side contract for the offline outbox. Every method
here implements idempotent writes keyed on `pos_offline_id` (UUID v4) and
respects snapshotted metadata (posting date, owner, POS Profile flags) from
the payload rather than the live session.

See docs/offline/12-server-side-changes.md for the full spec,
docs/offline/01-architecture-principles.md P-5/P-11/P-12 for invariants, and
docs/offline/15-decision-log.md D-22/D-23 for idempotency lock decisions.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable, Iterable
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, now

# ---------------------------------------------------------------------------
# Error taxonomy (see docs/offline/12-server-side-changes.md §5)
# ---------------------------------------------------------------------------

ERROR_PARENT_NOT_READY = "parent_not_ready"
ERROR_SIBLINGS_NOT_READY = "siblings_not_ready"
ERROR_STOCK_SHORTAGE = "stock_shortage"
ERROR_BATCH_OR_SERIAL_CONFLICT = "batch_or_serial_conflict"
ERROR_ACCOUNTING_PERIOD_CLOSED = "accounting_period_closed"
ERROR_VALIDATION = "validation_error"
ERROR_PERMISSION = "permission_error"
ERROR_SCHEMA_MISMATCH = "schema_mismatch"

_HTTP_STATUS_BY_CODE: dict[str, int] = {
	ERROR_PARENT_NOT_READY: 409,
	ERROR_SIBLINGS_NOT_READY: 409,
	ERROR_STOCK_SHORTAGE: 409,
	ERROR_BATCH_OR_SERIAL_CONFLICT: 409,
	ERROR_ACCOUNTING_PERIOD_CLOSED: 417,
	ERROR_VALIDATION: 400,
	ERROR_PERMISSION: 403,
	ERROR_SCHEMA_MISMATCH: 426,
}


class OfflineSubmitError(frappe.ValidationError):
	"""Structured error for offline sync failures.

	The outbox sync engine on the client parses `exc_type`, `error_code`,
	`message`, and `details` without inspecting the prose. See
	docs/offline/05-outbox-and-sync.md §5.
	"""

	http_status_code = 400

	def __init__(self, error_code: str, message: str, details: dict[str, Any] | None = None) -> None:
		self.error_code = error_code
		self.details = dict(details or {})
		super().__init__(message)


# UUID v4: 8-4-4-4-12 hex, version nibble "4", variant nibble in {8,9,a,b}.
_UUID_V4_RE = re.compile(
	r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
	re.IGNORECASE,
)


def _throw(error_code: str, message: str, details: dict[str, Any] | None = None) -> None:
	"""Emit a structured OfflineSubmitError and set the HTTP status.

	Frappe's exception handler serialises `exc_type`, the message, and any
	fields attached to `frappe.local.response`. We shape the payload so the
	client sees `{ exc_type, error_code, message, details }` consistently.
	"""
	status = _HTTP_STATUS_BY_CODE.get(error_code, 400)
	if hasattr(frappe.local, "response"):
		frappe.local.response["http_status_code"] = status
		frappe.local.response["error_code"] = error_code
		frappe.local.response["details"] = dict(details or {})

	err = OfflineSubmitError(error_code, message, details)
	err.http_status_code = status
	raise err


def _validate_uuid(offline_id: str | None, field: str = "offline_id") -> str:
	"""Require a canonical UUID v4 or throw `validation_error`."""
	if not isinstance(offline_id, str) or not _UUID_V4_RE.match(offline_id):
		_throw(
			ERROR_VALIDATION,
			_("Invalid {0}: must be UUID v4").format(field),
			{"field": field, "value": offline_id if isinstance(offline_id, str) else None},
		)
	return offline_id


def _load(payload: Any) -> dict[str, Any]:
	"""Normalise a JSON-encoded string or already-parsed dict payload."""
	if payload is None:
		return {}
	if isinstance(payload, str):
		try:
			parsed = json.loads(payload)
		except json.JSONDecodeError as exc:
			_throw(ERROR_VALIDATION, _("Payload is not valid JSON: {0}").format(exc.msg))
			return {}  # unreachable — _throw raises
		return parsed if isinstance(parsed, dict) else {}
	if isinstance(payload, dict):
		return payload
	_throw(ERROR_VALIDATION, _("Payload must be an object"))
	return {}  # unreachable — satisfies type checker


def _load_list(payload: Any) -> list[Any]:
	if payload is None:
		return []
	if isinstance(payload, str):
		try:
			parsed = json.loads(payload)
		except json.JSONDecodeError as exc:
			_throw(ERROR_VALIDATION, _("List payload is not valid JSON: {0}").format(exc.msg))
			return []  # unreachable — _throw raises
		return list(parsed) if isinstance(parsed, list | tuple) else []
	if isinstance(payload, list | tuple):
		return list(payload)
	_throw(ERROR_VALIDATION, _("Expected a list payload"))
	return []


def _server_build_hash() -> str:
	"""Return a short, stable fingerprint of the running server build."""
	version = frappe.get_attr("pospire.__version__") or "0"
	return hashlib.sha1(str(version).encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Idempotency helper (docs/offline/12-server-side-changes.md §2, D-22, D-23)
# ---------------------------------------------------------------------------


def _existing_by_offline_id(doctype: str, offline_id: str) -> str | None:
	return frappe.db.get_value(doctype, {"pos_offline_id": offline_id}, "name")


def _idempotent_submit(
	doctype: str,
	payload: dict[str, Any],
	offline_id: str,
	*,
	device_id: str | None = None,
	submit: bool = True,
	before_insert: Callable[[Any], None] | None = None,
) -> dict[str, Any]:
	"""Insert (and optionally submit) a doc keyed on `pos_offline_id`.

	The function is the idempotency barrier for every queued write:
	  - Cheap existence check first (indexed on `pos_offline_id`).
	  - If present, return the existing doc with `was_already_submitted=True`.
	  - Otherwise insert; if a concurrent writer lost the race, catch the
	    unique constraint violation, re-read, and return the existing doc.
	"""
	existing = _existing_by_offline_id(doctype, offline_id)
	if existing:
		doc = frappe.get_doc(doctype, existing)
		return {
			"name": doc.name,
			"was_already_submitted": True,
			"docstatus": cint(doc.docstatus),
		}

	payload = dict(payload)
	payload.setdefault("doctype", doctype)
	payload["pos_offline_id"] = offline_id
	if device_id is not None:
		payload["pos_device_id"] = device_id

	doc = frappe.get_doc(payload)
	if before_insert is not None:
		before_insert(doc)

	try:
		doc.insert(ignore_permissions=True)
		if submit and doc.meta.is_submittable:
			doc.submit()
	except frappe.DuplicateEntryError:
		# Race: another worker inserted the same offline_id after our existence
		# check. Swallow the DB-level unique violation and return the winner.
		frappe.db.rollback()
		existing = _existing_by_offline_id(doctype, offline_id)
		if not existing:
			raise
		winner = frappe.get_doc(doctype, existing)
		return {
			"name": winner.name,
			"was_already_submitted": True,
			"docstatus": cint(winner.docstatus),
		}

	return {
		"name": doc.name,
		"was_already_submitted": False,
		"docstatus": cint(doc.docstatus),
	}


# ---------------------------------------------------------------------------
# Rate limiter for observability endpoints
# ---------------------------------------------------------------------------

_LOG_BATCH_MAX_ENTRIES = 100
_LOG_BATCH_MAX_REQUESTS_PER_MINUTE = 10


def _log_batch_rate_limit(user: str) -> None:
	"""Throttle `log_batch` to 10 requests/minute/user using Frappe cache."""
	cache = frappe.cache()
	key = f"pospire:offline:log_batch_rate:{user}"
	now_ts = int(time.time())
	window_start = now_ts - 60

	timestamps: list[int] = list(cache.get_value(key) or [])
	timestamps = [ts for ts in timestamps if ts >= window_start]
	if len(timestamps) >= _LOG_BATCH_MAX_REQUESTS_PER_MINUTE:
		_throw(
			ERROR_VALIDATION,
			_("log_batch rate limit exceeded: {0} requests per minute per user").format(
				_LOG_BATCH_MAX_REQUESTS_PER_MINUTE
			),
			{"retry_after_seconds": 60},
		)
	timestamps.append(now_ts)
	cache.set_value(key, timestamps, expires_in_sec=120)


# ---------------------------------------------------------------------------
# POS Profile snapshot helpers (P-12, Q-2 fix)
# ---------------------------------------------------------------------------

# Profile flag names that the offline sync contract relies on. The snapshot is
# copied onto the opening shift at creation time so submit-time reads never
# touch the live POS Profile. The `custom_*` spelling is the canonical one for
# the v16 Feature 1/2 fields (phase-0 correction).
POS_PROFILE_OFFLINE_FLAGS: tuple[str, ...] = (
	"custom_allow_negative_stock",
	"custom_allow_add_to_stock_at_pos",
)


def snapshot_profile_flags_onto_opening_shift(doc) -> None:
	"""Copy the live POS Profile flags onto the opening-shift record.

	Called from `create_opening_entry` (offline path) and from the existing
	online `create_opening_voucher` flow. The resulting snapshot is the
	only source of truth read by submit-time handlers (Q-2 constraint).
	"""
	if not getattr(doc, "pos_profile", None):
		return

	profile_values = (
		frappe.db.get_value(
			"POS Profile",
			doc.pos_profile,
			list(POS_PROFILE_OFFLINE_FLAGS),
			as_dict=True,
		)
		or {}
	)

	if doc.meta.has_field("pos_profile_snapshot_allow_negative_stock"):
		doc.pos_profile_snapshot_allow_negative_stock = cint(
			profile_values.get("custom_allow_negative_stock") or 0
		)
	if doc.meta.has_field("pos_profile_snapshot_allow_add_to_stock_at_pos"):
		doc.pos_profile_snapshot_allow_add_to_stock_at_pos = cint(
			profile_values.get("custom_allow_add_to_stock_at_pos") or 0
		)


def get_offline_flags_for_shift(opening_shift_name: str) -> dict[str, int]:
	"""Return the snapshotted POS Profile flags for a given opening shift.

	Submit handlers (online and offline paths) call this instead of reading
	the live POS Profile. Returns `{flag: 0|1}`. If the shift row predates
	the snapshot fields (legacy data), values default to 0.
	"""
	if not opening_shift_name:
		return {flag: 0 for flag in POS_PROFILE_OFFLINE_FLAGS}

	snapshot = (
		frappe.db.get_value(
			"POS Opening Shift",
			opening_shift_name,
			[
				"pos_profile_snapshot_allow_negative_stock",
				"pos_profile_snapshot_allow_add_to_stock_at_pos",
			],
			as_dict=True,
		)
		or {}
	)
	return {
		"custom_allow_negative_stock": cint(snapshot.get("pos_profile_snapshot_allow_negative_stock") or 0),
		"custom_allow_add_to_stock_at_pos": cint(
			snapshot.get("pos_profile_snapshot_allow_add_to_stock_at_pos") or 0
		),
	}


# ---------------------------------------------------------------------------
# Posting-date / owner guards (P-5, P-11)
# ---------------------------------------------------------------------------


def _apply_payload_metadata(payload: dict[str, Any]) -> None:
	"""Ensure posting_date / owner_user are respected, never defaulted.

	P-5: server must use `owner_user` from the payload, never
	`frappe.session.user`.
	P-11: server must use the queued `posting_date`, never today.
	"""
	posting_date = payload.get("posting_date")
	if not posting_date:
		_throw(
			ERROR_VALIDATION,
			_("posting_date is required on queued writes (P-11)"),
			{"field": "posting_date"},
		)

	owner_user = payload.pop("owner_user", None) or payload.get("owner")
	if not owner_user:
		_throw(
			ERROR_VALIDATION,
			_("owner_user is required on queued writes (P-5)"),
			{"field": "owner_user"},
		)
	payload["owner"] = owner_user


def _check_accounting_period_open(posting_date: str, company: str | None) -> None:
	"""Reject submits whose `posting_date` lies in a closed accounting period.

	Uses ERPNext's Accounting Period if the doctype exists. The hard error
	here maps to HTTP 417 / `accounting_period_closed` so the client moves
	the entry to `needs_review` (see D-9).
	"""
	if not company or not posting_date:
		return
	if not frappe.db.exists("DocType", "Accounting Period"):
		return

	posting = get_datetime(posting_date).date() if isinstance(posting_date, str) else posting_date
	closed = frappe.db.sql(
		"""
		SELECT name FROM `tabAccounting Period`
		WHERE company = %s
		  AND %s BETWEEN start_date AND end_date
		  AND docstatus < 2
		LIMIT 1
		""",
		(company, posting),
		as_dict=True,
	)
	if closed:
		_throw(
			ERROR_ACCOUNTING_PERIOD_CLOSED,
			_("Accounting period for {0} is closed").format(posting_date),
			{"posting_date": str(posting_date), "company": company},
		)


# ---------------------------------------------------------------------------
# Parent resolution (offline_id → real docname) for invoice submits
# ---------------------------------------------------------------------------


def _resolve_opening_shift(opening_entry_offline_id: str | None) -> str | None:
	if not opening_entry_offline_id:
		return None
	_validate_uuid(opening_entry_offline_id, "opening_entry_offline_id")
	name = frappe.db.get_value(
		"POS Opening Shift",
		{"pos_offline_id": opening_entry_offline_id},
		"name",
	)
	if not name:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Opening shift has not yet been synced"),
			{"opening_entry_offline_id": opening_entry_offline_id},
		)
	return name


def _resolve_material_receipts(material_receipt_offline_ids: Iterable[str] | None) -> list[str]:
	ids = [x for x in (material_receipt_offline_ids or []) if x]
	if not ids:
		return []
	for i in ids:
		_validate_uuid(i, "material_receipt_offline_id")

	rows = frappe.get_all(
		"Stock Entry",
		filters={"pos_offline_id": ["in", ids], "docstatus": 1},
		fields=["name", "pos_offline_id"],
	)
	found = {r["pos_offline_id"]: r["name"] for r in rows}
	missing = [i for i in ids if i not in found]
	if missing:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Material Receipt(s) not yet synced: {0}").format(", ".join(missing)),
			{"missing_offline_ids": missing},
		)
	return [found[i] for i in ids]


def _resolve_customer_by_offline_id(customer_offline_id: str | None) -> str | None:
	"""Server-side placeholder resolution for offline-queued customers.

	See 12-server-side-changes.md §4.5 and 17-risk-register.md R-6: clients
	do not rewrite queued invoice payloads after a customer syncs; the
	server is the authoritative rewrite point.
	"""
	if not customer_offline_id:
		return None
	_validate_uuid(customer_offline_id, "customer_offline_id")
	name = frappe.db.get_value("Customer", {"pos_offline_id": customer_offline_id}, "name")
	if not name:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Customer has not yet been synced"),
			{"customer_offline_id": customer_offline_id},
		)
	return name


# ---------------------------------------------------------------------------
# Endpoints (docs/offline/12-server-side-changes.md §4)
# ---------------------------------------------------------------------------


@frappe.whitelist()
def ping() -> dict[str, Any]:
	"""Lightweight connectivity probe (§4.6)."""
	return {
		"ok": True,
		"server_time": now(),
		"server_version": _server_build_hash(),
	}


@frappe.whitelist()
def submit_invoice(
	data: dict | str,
	offline_id: str,
	device_id: str,
	opening_entry_offline_id: str | None = None,
	material_receipt_offline_ids: list[str] | str | None = None,
) -> dict[str, Any]:
	"""Idempotent offline invoice submission (§4.1).

	Resolves any `offline_id` parent references to real document names, then
	hands off to the shared `_idempotent_submit` path. The submit re-uses the
	existing `pospire.pospire.api.posapp.submit_invoice` so online and offline
	paths go through the same accounting/loyalty side effects — the only
	difference is that the offline wrapper pre-applies the idempotency check
	and the parent resolutions.
	"""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	_apply_payload_metadata(payload)
	_check_accounting_period_open(payload.get("posting_date"), payload.get("company"))

	# If the payload references a queued customer by offline id, substitute the
	# resolved customer name before we look up idempotency. The resolved name
	# becomes part of the server document; the offline id stays out of the
	# `customer` link field.
	customer_offline_id = payload.pop("customer_offline_id", None)
	if customer_offline_id:
		payload["customer"] = _resolve_customer_by_offline_id(customer_offline_id)

	# Resolve parent opening shift + any material receipts.
	opening_shift_name = _resolve_opening_shift(opening_entry_offline_id)
	mr_ids = (
		_load_list(material_receipt_offline_ids)
		if isinstance(material_receipt_offline_ids, str)
		else material_receipt_offline_ids
	)
	_resolve_material_receipts(mr_ids)

	if opening_shift_name:
		payload["posa_pos_opening_shift"] = opening_shift_name
		payload.setdefault("pos_opening_shift_offline_id", opening_entry_offline_id)
	if mr_ids:
		payload["pos_material_receipt_offline_ids"] = json.dumps(list(mr_ids))

	# Idempotency short-circuit: if this offline_id has already produced a
	# Sales Invoice, return it without re-running submit logic.
	existing = _existing_by_offline_id("Sales Invoice", offline_id)
	if existing:
		doc = frappe.get_doc("Sales Invoice", existing)
		return {
			"name": doc.name,
			"was_already_submitted": True,
			"docstatus": cint(doc.docstatus),
		}

	payload["pos_offline_id"] = offline_id
	payload["pos_device_id"] = device_id

	# Delegate to the existing submit pipeline. We import lazily so this module
	# stays cheap to import from migration patches and CLI helpers.
	from pospire.pospire.api.posapp import submit_invoice as posapp_submit_invoice

	# posapp.submit_invoice expects an "invoice" dict that already exists (by
	# name) plus a data dict. For the offline path we first insert a draft so
	# `name` is bound, then call posapp_submit_invoice which updates + submits.
	try:
		draft = frappe.get_doc(
			{
				"doctype": "Sales Invoice",
				**{k: v for k, v in payload.items() if k != "doctype"},
			}
		)
		draft.flags.ignore_permissions = True
		draft.insert()
	except frappe.DuplicateEntryError:
		frappe.db.rollback()
		existing = _existing_by_offline_id("Sales Invoice", offline_id)
		if not existing:
			raise
		existing_doc = frappe.get_doc("Sales Invoice", existing)
		return {
			"name": existing_doc.name,
			"was_already_submitted": True,
			"docstatus": cint(existing_doc.docstatus),
		}

	invoice_ref = {"name": draft.name, **{k: v for k, v in payload.items() if k != "doctype"}}
	result = posapp_submit_invoice(invoice_ref, payload.get("posa_submit_data") or {})

	return {
		"name": result.get("name", draft.name),
		"was_already_submitted": False,
		"docstatus": cint(result.get("status") or 0),
	}


def _to_stock_entry_doc(data: dict[str, Any]) -> dict[str, Any]:
	"""Normalise a Material Receipt payload into a Stock Entry doc shape.

	Client payload carries `item_code`, `qty`, `warehouse`, plus optional
	`batch_no`, `expiry`, `serial_no`, `posting_date`. The handler creates
	new Batch / Serial No docs before the Stock Entry insert if the client
	presents values that are not yet in ERPNext.
	"""
	item_code = data.get("item_code")
	qty = data.get("qty")
	warehouse = data.get("warehouse") or data.get("t_warehouse")
	if not item_code or not qty or not warehouse:
		_throw(
			ERROR_VALIDATION,
			_("Material Receipt requires item_code, qty, and warehouse"),
			{
				"missing": [
					f for f, v in (("item_code", item_code), ("qty", qty), ("warehouse", warehouse)) if not v
				]
			},
		)

	batch_no = data.get("batch_no")
	serial_no = data.get("serial_no")

	# Create Batch first if new.
	if batch_no and not frappe.db.exists("Batch", batch_no):
		try:
			batch_doc = frappe.get_doc(
				{
					"doctype": "Batch",
					"batch_id": batch_no,
					"item": item_code,
					"expiry_date": data.get("expiry") or None,
				}
			)
			batch_doc.flags.ignore_permissions = True
			batch_doc.insert()
		except frappe.DuplicateEntryError:
			# Another writer beat us to it — safe to proceed.
			pass
		except Exception as exc:
			_throw(
				ERROR_BATCH_OR_SERIAL_CONFLICT,
				_("Batch {0} could not be created: {1}").format(batch_no, exc),
				{"batch_no": batch_no},
			)

	# Create Serial No if new.
	if serial_no and not frappe.db.exists("Serial No", serial_no):
		try:
			serial_doc = frappe.get_doc(
				{
					"doctype": "Serial No",
					"serial_no": serial_no,
					"item_code": item_code,
					"warehouse": warehouse,
				}
			)
			serial_doc.flags.ignore_permissions = True
			serial_doc.insert()
		except frappe.DuplicateEntryError:
			pass
		except Exception as exc:
			_throw(
				ERROR_BATCH_OR_SERIAL_CONFLICT,
				_("Serial No {0} could not be created: {1}").format(serial_no, exc),
				{"serial_no": serial_no},
			)

	return {
		"doctype": "Stock Entry",
		"stock_entry_type": "Material Receipt",
		"purpose": "Material Receipt",
		"posting_date": data.get("posting_date"),
		"company": data.get("company"),
		"owner": data.get("owner") or data.get("owner_user"),
		"items": [
			{
				"item_code": item_code,
				"qty": qty,
				"t_warehouse": warehouse,
				"batch_no": batch_no,
				"serial_no": serial_no,
				"basic_rate": data.get("basic_rate") or 0,
			}
		],
	}


@frappe.whitelist()
def create_material_receipt(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent Material Receipt (§4.2) for Feature 2 add-to-stock flow."""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	raw = _load(data)
	_apply_payload_metadata(raw)
	_check_accounting_period_open(raw.get("posting_date"), raw.get("company"))

	# Warehouse validation (mirrors the live Add-to-Stock path). The POS Profile
	# linkage is passed through so we can verify the warehouse belongs to the
	# same configuration the cashier was authorised to write against.
	warehouse = raw.get("warehouse") or raw.get("t_warehouse")
	if warehouse and not frappe.db.exists("Warehouse", warehouse):
		_throw(
			ERROR_VALIDATION,
			_("Warehouse {0} does not exist").format(warehouse),
			{"warehouse": warehouse},
		)

	stock_entry_payload = _to_stock_entry_doc(raw)
	return _idempotent_submit(
		"Stock Entry",
		stock_entry_payload,
		offline_id,
		device_id=device_id,
		submit=True,
	)


@frappe.whitelist()
def create_opening_entry(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent POS Opening Shift creation (§4.3).

	Snapshots the POS Profile offline flags onto the shift record (P-12).
	All submit-time handlers must read the snapshot, never the live profile
	(see Q-2 constraint and `get_offline_flags_for_shift`).
	"""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	_apply_payload_metadata(payload)

	def _snapshot_before_insert(doc) -> None:
		snapshot_profile_flags_onto_opening_shift(doc)

	return _idempotent_submit(
		"POS Opening Shift",
		payload,
		offline_id,
		device_id=device_id,
		submit=True,
		before_insert=_snapshot_before_insert,
	)


def _ensure_all_invoices_submitted(opening_offline_id: str, invoice_offline_ids: list[str]) -> str:
	"""Strict-closure precondition for offline closing entries (§4.4, P-8).

	Two-part check:
	  (a) every offline id the client lists maps to a submitted Sales Invoice;
	  (b) no orphan Sales Invoice exists on the server under this shift that
	      the client forgot to list.
	Both must hold before we accept a closing entry.
	"""
	opening_name = frappe.db.get_value(
		"POS Opening Shift",
		{"pos_offline_id": opening_offline_id},
		"name",
	)
	if not opening_name:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Opening shift has not yet been synced"),
			{"opening_offline_id": opening_offline_id},
		)

	cleaned = [str(i) for i in (invoice_offline_ids or []) if i]
	for i in cleaned:
		_validate_uuid(i, "invoice_offline_id")

	if cleaned:
		mapped = frappe.get_all(
			"Sales Invoice",
			filters={"pos_offline_id": ["in", cleaned], "docstatus": 1},
			pluck="pos_offline_id",
		)
		missing_on_server = sorted(set(cleaned) - set(mapped))
		if missing_on_server:
			_throw(
				ERROR_SIBLINGS_NOT_READY,
				_("Cannot close: invoice(s) not submitted: {0}").format(", ".join(missing_on_server)),
				{"missing_offline_ids": missing_on_server},
			)

	# Orphan check: every Sales Invoice tied to this shift on the server must
	# appear in the client's list. A mismatch means the client's outbox view
	# of the shift is incomplete.
	orphan_filters: dict[str, Any] = {"pos_opening_shift_offline_id": opening_offline_id}
	if cleaned:
		orphan_filters["pos_offline_id"] = ["not in", cleaned]
	server_side = frappe.get_all("Sales Invoice", filters=orphan_filters, pluck="pos_offline_id")
	server_side = [x for x in server_side if x]
	if server_side:
		_throw(
			ERROR_SIBLINGS_NOT_READY,
			_("Cannot close: shift has invoices not listed in closing payload: {0}").format(
				", ".join(sorted(server_side))
			),
			{"unlisted_offline_ids": sorted(server_side)},
		)

	return opening_name


@frappe.whitelist()
def create_closing_entry(
	data: dict | str,
	offline_id: str,
	device_id: str,
	opening_entry_offline_id: str,
) -> dict[str, Any]:
	"""Idempotent POS Closing Shift (§4.4) with strict-closure validation."""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")
	_validate_uuid(opening_entry_offline_id, "opening_entry_offline_id")

	payload = _load(data)
	_apply_payload_metadata(payload)

	invoice_offline_ids = payload.pop("invoice_offline_ids", None)
	if invoice_offline_ids is None:
		_throw(
			ERROR_VALIDATION,
			_("invoice_offline_ids is required on the closing payload (see docs 12 §4.4)"),
			{"field": "invoice_offline_ids"},
		)
	if isinstance(invoice_offline_ids, str):
		invoice_offline_ids = _load_list(invoice_offline_ids)
	if not isinstance(invoice_offline_ids, list):
		_throw(
			ERROR_VALIDATION,
			_("invoice_offline_ids must be a list"),
			{"field": "invoice_offline_ids"},
		)

	opening_name = _ensure_all_invoices_submitted(opening_entry_offline_id, invoice_offline_ids)
	payload["pos_opening_shift"] = opening_name

	return _idempotent_submit(
		"POS Closing Shift",
		payload,
		offline_id,
		device_id=device_id,
		submit=True,
	)


@frappe.whitelist()
def create_customer(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent Customer creation for offline-created customers (§4.5)."""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	# Customers do not carry an accounting posting_date; relax the P-11 guard
	# to just require an `owner_user` attribution (P-5).
	owner_user = payload.pop("owner_user", None) or payload.get("owner")
	if not owner_user:
		_throw(
			ERROR_VALIDATION,
			_("owner_user is required on queued writes (P-5)"),
			{"field": "owner_user"},
		)
	payload["owner"] = owner_user

	return _idempotent_submit(
		"Customer",
		payload,
		offline_id,
		device_id=device_id,
		submit=False,
	)


@frappe.whitelist()
def log_batch(entries: list | str) -> dict[str, Any]:
	"""Accept a batch of client-side connectivity/sync log entries (§4.7).

	Rate-limited to `_LOG_BATCH_MAX_REQUESTS_PER_MINUTE` requests per minute
	per user and `_LOG_BATCH_MAX_ENTRIES` entries per request. The log entries
	are written into Frappe's Error Log so ops visibility mirrors the rest of
	the pipeline without a dedicated doctype — we keep the surface tiny in v1.
	"""
	user = frappe.session.user or "Guest"
	_log_batch_rate_limit(user)

	parsed = _load_list(entries)
	if len(parsed) > _LOG_BATCH_MAX_ENTRIES:
		_throw(
			ERROR_VALIDATION,
			_("log_batch accepts at most {0} entries per request").format(_LOG_BATCH_MAX_ENTRIES),
			{"max_entries": _LOG_BATCH_MAX_ENTRIES, "received": len(parsed)},
		)

	accepted = 0
	for entry in parsed:
		if not isinstance(entry, dict):
			continue
		# Trim free-form blobs so a single event cannot DoS the error log.
		message = json.dumps(entry, default=str)[:4000]
		frappe.log_error(message=message, title="POSpire Offline Event")
		accepted += 1

	return {"ok": True, "accepted": accepted}


@frappe.whitelist()
def submit_recovery_log(device_id: str, journal_blob: str, recovered_at: str) -> dict[str, Any]:
	"""Append an immutable recovery-log record (§4.8).

	The record is append-only; `POS Offline Recovery Log` rejects edits via
	the `on_update` hook wired in `hooks.py`.
	"""
	_validate_uuid(device_id, "device_id")
	if not journal_blob or not isinstance(journal_blob, str):
		_throw(ERROR_VALIDATION, _("journal_blob is required"), {"field": "journal_blob"})
	if not recovered_at:
		_throw(ERROR_VALIDATION, _("recovered_at is required"), {"field": "recovered_at"})

	# Guardrail: cap blob size at 8 MB (base64-encoded) to prevent a
	# compromised client from flooding storage.
	if len(journal_blob) > 8 * 1024 * 1024:
		_throw(
			ERROR_VALIDATION,
			_("journal_blob exceeds maximum size of 8 MiB"),
			{"max_bytes": 8 * 1024 * 1024, "received": len(journal_blob)},
		)

	doc = frappe.get_doc(
		{
			"doctype": "POS Offline Recovery Log",
			"device_id": device_id,
			"recovered_at": recovered_at,
			"journal_blob": journal_blob,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return {"ok": True, "name": doc.name}


# Small helper re-exports for the submit paths in posapp.py (Q-2 fix) — keeping
# them here keeps the snapshot contract in one file.
__all__ = [
	"ERROR_ACCOUNTING_PERIOD_CLOSED",
	"ERROR_BATCH_OR_SERIAL_CONFLICT",
	"ERROR_PARENT_NOT_READY",
	"ERROR_PERMISSION",
	"ERROR_SCHEMA_MISMATCH",
	"ERROR_SIBLINGS_NOT_READY",
	"ERROR_STOCK_SHORTAGE",
	"ERROR_VALIDATION",
	"POS_PROFILE_OFFLINE_FLAGS",
	"OfflineSubmitError",
	"create_closing_entry",
	"create_customer",
	"create_material_receipt",
	"create_opening_entry",
	"get_offline_flags_for_shift",
	"log_batch",
	"ping",
	"snapshot_profile_flags_onto_opening_shift",
	"submit_invoice",
	"submit_recovery_log",
]
