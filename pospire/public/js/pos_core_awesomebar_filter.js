// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// Awesome Bar's frappe.search.utils.get_doctypes() (search_utils.js) branches
// on doctype kind: Singles are shown if they're in can_read + single_types,
// everything else is shown if it's in can_search. pospire's boot.py filters
// Core POS DocTypes out of can_search, but deliberately leaves can_read and
// single_types untouched (the desk router and other framework internals
// depend on them). That leaves Core POS Singles — e.g. POS Settings —
// visible in the Awesome Bar through the can_read + single_types branch.
//
// Rather than touch those shared bootinfo lists, wrap get_doctypes() itself
// and drop Core POS results from its output.
//
// get_pages() has the same shape of problem: it builds "Open <Page>" entries
// straight from frappe.boot.page_info, which is populated purely from the
// Page doctype's role table — unrelated to boot.py's getpage() override that
// blocks navigation. So Core POS pages (e.g. "point-of-sale") still surface
// in search even though opening them is already blocked server-side.
frappe.provide("frappe.search.utils");

$(document).on("app_ready", function () {
	var hidden_doctypes = frappe.boot.core_pos_doctypes || [];
	var hidden_pages = frappe.boot.core_pos_pages || [];

	if (hidden_doctypes.length && typeof frappe.search.utils.get_doctypes === "function") {
		var hidden_doctypes_set = new Set(hidden_doctypes);
		var original_get_doctypes = frappe.search.utils.get_doctypes;

		frappe.search.utils.get_doctypes = function (keywords) {
			var out = original_get_doctypes.call(frappe.search.utils, keywords);
			return out.filter(function (option) {
				return !hidden_doctypes_set.has(option.match);
			});
		};
	}

	if (hidden_pages.length && typeof frappe.search.utils.get_pages === "function") {
		var hidden_pages_set = new Set(hidden_pages);
		var original_get_pages = frappe.search.utils.get_pages;

		frappe.search.utils.get_pages = function (keywords) {
			var out = original_get_pages.call(frappe.search.utils, keywords);
			return out.filter(function (option) {
				return !(option.route && hidden_pages_set.has(option.route[0]));
			});
		};
	}
});
