# Copyright (c) 2021, Youssef Restom and contributors
# For license information, please see license.txt


import re

import frappe
import phonenumbers
from frappe import _
from frappe.utils.caching import request_cache

from pospire.pospire.doctype.referral_code.referral_code import (
	create_referral_code,
)


def after_insert(doc, method):
	create_customer_referral_code(doc)
	create_gift_coupon(doc)


def validate(doc, method):
	validate_referral_code(doc)
	set_identifier_key(doc)


def create_customer_referral_code(doc):
	if doc.posa_referral_company:
		company = frappe.get_cached_doc("Company", doc.posa_referral_company)
		if not company.posa_auto_referral:
			return
		create_referral_code(
			doc.posa_referral_company,
			doc.name,
			company.posa_customer_offer,
			company.posa_primary_offer,
			company.posa_referral_campaign,
		)


def create_gift_coupon(doc):
	if doc.posa_referral_code:
		coupon = frappe.new_doc("POS Coupon")
		coupon.customer = doc.name
		coupon.referral_code = doc.posa_referral_code
		coupon.create_coupon_from_referral()


def validate_referral_code(doc):
	referral_code = doc.posa_referral_code
	exist = None
	if referral_code:
		exist = frappe.db.exists("Referral Code", referral_code)
		if not exist:
			exist = frappe.db.exists("Referral Code", {"referral_code": referral_code})
		if not exist:
			frappe.throw(_("This Referral Code {0} not exists").format(referral_code))


# Selling Settings "Customer Identifier" option -> Customer field it reads.
IDENTIFIER_FIELDS = {"Mobile No": "mobile_no", "Email": "email_id", "Customer Name": "customer_name"}


class DuplicateCustomerIdentifier(frappe.UniqueValidationError):
	pass


def get_identifier() -> str | None:
	return frappe.db.get_single_value("Selling Settings", "posa_customer_identifier") or None


@request_cache
def _default_region() -> str | None:
	country = frappe.db.get_single_value("System Settings", "country")
	code = country and frappe.db.get_value("Country", country, "code")
	return code.upper() if code else None


def get_identifier_key(value: str | None, identifier: str | None) -> str | None:
	"""Normalised form of a customer's identifier, so formatting variants compare equal."""
	value = (value or "").strip()
	if not value or not identifier:
		return None
	if identifier == "Mobile No":
		try:
			number = phonenumbers.parse(value, _default_region())
			return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)
		except phonenumbers.NumberParseException:
			return re.sub(r"\D", "", value) or None
	if identifier == "Email":
		return value.lower()
	return " ".join(value.lower().split())


def set_identifier_key(doc) -> None:
	identifier = get_identifier()
	value = doc.get(IDENTIFIER_FIELDS[identifier]) if identifier else None
	doc.posa_identifier_key = get_identifier_key(value, identifier)
	if not doc.posa_identifier_key:
		return
	existing = frappe.db.get_value(
		"Customer", {"posa_identifier_key": doc.posa_identifier_key, "name": ["!=", doc.name]}, "name"
	)
	if existing:
		frappe.throw(
			_("{0} {1} is already used by customer {2}.").format(_(identifier), value, existing),
			DuplicateCustomerIdentifier,
		)


def find_customer_by_identifier(value: str | None) -> str | None:
	identifier = get_identifier()
	key = get_identifier_key(value, identifier)
	return key and frappe.db.get_value("Customer", {"posa_identifier_key": key}, "name")


def on_selling_settings_update(doc, method) -> None:
	"""Rebuild every Customer's key when the identifier changes; refuse if the new field has duplicates."""
	if not doc.has_value_changed("posa_customer_identifier"):
		return
	identifier = doc.posa_customer_identifier
	field = IDENTIFIER_FIELDS.get(identifier)
	keys = {}
	if field:
		# shortcut: runs in the request; move to a background job for sites far beyond tens of thousands of customers.
		for row in frappe.get_all("Customer", fields=["name", field]):
			keys[row.name] = get_identifier_key(row.get(field), identifier)

	seen, clashes = {}, []
	for name, key in keys.items():
		if not key:
			continue
		if key in seen:
			clashes.append(f"{seen[key]} / {name}")
		else:
			seen[key] = name
	if clashes:
		frappe.throw(
			_("Cannot use {0} as the customer identifier. These customers share the same value: {1}").format(
				_(identifier),
				", ".join(clashes[:20]) + (f" (+{len(clashes) - 20})" if len(clashes) > 20 else ""),
			)
		)

	# Clear first so a new key can never collide with a stale key from the previous identifier.
	frappe.db.sql("UPDATE `tabCustomer` SET posa_identifier_key = NULL")
	for name, key in keys.items():
		if key:
			frappe.db.set_value("Customer", name, "posa_identifier_key", key, update_modified=False)


