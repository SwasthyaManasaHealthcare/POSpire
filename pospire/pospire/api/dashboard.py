import frappe
from frappe.utils import cint, flt, get_datetime, now_datetime


def _empty_cards():
	return {
		"total_net_sales": 0,
		"bill_count": 0,
		"loyalty_redemptions": 0,
		"total_returns": 0,
		"held_invoices": 0,
		"cancelled_invoices": 0,
	}


def _empty_hourly_sales():
	return {
		"labels": [],
		"values": [],
	}


def _empty_payment_distribution():
	return []


def _empty_top_products():
	return []


def _empty_top_categories():
	return []


def _get_current_open_shift():
	open_vouchers = frappe.db.get_all(
		"POS Opening Shift",
		filters={
			"user": frappe.session.user,
			"pos_closing_shift": ["is", "not set"],
			"docstatus": 1,
			"status": "Open",
		},
		fields=["name", "period_start_date"],
		order_by="period_start_date desc",
		limit_page_length=1,
	)
	return open_vouchers[0] if open_vouchers else None


def _get_hour_start(value):
	value = get_datetime(value)
	return value.replace(minute=0, second=0, microsecond=0)


def _get_hourly_sales(pos_opening_shift, period_start_date):
	hour_start = _get_hour_start(period_start_date)
	current_time = now_datetime()
	current_hour = _get_hour_start(current_time)
	labels = []
	bucket_keys = []
	values_by_bucket = {}

	while hour_start <= current_hour:
		bucket_key = hour_start.strftime("%Y-%m-%d %H:00:00")
		bucket_keys.append(bucket_key)
		labels.append(hour_start.strftime("%H:00"))
		values_by_bucket[bucket_key] = 0
		hour_start = frappe.utils.add_to_date(hour_start, hours=1)

	rows = frappe.db.sql(
		"""
		SELECT DATE_FORMAT(creation, '%%Y-%%m-%%d %%H:00:00') AS sales_hour,
			SUM(grand_total) AS total_sales
		FROM `tabSales Invoice`
		WHERE docstatus = %s
		  AND is_pos = %s
		  AND IFNULL(is_return, 0) = %s
		  AND posa_pos_opening_shift = %s
		  AND creation BETWEEN %s AND %s
		GROUP BY DATE_FORMAT(creation, '%%Y-%%m-%%d %%H:00:00')
		ORDER BY sales_hour
		""",
		(1, 1, 0, pos_opening_shift, period_start_date, current_time),
		as_dict=True,
	)

	for row in rows:
		if row.sales_hour in values_by_bucket:
			values_by_bucket[row.sales_hour] = flt(row.total_sales)

	return {
		"labels": labels,
		"values": [values_by_bucket[bucket_key] for bucket_key in bucket_keys],
	}


def _get_payment_distribution(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sip.mode_of_payment,
			COALESCE(SUM(sip.amount), 0) AS amount
		FROM `tabSales Invoice Payment` sip
		JOIN `tabSales Invoice` si
			ON si.name = sip.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY sip.mode_of_payment
		ORDER BY amount DESC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"mode_of_payment": row.mode_of_payment,
			"amount": flt(row.amount),
		}
		for row in rows
	]


def _get_top_products(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sii.item_code,
			sii.item_name,
			COALESCE(SUM(sii.qty), 0) AS total_qty,
			COALESCE(SUM(sii.base_net_amount), 0) AS total_sales
		FROM `tabSales Invoice Item` sii
		JOIN `tabSales Invoice` si
			ON si.name = sii.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND IFNULL(si.is_return, 0) = 0
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY
			sii.item_code,
			sii.item_name
		ORDER BY
			total_qty DESC,
			total_sales DESC,
			sii.item_name ASC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"item_code": row.item_code,
			"item_name": row.item_name,
			"total_qty": flt(row.total_qty),
			"total_sales": flt(row.total_sales),
		}
		for row in rows
	]


def _get_top_categories(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sii.item_group,
			COALESCE(SUM(sii.qty), 0) AS total_qty,
			COALESCE(SUM(sii.base_net_amount), 0) AS total_sales
		FROM `tabSales Invoice Item` sii
		JOIN `tabSales Invoice` si
			ON si.name = sii.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND IFNULL(si.is_return, 0) = 0
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY
			sii.item_group
		ORDER BY
			total_sales DESC,
			total_qty DESC,
			sii.item_group ASC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"item_group": row.item_group,
			"total_qty": flt(row.total_qty),
			"total_sales": flt(row.total_sales),
		}
		for row in rows
	]


@frappe.whitelist()
def get_shift_dashboard():
	cards = _empty_cards()
	hourly_sales = _empty_hourly_sales()
	payment_distribution = _empty_payment_distribution()
	top_products = _empty_top_products()
	top_categories = _empty_top_categories()
	opening_shift = _get_current_open_shift()
	if not opening_shift:
		return {
			"cards": cards,
			"hourly_sales": hourly_sales,
			"payment_distribution": payment_distribution,
			"top_products": top_products,
			"top_categories": top_categories,
		}

	pos_opening_shift = opening_shift["name"]

	rows = frappe.db.sql(
		"""
		SELECT
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 0
				THEN net_total ELSE 0
			END), 0) AS total_net_sales,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 0
				THEN 1 ELSE 0
			END), 0) AS bill_count,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(redeem_loyalty_points, 0) = 1
				THEN loyalty_amount ELSE 0
			END), 0) AS loyalty_redemptions,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 1
				THEN ABS(grand_total) ELSE 0
			END), 0) AS total_returns,
			COALESCE(SUM(CASE
				WHEN docstatus = 0
					AND IFNULL(posa_is_printed, 0) = 0
				THEN 1 ELSE 0
			END), 0) AS held_invoices,
			COALESCE(SUM(CASE
				WHEN docstatus = 2
					AND is_pos = 1
				THEN 1 ELSE 0
			END), 0) AS cancelled_invoices
		FROM `tabSales Invoice`
		WHERE posa_pos_opening_shift = %(pos_opening_shift)s
		""",
		{"pos_opening_shift": pos_opening_shift},
		as_dict=True,
	)

	if not rows:
		return {
			"cards": cards,
			"hourly_sales": hourly_sales,
			"payment_distribution": payment_distribution,
			"top_products": top_products,
			"top_categories": top_categories,
		}

	row = rows[0]
	cards.update(
		{
			"total_net_sales": flt(row.total_net_sales),
			"bill_count": cint(row.bill_count),
			"loyalty_redemptions": flt(row.loyalty_redemptions),
			"total_returns": flt(row.total_returns),
			"held_invoices": cint(row.held_invoices),
			"cancelled_invoices": cint(row.cancelled_invoices),
		}
	)
	hourly_sales = _get_hourly_sales(pos_opening_shift, opening_shift["period_start_date"])
	payment_distribution = _get_payment_distribution(pos_opening_shift)
	top_products = _get_top_products(pos_opening_shift)
	top_categories = _get_top_categories(pos_opening_shift)

	return {
		"cards": cards,
		"hourly_sales": hourly_sales,
		"payment_distribution": payment_distribution,
		"top_products": top_products,
		"top_categories": top_categories,
	}
