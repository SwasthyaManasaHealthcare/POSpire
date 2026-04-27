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

	it("reshapes UI args to (data, offline_id, device_id, opening_shift, MR list)", () => {
		const result = cfg.toOfflinePayload!(
			{
				data: { foo: "bar" },
				invoice: {
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
		// `data` is JSON-stringified for the server's `_load(data)` parser.
		expect(typeof result.payload.data).toBe("string");
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

	it("handles missing optional fields gracefully", () => {
		const result = cfg.toOfflinePayload!({ data: {}, invoice: {} }, CTX);
		expect(result.shiftOfflineId).toBeNull();
		expect(result.parentOfflineIds).toEqual([]);
		expect(result.postingDate).toBeUndefined();
		expect(result.ownerUser).toBeUndefined();
	});
});

describe("registry adapter — create_opening_voucher", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.create_opening_voucher");

	it("routes to offline.create_opening_entry with stringified data", () => {
		const result = cfg.toOfflinePayload!(
			{ pos_profile: "Default", company: "POSpire", balance_details: [] },
			CTX,
		);
		expect(result.method).toBe("pospire.pospire.api.offline.create_opening_entry");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);
		expect(typeof result.payload.data).toBe("string");
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.pos_profile).toBe("Default");
	});
});

describe("registry adapter — create_customer", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.create_customer");

	it("routes to offline.create_customer with stringified data", () => {
		const result = cfg.toOfflinePayload!(
			{ customer_name: "Alice", mobile_no: "555-0100", method: "create" },
			CTX,
		);
		expect(result.method).toBe("pospire.pospire.api.offline.create_customer");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.customer_name).toBe("Alice");
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
