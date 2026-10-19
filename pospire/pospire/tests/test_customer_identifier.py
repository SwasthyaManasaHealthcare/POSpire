# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import uuid
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api import customer as customer_api
from pospire.pospire.api.customer import DuplicateCustomerIdentifier, get_identifier_key
from pospire.pospire.api.offline import (
	_existing_by_offline_id,
	_resolve_customer_by_offline_id,
	create_customer,
)
from pospire.pospire.api.posapp import create_customer as pos_create_customer
from pospire.pospire.api.posapp import get_customer_group_condition, set_customer_info


def _territory():
	return frappe.db.get_value("Territory", {"is_group": 0}, "name")


def _customer(name, **fields):
	return frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": name,
			"customer_group": "Individual",
			"territory": _territory(),
			**fields,
		}
	).insert(ignore_permissions=True)


def _use_identifier(value):
	frappe.db.set_single_value("Selling Settings", "posa_customer_identifier", value)


class TestCustomerIdentifier(FrappeTestCase):
	def setUp(self):
		region = patch.object(customer_api, "_default_region", return_value="IN")
		region.start()
		self.addCleanup(region.stop)
		# FrappeTestCase rolls back per class; these tests reuse mobile numbers, so roll back per test.
		self.addCleanup(frappe.db.rollback)

	def test_key_normalisation(self):
		for raw in ("098450 12345", "+91 98450 12345", "9845012345"):
			self.assertEqual(get_identifier_key(raw, "Mobile No"), "+919845012345")
		with patch.object(customer_api, "_default_region", return_value=None):
			# No country to parse against: fall back to digits only.
			self.assertEqual(get_identifier_key("98450 12345", "Mobile No"), "9845012345")
		self.assertEqual(get_identifier_key(" Ravi@Example.com ", "Email"), "ravi@example.com")
		self.assertEqual(get_identifier_key("RAVI  Kumar ", "Customer Name"), "ravi kumar")
		self.assertIsNone(get_identifier_key("", "Mobile No"))
		self.assertIsNone(get_identifier_key("9845012345", None))

	def test_duplicate_mobile_rejected_names_may_repeat(self):
		_use_identifier("Mobile No")
		first = _customer("_Test Ident Ravi", mobile_no="98450 12345")
		self.assertEqual(first.posa_identifier_key, "+919845012345")
		with self.assertRaises(DuplicateCustomerIdentifier):
			_customer("_Test Ident Other", mobile_no="+91 9845012345")
		_customer("_Test Ident Ravi", mobile_no="9845012346")  # same name, different mobile

	def test_duplicate_of_disabled_customer_says_so(self):
		_use_identifier("Mobile No")
		holder = _customer("_Test Ident Disabled", mobile_no="9845012377")
		frappe.db.set_value("Customer", holder.name, "disabled", 1)
		with self.assertRaisesRegex(DuplicateCustomerIdentifier, "disabled"):
			_customer("_Test Ident New", mobile_no="9845012377")

	def test_pos_update_keeps_referral_code_and_other_phones(self):
		_use_identifier("Mobile No")
		cust = _customer("_Test Ident Edit", mobile_no="9845012355")
		frappe.db.set_value("Customer", cust.name, "posa_referral_code", "REF-KEEP")
		contact = frappe.get_doc(
			"Contact", frappe.db.get_value("Customer", cust.name, "customer_primary_contact")
		)
		contact.add_phone("080 4000 1234")
		contact.save(ignore_permissions=True)

		profile = {"name": None, "company": frappe.defaults.get_global_default("company")}
		with patch.object(customer_api, "validate_referral_code"):
			pos_create_customer(
				customer_id=cust.name,
				customer_name=cust.customer_name,
				company=profile["company"],
				pos_profile_doc=profile,
				mobile_no="9845012366",
				email_id="",  # the POS form sends blanks as empty strings
				customer_group="Individual",
				customer_type="Individual",  # the POS form always sends it
				method="update",
			)

		self.assertEqual(frappe.db.get_value("Customer", cust.name, "posa_referral_code"), "REF-KEEP")
		phones = [p.phone for p in frappe.get_doc("Contact", contact.name).phone_nos]
		self.assertIn("080 4000 1234", phones)
		self.assertIn("9845012366", phones)
		self.assertEqual(frappe.db.get_value("Customer", cust.name, "posa_identifier_key"), "+919845012366")

	def test_customers_without_identifier_never_collide(self):
		_use_identifier("Mobile No")
		self.assertIsNone(_customer("_Test Ident NoMobile A").posa_identifier_key)
		self.assertIsNone(_customer("_Test Ident NoMobile B").posa_identifier_key)

	def test_blank_setting_keeps_old_behaviour(self):
		_use_identifier("")
		_customer("_Test Ident Free", mobile_no="9845012345")
		dup = _customer("_Test Ident Free 2", mobile_no="9845012345")
		self.assertIsNone(dup.posa_identifier_key)

	def test_mobile_change_through_contact_updates_key_and_checks_duplicates(self):
		_use_identifier("Mobile No")
		taken = _customer("_Test Ident Taken", mobile_no="9845012345")
		other = _customer("_Test Ident Mover", mobile_no="9845012399")
		set_customer_info(other.name, "mobile_no", "9845012388")
		self.assertEqual(frappe.db.get_value("Customer", other.name, "posa_identifier_key"), "+919845012388")
		with self.assertRaises(DuplicateCustomerIdentifier):
			set_customer_info(other.name, "mobile_no", taken.mobile_no)

	def test_setting_change_refused_on_clash_and_rebuilds_keys(self):
		_use_identifier("")
		a = _customer("_Test Ident Clash", email_id="clash@example.com")
		_customer("_Test Ident Clash 2", email_id="CLASH@example.com ")
		settings = frappe.get_doc("Selling Settings")
		settings.posa_customer_identifier = "Email"
		with self.assertRaises(frappe.ValidationError):
			settings.save()

		frappe.db.set_value("Customer", a.name, "email_id", "unique@example.com")
		settings = frappe.get_doc("Selling Settings")
		settings.posa_customer_identifier = "Email"
		settings.save()
		self.assertEqual(frappe.db.get_value("Customer", a.name, "posa_identifier_key"), "unique@example.com")

	def test_disabled_customers_excluded_with_profile_groups(self):
		cond = get_customer_group_condition({"customer_groups": [{"customer_group": "Individual"}]})
		self.assertIn("disabled = 0", cond)
		self.assertIn("customer_group in", cond)


