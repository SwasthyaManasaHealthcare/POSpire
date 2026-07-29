"""Desk boot customizations for POSpire."""

import frappe
from frappe.desk.desk_page import getpage

HIDDEN_AWESOME_BAR_DOCTYPES = frozenset(
	{
		"POS Invoice",
		"POS Opening Entry",
		"POS Closing Entry",
		"POS Invoice Merge Log",
		"POS Settings",
	}
)

HIDDEN_CORE_POS_PAGES = frozenset(
	{
		"point-of-sale",
	}
)

AWESOME_BAR_DOCTYPE_KEYS = (
	"can_read",
	"can_search",
	"can_create",
)


def filter_core_pos_doctypes_from_bootinfo(bootinfo):
	"""Hide ERPNext Core POS DocTypes from Desk discovery data."""
	page_info = bootinfo.get("page_info") if hasattr(bootinfo, "get") else None
	if isinstance(page_info, dict):
		for page in HIDDEN_CORE_POS_PAGES:
			page_info.pop(page, None)

	user = bootinfo.get("user") if hasattr(bootinfo, "get") else None
	if not user:
		return

	for key in AWESOME_BAR_DOCTYPE_KEYS:
		values = user.get(key) if hasattr(user, "get") else None
		if not isinstance(values, list):
			continue

		user[key] = [value for value in values if value not in HIDDEN_AWESOME_BAR_DOCTYPES]


@frappe.whitelist(allow_guest=True)
def block_core_pos_page_access(name):
	if name in HIDDEN_CORE_POS_PAGES:
		frappe.throw(frappe._("Page {0} not found").format(name), frappe.DoesNotExistError)

	return getpage(name)
