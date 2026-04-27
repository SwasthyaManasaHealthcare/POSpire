/**
 * Registry-adapter tests.
 *
 * Each offline-capable write entry in `call-registry` carries a
 * `toOfflinePayload(args, ctx)` adapter that translates the UI's argument
 * shape into the offline endpoint's `(data, offline_id, device_id, …)`
 * contract. These tests exercise the three Phase 1 adapters directly.
 */

import { describe, expect, it } from "vitest";

import { methodRegistry } from "@/utils/call-registry";
import type { WriteMethodConfig } from "@/utils/call-registry";

const CTX = { offlineId: "11111111-2222-4333-8444-555555555555", deviceId: "DEV-XYZ" };

function getWrite(method: string): WriteMethodConfig {
	const entry = methodRegistry[method];
	if (!entry || entry.intent !== "write") {
		throw new Error(`Expected ${method} to be a write entry`);
	}
	return entry;
}

describe("registry adapter — submit_invoice", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.submit_invoice");

	it("is offline-capable with outboxType=invoice and an adapter", () => {
		expect(cfg.offline).toBe(true);
		expect(cfg.outboxType).toBe("invoice");
		expect(cfg.toOfflinePayload).toBeTypeOf("function");
	});

	it("places payment metadata under posa_submit_data — NOT merged into invoice fields", () => {
		const result = cfg.toOfflinePayload!(
			{
				data: { credit_change: -5, is_cashback: 1, redeemed_customer_credit: 0 },
				invoice: {
					doctype: "Sales Invoice",
					customer: "POS Customer",
					pos_opening_shift_offline_id: "shift-42",
					pos_material_receipt_offline_ids: ["mr-1", "mr-2"],
					posting_date: "2026-04-25",
					owner: "cashier@example.com",
				},
			},
			CTX,
		);

		expect(result.method).toBe("pospire.pospire.api.offline.submit_invoice");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);
		expect(result.payload.opening_entry_offline_id).toBe("shift-42");
		expect(result.payload.material_receipt_offline_ids).toEqual(["mr-1", "mr-2"]);
		expect(result.payload).not.toHaveProperty("invoice");

		// offline.submit_invoice (offline.py:568) extracts payment metadata from
		// payload.posa_submit_data and passes it as the second arg to
		// posapp.submit_invoice. If we merged it into invoice fields it would
		// be lost — that branch in posapp (credit_change / is_cashback / etc.)
		// would never fire.
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.doctype).toBe("Sales Invoice");
		expect(parsed.customer).toBe("POS Customer");
		// Payment metadata lives under posa_submit_data, separately:
		expect(parsed.posa_submit_data).toEqual({
			credit_change: -5,
			is_cashback: 1,
			redeemed_customer_credit: 0,
		});
		// And NOT scattered into the top-level invoice fields:
		expect(parsed).not.toHaveProperty("credit_change");
		expect(parsed).not.toHaveProperty("is_cashback");
		// posting_date / owner_user are inside the inner data so
		// _apply_payload_metadata sees them (P-5, P-11).
		expect(parsed.posting_date).toBe("2026-04-25");
		expect(parsed.owner_user).toBe("cashier@example.com");
	});

	it("defaults posting_date to today and owner_user to the cashier when missing", () => {
		const result = cfg.toOfflinePayload!(
			{ data: {}, invoice: { doctype: "Sales Invoice" } },
			CTX,
		);
		const parsed = JSON.parse(result.payload.data as string);
		// YYYY-MM-DD format from todayIso()
		expect(parsed.posting_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(typeof parsed.owner_user).toBe("string");
		expect(parsed.owner_user.length).toBeGreaterThan(0);
	});

	it("produces dependency metadata for the outbox (parents + shift + posting + owner)", () => {
		const result = cfg.toOfflinePayload!(
			{
				data: {},
				invoice: {
					pos_opening_shift_offline_id: "shift-42",
					pos_material_receipt_offline_ids: ["mr-1"],
					posting_date: "2026-04-25",
					owner: "cashier@example.com",
				},
			},
			CTX,
		);

		expect(result.shiftOfflineId).toBe("shift-42");
		expect(result.parentOfflineIds).toEqual(["mr-1", "shift-42"]);
		expect(result.postingDate).toBe("2026-04-25");
		expect(result.ownerUser).toBe("cashier@example.com");
	});

	it("handles missing dependency fields gracefully and supplies defaults", () => {
		const result = cfg.toOfflinePayload!({ data: {}, invoice: {} }, CTX);
		expect(result.shiftOfflineId).toBeNull();
		expect(result.parentOfflineIds).toEqual([]);
		// posting_date / owner_user are REQUIRED by the server, so the adapter
		// supplies defaults — they are never left undefined.
		expect(result.postingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(typeof result.ownerUser).toBe("string");
		expect(result.ownerUser!.length).toBeGreaterThan(0);
	});
});