class TestOfflineCustomerMatch(FrappeTestCase):
	def setUp(self):
		region = patch.object(customer_api, "_default_region", return_value="IN")
		region.start()
		self.addCleanup(region.stop)
		# FrappeTestCase rolls back per class; these tests reuse mobile numbers, so roll back per test.
		self.addCleanup(frappe.db.rollback)
		_use_identifier("Mobile No")
		self.existing = _customer("_Test Ident Existing", mobile_no="9845012345")

	def _sync(self, mobile, offline_id=None):
		offline_id = offline_id or str(uuid.uuid4())
		data = {
			"doctype": "Customer",
			"customer_name": "Typed Offline",
			"customer_group": "Individual",
			"territory": _territory(),
			"mobile_no": mobile,
			"owner_user": "Administrator",
		}
		return offline_id, create_customer(data, offline_id, str(uuid.uuid4()))

	def test_maps_to_existing_and_queued_invoice_resolves(self):
		offline_id, result = self._sync("+91 98450 12345")
		self.assertEqual(result["name"], self.existing.name)
		self.assertTrue(result["matched_existing"])
		self.assertEqual(_existing_by_offline_id("Customer", offline_id), self.existing.name)
		# What a queued invoice uses to find its customer.
		self.assertEqual(_resolve_customer_by_offline_id(offline_id), self.existing.name)
		# Replay of the same queued create returns the same customer.
		_, again = self._sync("+91 98450 12345", offline_id=offline_id)
		self.assertEqual(again["name"], self.existing.name)

	def test_new_mobile_creates_customer(self):
		_, result = self._sync("9845012300")
		self.assertNotEqual(result["name"], self.existing.name)
		self.assertEqual(
			frappe.db.get_value("Customer", result["name"], "posa_identifier_key"), "+919845012300"
		)

	def test_concurrent_create_maps_to_winner(self):
		# First lookup misses (the other till has not committed yet), the insert then hits the duplicate.
		with (
			patch(
				"pospire.pospire.api.offline.find_customer_by_identifier",
				side_effect=[None, self.existing.name],
			),
			patch.object(frappe.db, "rollback"),
		):
			_, result = self._sync("9845012345")
		self.assertEqual(result["name"], self.existing.name)


class TestSearchCustomers(FrappeTestCase):
	def setUp(self):
		region = patch.object(customer_api, "_default_region", return_value="IN")
		region.start()
		self.addCleanup(region.stop)
		self.addCleanup(frappe.db.rollback)
		_use_identifier("Mobile No")
		self.inside = _customer(
			"_Test Search Rajit Kadimi", mobile_no="98450 81818", email_id="rk@example.com"
		)
		self.outside = _customer("_Test Search Outside", mobile_no="9845082828", customer_group="Commercial")
		# Profile allows only "Individual".
		groups = patch.object(customer_api, "get_allowed_customer_groups", return_value=["Individual"])
		groups.start()
		self.addCleanup(groups.stop)

	def _names(self, query):
		return [row.name for row in customer_api.search_customers("any profile", query)]

	def test_name_words_in_any_order(self):
		self.assertIn(self.inside.name, self._names("kadimi rajit"))

	def test_partial_mobile_and_email(self):
		self.assertIn(self.inside.name, self._names("81818"))
		self.assertIn(self.inside.name, self._names("RK@EXAMPLE"))

	def test_partial_match_stays_in_profile_groups(self):
		self.assertNotIn(self.outside.name, self._names("_Test Search Outside"))
		self.assertNotIn(self.outside.name, self._names("82828"))

	def test_exact_identifier_found_in_any_group(self):
		self.assertEqual(self._names("+91 98450 82828"), [self.outside.name])

	def test_disabled_and_short_queries_excluded(self):
		frappe.db.set_value("Customer", self.inside.name, "disabled", 1)
		self.assertNotIn(self.inside.name, self._names("kadimi"))
		self.assertEqual(self._names("ka"), [])