def sync_customer_from_contact(doc, method) -> None:
	"""Customer.mobile_no / email_id copy the primary Contact; re-save on change so the key follows."""
	for name in frappe.get_all("Customer", filters={"customer_primary_contact": doc.name}, pluck="name"):
		customer = frappe.get_doc("Customer", name)
		if (customer.mobile_no or "", customer.email_id or "") == (doc.mobile_no or "", doc.email_id or ""):
			continue
		customer.mobile_no, customer.email_id = doc.mobile_no, doc.email_id
		customer.save(ignore_permissions=True)


def get_allowed_customer_groups(pos_profile: str | None) -> list[str]:
	"""Leaf customer groups under the POS Profile's customer group list (empty = no restriction)."""
	if not pos_profile:
		return []
	roots = frappe.get_all(
		"POS Customer Group",
		filters={"parent": pos_profile, "parenttype": "POS Profile"},
		pluck="customer_group",
	)
	names = set()
	for root in roots:
		bounds = frappe.db.get_value("Customer Group", root, ["lft", "rgt"])
		if not bounds:
			continue
		lft, rgt = bounds
		names.update(
			frappe.get_all(
				"Customer Group",
				filters={"lft": [">=", lft], "rgt": ["<=", rgt], "is_group": 0},
				pluck="name",
			)
		)
	return sorted(names)


def get_default_customer_group(pos_profile: str | None) -> str | None:
	allowed = get_allowed_customer_groups(pos_profile)
	default = frappe.db.get_single_value("Selling Settings", "customer_group")
	if allowed:
		return default if default in allowed else allowed[0]
	if default and not frappe.db.get_value("Customer Group", default, "is_group"):
		return default
	return None


@frappe.whitelist()
def search_customers(pos_profile: str, query: str) -> list[dict]:
	"""Server fallback for the POS picker when the customers loaded on the till have no match.

	Partial matches (every word of the name, email, or mobile digits) stay within the profile's
	customer groups. An exact Customer Identifier match is returned from any group: it proves
	the cashier has the right customer.
	"""
	frappe.has_permission("Customer", "read", throw=True)
	query = (query or "").strip()
	if len(query) < 3:
		return []

	fields = ["name", "customer_name", "mobile_no", "email_id", "tax_id", "primary_address"]
	exact = find_customer_by_identifier(query)
	rows = frappe.get_all("Customer", filters={"name": exact, "disabled": 0}, fields=fields) if exact else []

	conditions, values = ["disabled = 0"], []
	groups = get_allowed_customer_groups(pos_profile)
	if groups:
		conditions.append("customer_group IN ({})".format(", ".join(["%s"] * len(groups))))
		values += groups
	words = query.lower().split()
	matches = [" AND ".join(["LOWER(customer_name) LIKE %s"] * len(words)), "LOWER(email_id) LIKE %s"]
	values += [f"%{w}%" for w in words] + [f"%{query.lower()}%"]
	digits = re.sub(r"\D", "", query)
	if len(digits) >= 3:
		matches.append("REGEXP_REPLACE(IFNULL(mobile_no, ''), '[^0-9]', '') LIKE %s")
		values.append(f"%{digits}%")
	conditions.append("({})".format(" OR ".join(f"({m})" for m in matches)))

	columns, where = ", ".join(fields), " AND ".join(conditions)
	# Only fixed column names and %s placeholders are interpolated; values go through `values`.
	# nosemgrep: frappe-semgrep-rules.rules.security.frappe-sql-format-injection
	sql = f"SELECT {columns} FROM `tabCustomer` WHERE {where} ORDER BY customer_name LIMIT 20"
	seen = {row.name for row in rows}
	rows += [row for row in frappe.db.sql(sql, values, as_dict=True) if row.name not in seen]
	return rows
