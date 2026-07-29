
import frappe
from frappe import _
from frappe.desk import desk_page


CORE_POS_DOCTYPES = {
    "POS Invoice",
    "POS Opening Entry",
    "POS Closing Entry",
    "POS Invoice Merge Log",
    "POS Settings",
}

CORE_POS_SIDEBAR_ITEMS = {
    "POS",
    "POS Profile",
    "POS Invoice",
    "POS Opening Entry",
    "POS Closing Entry",
    "POS Invoice Merge Log",
    "POS Settings",
}

BLOCKED_PAGES = {
    "point-of-sale",
}


def _filter_doctypes(doctypes):
    """
    Remove Core POS DocTypes from bootinfo lists.
    """

    if not doctypes:
        return []

    return [
        doctype
        for doctype in doctypes
        if doctype not in CORE_POS_DOCTYPES
    ]


def _filter_workspace_sidebar(workspace_sidebar):
    """
    Remove Core POS items from Workspace Sidebar.
    """

    if not workspace_sidebar:
        return workspace_sidebar

    for workspace_name, workspace in workspace_sidebar.items():

        items = workspace.get("items", [])

        workspace["items"] = [
            item
            for item in items
            if item.get("label") not in CORE_POS_SIDEBAR_ITEMS
        ]

    return workspace_sidebar


def extend_bootinfo(bootinfo):
    """
    Layer 1
        - Hide Core POS DocTypes from:
            * Awesome Bar
            * Search
            * New

    Layer 2
        - Hide Core POS entries from Workspace Sidebar
    """

    user = bootinfo.get("user")

    if user:

        user["can_read"] = _filter_doctypes(
            user.get("can_read")
        )

        user["can_search"] = _filter_doctypes(
            user.get("can_search")
        )

        user["can_create"] = _filter_doctypes(
            user.get("can_create")
        )

    sidebar = bootinfo.get("workspace_sidebar_item")

    if sidebar:

        bootinfo["workspace_sidebar_item"] = _filter_workspace_sidebar(
            sidebar
        )

@frappe.whitelist(allow_guest=True)
def getpage(name: str):
    """
    Prevent users from opening ERPNext Core POS page.
    """

    if name in BLOCKED_PAGES:

        frappe.throw(
            _("The ERPNext Point of Sale page has been disabled. Please use POSpire."),
            frappe.PermissionError,
        )

    # Delegate to original implementation
    doc = desk_page.get(name)
    frappe.response.docs.append(doc)
    