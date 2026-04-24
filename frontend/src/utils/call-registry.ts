/**
 * Method registry for `@/utils/call`.
 *
 * Every Frappe-whitelisted method the SPA calls MUST be listed here. Calling
 * `call({ method })` with a method not in this registry throws
 * `UnregisteredMethod`. This forces every new network call site to be an
 * explicit policy decision (see 09-api-boundary.md §3).
 *
 * Do NOT introduce a default policy. See §3.1 of the spec for why.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MethodIntent = "read" | "write";

export interface ReadMethodConfig {
	intent: "read";
	/** True if the read is served from cache when offline. */
	offline: boolean;
	/** Cache TTL in ms when `offline: true`. Ignored when `offline: false`. */
	cacheTTLMs?: number;
}

export interface WriteMethodConfig {
	intent: "write";
	/** True if the write is enqueueable in the outbox when offline. */
	offline: boolean;
	/** Outbox type bucket (invoice, material_receipt, …). Required when
	 * `offline: true`; ignored when `offline: false`. */
	outboxType?: string;
}

export type MethodConfig = ReadMethodConfig | WriteMethodConfig;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `call()` receives a `method` not present in the registry.
 * Always a developer error — either add an entry, or the call site is wrong.
 */
export class UnregisteredMethod extends Error {
	readonly method: string;
	constructor(method: string) {
		super(
			`Method "${method}" is not registered in @/utils/call-registry. ` +
				"Add an explicit entry with intent + offline policy; do not default.",
		);
		this.name = "UnregisteredMethod";
		this.method = method;
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/**
 * The canonical registry. Names are the exact server method paths.
 *
 * Scope: items / customers / shifts / payments / approval / offline endpoints
 * actually reached from the SPA today plus the 6 offline-capable writes the
 * design requires (09-api-boundary.md §3).
 */
export const methodRegistry: Record<string, MethodConfig> = {
	// -----------------------------------------------------------------------
	// Reads — offline-cacheable
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.get_items": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},
	"pospire.pospire.api.posapp.get_items_groups": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},
	"pospire.pospire.api.posapp.get_customer_names": {
		intent: "read",
		offline: true,
		cacheTTLMs: 6 * HOUR,
	},
	"pospire.pospire.api.posapp.get_offers": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},

	// -----------------------------------------------------------------------
	// Reads — LIVE ONLY (P-4: server stays authoritative)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.get_items_details": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_item_detail": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_customer_info": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_customer_addresses": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_sales_person_names": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_available_credit": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_applicable_delivery_charges": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.posapp.get_opening_dialog_data": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.check_opening_shift": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_draft_invoices": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_orders": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_invoices_for_return": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_invoices_with_items": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_pos_coupon": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_active_gift_coupons": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_sales_invoice_child_table": {
		intent: "read",
		offline: false,
	},

	// Payment entry reads (pay.vue flow)
	"pospire.pospire.api.payment_entry.get_available_pos_profiles": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.payment_entry.get_outstanding_invoices": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.payment_entry.get_unallocated_payments": {
		intent: "read",
		offline: false,
	},

	// M-pesa reads
	"pospire.pospire.api.m_pesa.get_mpesa_draft_payments": { intent: "read", offline: false },
	"pospire.pospire.api.m_pesa.get_mpesa_mode_of_payment": { intent: "read", offline: false },

	// Approval reads
	"pospire.pospire.api.approval.get_approval_config": { intent: "read", offline: false },
	"pospire.pospire.api.approval.get_approval_request_status": {
		intent: "read",
		offline: false,
	},

	// Hardware manager reads
	"pospire.pospire.api.hardware_manager.get_hardware_manager_setting": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.hardware_manager.hardware_url": { intent: "read", offline: false },
	"pospire.pospire.api.hardware_manager.generate_print_xml": {
		intent: "read",
		offline: false,
	},

	// Generic client reads used by the SPA (address/territory lookups, etc.)
	"frappe.client.get_list": { intent: "read", offline: false },
	"frappe.client.get": { intent: "read", offline: false },
	"frappe.client.get_value": { intent: "read", offline: false },
	"frappe.client.get_doc": { intent: "read", offline: false },

	// Auth
	logout: { intent: "write", offline: false },

	// -----------------------------------------------------------------------
	// Writes — offline-capable (outbox queues when offline; server enforces
	// idempotency on offline_id per P-5)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.offline.submit_invoice": {
		intent: "write",
		offline: true,
		outboxType: "invoice",
	},
	"pospire.pospire.api.offline.create_material_receipt": {
		intent: "write",
		offline: true,
		outboxType: "material_receipt",
	},
	"pospire.pospire.api.offline.create_opening_entry": {
		intent: "write",
		offline: true,
		outboxType: "opening_entry",
	},
	"pospire.pospire.api.offline.create_closing_entry": {
		intent: "write",
		offline: true,
		outboxType: "closing_entry",
	},
	"pospire.pospire.api.offline.create_customer": {
		intent: "write",
		offline: true,
		outboxType: "customer",
	},
	"pospire.pospire.api.offline.create_return": {
		intent: "write",
		offline: true,
		outboxType: "return",
	},

	// -----------------------------------------------------------------------
	// Writes — LIVE ONLY
	// Existing SPA writes that have NOT (yet) been re-implemented behind the
	// offline-capable endpoints above. They fire live; on network_error they
	// propagate to the caller rather than enqueuing. Revisit during Phase 2.
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.submit_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.update_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.update_invoice_from_order": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_sales_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.create_customer": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.create_opening_voucher": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.create_sales_invoice_from_order": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.posapp.make_address": { intent: "write", offline: false },
	// TODO: classify once owning team confirms semantics (approval flow + mpesa STK push).
	// These look like live-only server-side integrations (PIN auth, Safaricom).
	"pospire.pospire.api.approval.create_approval_request": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.approval.notify_remote_manager": { intent: "write", offline: false },
	"pospire.pospire.api.approval.verify_pin_and_approve": { intent: "write", offline: false },
	"pospire.pospire.api.approval.cancel_approval_request": { intent: "write", offline: false },
	"pospire.pospire.api.approval.bulk_cancel_approval_requests": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.approval.link_requests_to_invoice": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.m_pesa.submit_mpesa_payment": { intent: "write", offline: false },
	"pospire.pospire.api.payment_entry.process_pos_payment": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.posapp.create_payment_request": { intent: "write", offline: false },

	// Shift close/open desk endpoints (live-only in Phase 1).
	"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening":
		{ intent: "read", offline: false },
	"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift": {
		intent: "write",
		offline: false,
	},

	// -----------------------------------------------------------------------
	// Operational / diagnostic (always fire live)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.offline.ping": { intent: "read", offline: false },
	"pospire.pospire.api.offline.log_batch": { intent: "write", offline: false },
	"pospire.pospire.api.offline.submit_recovery_log": { intent: "write", offline: false },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `method` against the registry, throwing `UnregisteredMethod` if
 * absent. Explicit rather than implicit by design (09-api-boundary.md §3.1).
 */
export function getMethodConfig(method: string): MethodConfig {
	const config = methodRegistry[method];
	if (!config) {
		throw new UnregisteredMethod(method);
	}
	return config;
}

/** Narrow type guard for read entries. */
export function isReadConfig(c: MethodConfig): c is ReadMethodConfig {
	return c.intent === "read";
}

/** Narrow type guard for write entries. */
export function isWriteConfig(c: MethodConfig): c is WriteMethodConfig {
	return c.intent === "write";
}
