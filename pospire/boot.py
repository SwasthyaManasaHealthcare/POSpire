import frappe
from frappe import _
from frappe.desk import desk_page

from pospire.pos_core import CORE_POS_DOCTYPES, is_core_pos

CORE_POS_DOCTYPES_LIST = sorted(CORE_POS_DOCTYPES)

BLOCKED_PAGES = {
	"point-of-sale",
}


def _filter_doctypes(doctypes):
	"""
	Remove ERPNext Core POS DocTypes from bootinfo lists.
	"""

	doctypes = doctypes or []

	return [doctype for doctype in doctypes if doctype not in CORE_POS_DOCTYPES]


def _filter_workspace_sidebar(workspace_sidebar):
	"""
	Remove ERPNext Core POS items from the Workspace Sidebar.

	Matches on link_type/link_to instead of label because labels
	are translated before extend_bootinfo() is executed.
	"""

	if not workspace_sidebar:
		return workspace_sidebar

	for workspace in workspace_sidebar.values():
		items = workspace.get("items") or []

		workspace["items"] = [item for item in items if not is_core_pos(item)]

	return workspace_sidebar


def extend_bootinfo(bootinfo):
	"""
	Layer 1
	    Hide ERPNext Core POS DocTypes from:
	        * Awesome Bar
	        * Search
	        * New

	Layer 2
	    Hide ERPNext Core POS entries from the Workspace Sidebar.
	"""

	user = bootinfo.get("user")

	if user:
		# NOTE:
		# Do not filter can_read.
		# It is consumed by the desk router and other framework internals.
		user["can_search"] = _filter_doctypes(user.get("can_search"))
		user["can_create"] = _filter_doctypes(user.get("can_create"))

	# Single DocTypes (e.g. POS Settings) bypass can_search entirely in the
	# Awesome Bar: frappe's search_utils.get_doctypes() matches Single
	# DocTypes against bootinfo.single_types instead, based only on can_read.
	bootinfo["single_types"] = _filter_doctypes(bootinfo.get("single_types"))

	sidebar = bootinfo.get("workspace_sidebar_item")

	if sidebar:
		bootinfo["workspace_sidebar_item"] = _filter_workspace_sidebar(sidebar)


# `getpage` must remain guest-callable because it overrides the guest-accessible
# desk page entry point; it only blocks the POS page and delegates all other
# page handling to the ERPNext implementation.
@frappe.whitelist(allow_guest=True)  # nosemgrep: frappe-semgrep-rules.rules.security.guest-whitelisted-method
def getpage(name: str):
	"""
	Block access to the ERPNext Core Point of Sale page.

	All other desk pages continue to use the standard behaviour.
	"""

	if name in BLOCKED_PAGES:
		frappe.throw(
			_("The ERPNext Point of Sale page has been disabled. Please use POSpire."),
			frappe.PermissionError,
		)

	# Delegate to the original implementation.
	doc = desk_page.get(name)
	frappe.response.docs.append(doc)
