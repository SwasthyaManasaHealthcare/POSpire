
from json import loads

import frappe

# Import the ORIGINAL implementation
from frappe.desk.desktop import get_desktop_page as original_get_desktop_page

CORE_POS_LINKS = {
    "POS",
    "POS Profile",
    "POS Invoice",
    "POS Opening Entry",
    "POS Closing Entry",
    "POS Invoice Merge Log",
    "POS Settings",
}


def _filter_items(items):
    """Remove Core POS links from a list of workspace items."""

    if not items:
        return items

    return [
        item
        for item in items
        if item.get("label") not in CORE_POS_LINKS
    ]


def _filter_workspace_response(response):
    """Remove Core POS links from workspace response."""

    if not response:
        return response


    cards = response.get("cards")

    if cards and cards.get("items"):

        for card in cards["items"]:

            if card.get("links"):

                card["links"] = _filter_items(card["links"])


    shortcuts = response.get("shortcuts")

    if shortcuts:

        shortcuts["items"] = _filter_items(
            shortcuts.get("items", [])
        )


    quick_lists = response.get("quick_lists")

    if quick_lists:

        quick_lists["items"] = _filter_items(
            quick_lists.get("items", [])
        )

    return response


@frappe.whitelist()
@frappe.read_only()
def get_desktop_page(page):
    """
    Wrapper around ERPNext get_desktop_page().
    """
    workspace = loads(page)
    response = original_get_desktop_page(page)
    if workspace.get("name") != "Selling":
        return response

    return _filter_workspace_response(response)
