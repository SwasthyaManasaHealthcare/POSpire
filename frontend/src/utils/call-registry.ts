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

/**
 * Result of a registry's `toOfflinePayload` transform. The shape mirrors what
 * the offline server endpoint expects (offline.py:478 etc.) plus optional
 * dependency metadata that the outbox uses for ordering.
 */
export interface OfflinePayloadAdapterResult {
	/** Method to POST when the scheduler drains this entry. Should resolve
	 * to a `pospire.pospire.api.offline.*` endpoint (or another whitelisted
	 * idempotent endpoint). */
	method: string;
	/** Server-shaped payload (typically `{data, offline_id, device_id, ...}`). */
	payload: Record<string, unknown>;
	/** Outbox-side dependency metadata. */
	parentOfflineIds?: string[];
	shiftOfflineId?: string | null;
	postingDate?: string;
	ownerUser?: string;
}

/**
 * Adapter function — transforms the live UI args into the shape the offline
 * endpoint expects. Invoked by `call.ts::enqueueWrite` only when an entry is
 * about to be enqueued (offline OR network_error). The supplied `ctx` carries
 * the generated `offline_id` and the device's `device_id`.
 */
export type ToOfflinePayload = (
	args: Record<string, unknown>,
	ctx: { offlineId: string; deviceId: string | null },
) => OfflinePayloadAdapterResult;

