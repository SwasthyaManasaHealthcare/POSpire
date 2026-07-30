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
frappe.provide("frappe.search.utils");

$(document).on("app_ready", function () {
	var hidden = frappe.boot.core_pos_doctypes || [];

	if (!hidden.length || typeof frappe.search.utils.get_doctypes !== "function") {
		return;
	}

	var hidden_set = new Set(hidden);
	var original_get_doctypes = frappe.search.utils.get_doctypes;

	frappe.search.utils.get_doctypes = function (keywords) {
		var out = original_get_doctypes.call(frappe.search.utils, keywords);
		return out.filter(function (option) {
			return !hidden_set.has(option.match);
		});
	};
});
