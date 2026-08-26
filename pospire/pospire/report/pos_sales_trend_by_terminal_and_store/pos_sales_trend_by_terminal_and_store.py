# Copyright (c) 2026, promantia business solutions PVT LTD
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt


def execute(filters=None):
	filters = frappe._dict(filters or {})
	profiles = get_pos_profiles(filters)
	columns = get_columns(profiles)
	data = get_data(filters, profiles)
	chart = get_chart(profiles, data)
	return columns, data, None, chart


def get_conditions(filters):
	conditions = []
	if filters.get("company"):
		conditions.append("and company = %(company)s")
	if filters.get("from_date"):
		conditions.append("and posting_date >= %(from_date)s")
	if filters.get("to_date"):
		conditions.append("and posting_date <= %(to_date)s")
	return " ".join(conditions)


def get_pos_profiles(filters):
	conditions = get_conditions(filters)
	return frappe.db.sql_list(
		f"""
		select distinct pos_profile
		from `tabSales Invoice`
		where is_pos = 1 and docstatus = 1 and is_return = 0
			and pos_profile is not null and pos_profile != ''
			{conditions}
		order by pos_profile
		""",
		filters,
	)


def get_columns(profiles):
	columns = [
		{"fieldname": "posting_date", "label": _("Date"), "fieldtype": "Date", "width": 120},
	]
	for profile in profiles:
		columns.append(
			{
				"fieldname": frappe.scrub(profile),
				"label": profile,
				"fieldtype": "Currency",
				"width": 150,
			}
		)
	return columns


def get_data(filters, profiles):
	conditions = get_conditions(filters)
	rows = frappe.db.sql(
		f"""
		select posting_date, pos_profile, sum(base_grand_total) as amount
		from `tabSales Invoice`
		where is_pos = 1 and docstatus = 1 and is_return = 0
			and pos_profile is not null and pos_profile != ''
			{conditions}
		group by posting_date, pos_profile
		order by posting_date
		""",
		filters,
		as_dict=True,
	)

	pivot = {}
	for row in rows:
		pivot.setdefault(row.posting_date, {})[row.pos_profile] = flt(row.amount)

	data = []
	for posting_date in sorted(pivot):
		entry = {"posting_date": posting_date}
		for profile in profiles:
			entry[frappe.scrub(profile)] = pivot[posting_date].get(profile, 0)
		data.append(entry)
	return data


def get_chart(profiles, data):
	if not profiles or not data:
		return None
	return {
		"data": {
			"labels": [row["posting_date"].strftime("%Y-%m-%d") for row in data],
			"datasets": [
				{"name": profile, "values": [row[frappe.scrub(profile)] for row in data]}
				for profile in profiles
			],
		},
		"type": "line",
	}
