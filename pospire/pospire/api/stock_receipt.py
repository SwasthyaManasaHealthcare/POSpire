import frappe


@frappe.whitelist()
def create_pos_stock_entry(
	item_code,
	qty,
	warehouse,
	pos_profile=None,
	serial_nos=None,
	batch_no=None,
	expiry_date=None,
):
	if not item_code or not qty or not warehouse:
		frappe.throw("Missing required fields")

	current_user = frappe.session.user

	if not pos_profile:
		frappe.throw("POS Profile is required", frappe.PermissionError)

	allowed_users = frappe.get_all("POS Profile User", filters={"parent": pos_profile}, pluck="user")
	if allowed_users and current_user not in allowed_users:
		frappe.throw("You are not allowed to use this POS Profile", frappe.PermissionError)

	profile = frappe.get_doc("POS Profile", pos_profile)

	if not profile.posa_allow_add_to_stock_at_pos:
		frappe.throw("Add to Stock is not enabled for this POS Profile", frappe.PermissionError)

	qty = float(qty)

	if serial_nos:
		serial_list = [s.strip() for s in serial_nos.split("\n") if s.strip()]

		if len(serial_list) != len(set(serial_list)):
			frappe.throw("Duplicate serial numbers entered")

		if len(serial_list) != int(qty):
			frappe.throw("Serial count must match quantity")

		for serial_no in serial_list:
			existing = frappe.db.get_value("Serial No", serial_no, ["item_code", "status"], as_dict=True)
			if existing:
				if existing.item_code != item_code:
					frappe.throw(
						f"Serial No {serial_no} belongs to another item '{existing.item_code}'.",
						title="Invalid Serial No",
					)
				if existing.status == "Active":
					frappe.throw(f"Serial No {serial_no} is already in stock.", title="Duplicate Serial No")

		serial_nos = "\n".join(serial_list)

	if batch_no:
		existing_item = frappe.db.get_value("Batch", batch_no, "item")
		if existing_item and existing_item != item_code:
			frappe.throw(
				f"Batch {batch_no} is linked to another item. Please use a correct batch.",
				title="Invalid Batch",
			)
		if not existing_item:
			batch_doc = frappe.get_doc(
				{
					"doctype": "Batch",
					"batch_id": batch_no,
					"item": item_code,
					"expiry_date": expiry_date,
				}
			)
			batch_doc.insert(ignore_permissions=True)

	valuation_rate = frappe.db.get_value(
		"Bin",
		{"item_code": item_code, "warehouse": warehouse},
		"valuation_rate",
	)
	last_purchase_rate = frappe.db.get_value("Item", item_code, "last_purchase_rate")
	basic_rate = valuation_rate if valuation_rate is not None else last_purchase_rate

	if not basic_rate:
		frappe.throw(
			f"Cannot add stock for item {item_code}. "
			"No valuation rate found. Please create a stock entry with a rate first."
		)

	stock_entry = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Receipt",
			"company": profile.company,
			"items": [
				{
					"item_code": item_code,
					"qty": qty,
					"t_warehouse": warehouse,
					"serial_no": serial_nos,
					"batch_no": batch_no,
					"basic_rate": basic_rate,
				}
			],
		}
	)
	stock_entry.flags.ignore_permissions = True
	stock_entry.insert()
	stock_entry.submit()
	frappe.db.commit()

	return {
		"status": "success",
		"stock_entry": stock_entry.name,
		"batch_no": batch_no or None,
		"serial_nos": serial_nos or None,
	}
