from unittest.mock import call, patch

from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api import posapp


class TestItemGroupCondition(FrappeTestCase):
	@patch.object(posapp, "get_item_groups", return_value=["Drugs", "Children's Medicines"])
	@patch.object(posapp.frappe.db, "escape", side_effect=lambda value: f"escaped({value})")
	def test_plain_item_group_names_are_escaped_before_sql_interpolation(self, escape, _get_item_groups):
		condition = posapp.get_item_group_condition("Pharmacy POS")

		self.assertEqual(
			condition,
			" and item_group in (escaped(Drugs), escaped(Children's Medicines))",
		)
		escape.assert_has_calls([call("Drugs"), call("Children's Medicines")])

	@patch.object(posapp, "get_item_groups", return_value=[])
	def test_profile_without_item_groups_does_not_restrict_catalog(self, _get_item_groups):
		self.assertEqual(posapp.get_item_group_condition("All Items POS"), " and 1=1")