export interface WriteMethodConfig {
	intent: "write";
	/** True if the write is enqueueable in the outbox when offline. */
	offline: boolean;
	/** Outbox type bucket (invoice, material_receipt, …). Required when
	 * `offline: true`; ignored when `offline: false`. */
	outboxType?: string;
	/**
	 * REQUIRED when `offline: true`. Translates the UI's argument shape into
	 * the offline endpoint's `(data, offline_id, device_id, ...)` contract,
	 * AND returns the offline method name to POST during sync. Without this,
	 * the live live-method's payload would be sent to the offline endpoint
	 * and rejected (F5).
	 */
	toOfflinePayload?: ToOfflinePayload;
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
// Helpers used by adapters to satisfy server-side P-5 / P-11 invariants
// (offline.py::_apply_payload_metadata requires posting_date + owner_user
// inside the inner `data` JSON for every queued write).
// ---------------------------------------------------------------------------

/** Today's date in YYYY-MM-DD (local). Server treats it as the queued
 *  posting_date snapshot per P-11. */
function todayIso(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Best-effort cashier lookup. The Vite bundle bans `frappe.*` imports, but
 *  at runtime the Desk host injects `frappe.session.user` on the global. */
function currentUser(): string {
	try {
		const g = globalThis as unknown as {
			frappe?: { session?: { user?: string } };
		};
		if (g.frappe?.session?.user) return g.frappe.session.user;
	} catch {
		/* strict-privacy host */
	}
	return "Guest";
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
	// Writes — UI-facing methods, offline-routed via toOfflinePayload
	//
	// Components keep calling these `posapp.*` paths. When the call() wrapper
	// decides to enqueue (offline or post-network_error), it invokes
	// `toOfflinePayload` to (a) reshape the UI args to the offline endpoint's
	// (data, offline_id, device_id, ...) contract and (b) provide the
	// `pospire.pospire.api.offline.*` method name for the scheduler to POST.
	// Live online sends still go to the original posapp.* method.
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.submit_invoice": {
		intent: "write",
		offline: true,
		outboxType: "invoice",
		toOfflinePayload: (args, ctx) => {
			// Payments.vue calls with {data: paymentMetadata, invoice: invoiceDoc}.
			// offline.submit_invoice (offline.py:568) extracts the payment
			// metadata from the inner payload as `posa_submit_data` and passes
			// it as the second arg to posapp.submit_invoice — that's the path
			// that handles credit_change / is_cashback / customer credit etc.
			// (posapp.py:882). We must NOT merge the metadata into the invoice
			// doc; it goes under a SEPARATE `posa_submit_data` key.
			const rawInvoice = args.invoice ?? {};
			const invoice = (
				typeof rawInvoice === "string" ? JSON.parse(rawInvoice) : rawInvoice
			) as Record<string, unknown>;
			const rawPayment = args.data ?? {};
			const paymentMeta = (
				typeof rawPayment === "string" ? JSON.parse(rawPayment) : rawPayment
			) as Record<string, unknown>;

			// _apply_payload_metadata requires both fields on the invoice doc
			// (P-5, P-11).
			const postingDate = (invoice.posting_date as string) ?? todayIso();
			const ownerUser =
				(invoice.owner_user as string) ??
				(invoice.owner as string) ??
				currentUser();

			const innerData: Record<string, unknown> = {
				doctype: "Sales Invoice",
				...invoice,
				posa_submit_data: paymentMeta,
				posting_date: postingDate,
				owner_user: ownerUser,
			};

			return {
				method: "pospire.pospire.api.offline.submit_invoice",
				payload: {
					data: JSON.stringify(innerData),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
					opening_entry_offline_id:
						(invoice.pos_opening_shift_offline_id as string) ?? null,
					material_receipt_offline_ids:
						(invoice.pos_material_receipt_offline_ids as string[] | string) ??
						null,
				},
				shiftOfflineId: (invoice.pos_opening_shift_offline_id as string) ?? null,
				parentOfflineIds: ([] as string[])
					.concat(
						(invoice.pos_material_receipt_offline_ids as string[]) ?? [],
						invoice.pos_opening_shift_offline_id
							? [invoice.pos_opening_shift_offline_id as string]
							: [],
					)
					.filter(Boolean),
				postingDate,
				ownerUser,
			};
		},
	},
	// Opening a shift is live-only for now: posapp.create_opening_voucher
	// returns a response that includes the full POS Profile doc, items,
	// customers, payments, offers — all server-resolved data the SPA can't
	// reconstruct offline. Component (OpeningDialog.vue) blocks the offline
	// path with a clear message. Phase 2 will pre-cache the response shape
	// to enable offline opening.
	"pospire.pospire.api.posapp.create_opening_voucher": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.posapp.create_customer": {
		intent: "write",
		offline: true,
		outboxType: "customer",
		toOfflinePayload: (args, ctx) => {
			// posapp.create_customer accepts loose UI args. offline.create_customer
			// requires owner_user and inserts the payload directly as a Customer
			// doc (F2). Mirrors the field set in posapp.create_customer:1340-1395.
			const user = currentUser();
			const doc: Record<string, unknown> = {
				doctype: "Customer",
				customer_name: args.customer_name,
				customer_type: args.customer_type ?? "Individual",
				customer_group: args.customer_group ?? "All Customer Groups",
				territory: args.territory ?? "All Territories",
				owner_user: user,
				owner: user,
			};
			// Optional fields — only include if the UI supplied them so we don't
			// override doctype defaults with empty strings / null.
			for (const key of [
				"tax_id",
				"mobile_no",
				"email_id",
				"gender",
				"posa_referral_code",
			] as const) {
				const v = args[key];
				if (v !== undefined && v !== null && v !== "") doc[key] = v;
			}
			// Live API stores birthday as `posa_birthday` (posapp.py:1369). Map
			// the UI's `birthday` arg to that field so offline-created customers
			// don't lose it.
			if (args.birthday !== undefined && args.birthday !== null && args.birthday !== "") {
				doc.posa_birthday = args.birthday;
			}
			if (args.referral_code) doc.posa_referral_code = args.referral_code;
			if (args.company) doc.posa_referral_company = args.company;

			return {
				method: "pospire.pospire.api.offline.create_customer",
				payload: {
					data: JSON.stringify(doc),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
				},
				ownerUser: user,
			};
		},
	},
	// -----------------------------------------------------------------------
	// Writes — LIVE ONLY
	// Existing SPA writes that have NOT (yet) been re-implemented behind the
	// offline-capable endpoints above. They fire live; on network_error they
	// propagate to the caller rather than enqueuing. Revisit during Phase 2.
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.update_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.update_invoice_from_order": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_sales_invoice": { intent: "write", offline: false },
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
