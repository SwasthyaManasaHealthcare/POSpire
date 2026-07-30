import frappe
from frappe.desk.desktop import get_desktop_page as original_get_desktop_page

from pospire.pos_core import is_core_pos


def _filter_items(items):
	"""
	Remove ERPNext Core POS links from a list of workspace items.
	"""

	items = items or []

	return [item for item in items if not is_core_pos(item)]


def _filter_workspace_response(response):
	"""
	Remove ERPNext Core POS links from workspace response.
	"""

	if not response:
		return response

	#
	# Cards
	#
	cards = response.get("cards")

	if cards:
		filtered_cards = []

		for card in cards.get("items") or []:
			card["links"] = _filter_items(card.get("links"))

			# Drop cards that become empty after filtering.
			# This avoids empty "Point of Sale" cards.
			if card.get("links"):
				filtered_cards.append(card)

		cards["items"] = filtered_cards

		# KNOWN, ACCEPTED SIDE EFFECT:
		# ERPNext's "Point of Sale" card in the Selling workspace groups
		# POS Profile and Loyalty Program / Loyalty Point Entry alongside
		# POS Settings / POS Opening Entry / POS Closing Entry. Filtering
		# removes the latter three (Core POS) but leaves POS Profile and
		# the two Loyalty links behind, under a "Point of Sale" heading
		# that no longer fully matches its contents.
		#
		# We deliberately don't touch this further:
		#   - POS Profile must stay reachable; POSpire uses it directly
		#     (see doctype_js hook in hooks.py).
		#   - Loyalty Program / Loyalty Point Entry aren't Core POS and
		#     have no reason to be hidden.
		#   - Relabelling the card here wouldn't work either: the
		#     workspace's layout (the Workspace doc's `content` blocks)
		#     references this card by its original label
		#     ("Point of Sale"). Renaming only the label in this filtered
		#     response would break that match and the card would silently
		#     fail to render, leaving a blank slot instead of a relabelled
		#     one. Fixing that would require also rewriting the Workspace
		#     doc's `content` field, which is a data-level customization
		#     of an ERPNext-owned record, out of scope for this filter.
		#
		# The remaining links are all valid and working; only the heading
		# is imprecise.

	#
	# Shortcuts
	#
	shortcuts = response.get("shortcuts")

	if shortcuts:
		shortcuts["items"] = _filter_items(shortcuts.get("items") or [])

	#
	# Quick Lists
	#
	quick_lists = response.get("quick_lists")

	if quick_lists:
		quick_lists["items"] = _filter_items(quick_lists.get("items") or [])

	return response


@frappe.whitelist()
@frappe.read_only()
def get_desktop_page(page: str):
	"""
	Wrapper around ERPNext get_desktop_page().

	Only filters the Selling workspace.
	"""

	try:
		workspace = frappe.parse_json(page)
	except Exception:
		# Preserve original behaviour if page payload is invalid.
		return original_get_desktop_page(page)

	response = original_get_desktop_page(page)

	if workspace.get("name") != "Selling":
		return response

	return _filter_workspace_response(response)