describe("registry — create_opening_voucher (live-only for now)", () => {
	it("is intentionally NOT offline-capable (server response includes full POS Profile + items + customers + payments — not reconstructible client-side)", () => {
		const cfg = methodRegistry["pospire.pospire.api.posapp.create_opening_voucher"];
		expect(cfg).toBeDefined();
		expect(cfg!.intent).toBe("write");
		expect(cfg!.offline).toBe(false);
		// OpeningDialog.vue blocks the offline path with a clear message.
		// Phase 2 will pre-cache the response shape to enable offline opening.
	});
});

describe("registry adapter — create_customer", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.create_customer");

	it("constructs a Customer doc with required owner_user and only-supplied optional fields", () => {
		const result = cfg.toOfflinePayload!(
			{
				customer_name: "Alice",
				mobile_no: "555-0100",
				method: "create",
				company: "POSpire",
				email_id: "",
			},
			CTX,
		);
		expect(result.method).toBe("pospire.pospire.api.offline.create_customer");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);

		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.doctype).toBe("Customer");
		expect(parsed.customer_name).toBe("Alice");
		expect(parsed.mobile_no).toBe("555-0100");
		expect(parsed.posa_referral_company).toBe("POSpire");
		// owner_user required by offline.create_customer (P-5).
		expect(typeof parsed.owner_user).toBe("string");
		expect(parsed.owner_user.length).toBeGreaterThan(0);
		// Empty-string optional fields are NOT serialised (don't override
		// doctype defaults with "").
		expect(parsed).not.toHaveProperty("email_id");

		expect(result.ownerUser).toBe(parsed.owner_user);
	});

	it("maps UI `birthday` to the live API's `posa_birthday` field", () => {
		// posapp.create_customer stores the field as posa_birthday (posapp.py:1369);
		// without the rename, offline-created customers would lose the field.
		const result = cfg.toOfflinePayload!(
			{ customer_name: "Bob", birthday: "1990-04-25" },
			CTX,
		);
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.posa_birthday).toBe("1990-04-25");
		expect(parsed).not.toHaveProperty("birthday");
	});
});

describe("registry hygiene", () => {
	it("every offline-capable UI write has an outboxType AND a toOfflinePayload adapter", () => {
		// `pospire.pospire.api.offline.*` entries are scheduler-replay-only:
		// the scheduler POSTs them directly via `bypassConnectivityForReplay`,
		// which skips both the connectivity gate and the adapter. Components
		// must NOT call them directly. They still need to be registered (the
		// registry validates every call() target), but they don't need an
		// adapter because they ARE the offline endpoints.
		for (const [name, cfg] of Object.entries(methodRegistry)) {
			if (cfg.intent !== "write") continue;
			if (!cfg.offline) continue;
			if (name.includes("pospire.pospire.api.offline.")) continue;
			expect(cfg.outboxType, `${name} missing outboxType`).toBeTruthy();
			expect(
				cfg.toOfflinePayload,
				`${name} missing toOfflinePayload`,
			).toBeTypeOf("function");
		}
	});
});
