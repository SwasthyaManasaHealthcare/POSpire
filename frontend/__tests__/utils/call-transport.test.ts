/**
 * Transport tests for `@/utils/call`'s `liveFetch` (task-11).
 *
 * `liveFetch` is module-private by design — these tests drive it exclusively
 * through the exported `call()`, using `pospire.pospire.api.offline.ping`
 * (`{ intent: "read", offline: false }` in call-registry.ts) so the read path
 * has no cache and no offline fallback to get in the way: a live 2xx returns
 * the raw `message` body, and a live failure rejects straight out of `call()`.
 *
 * Why this file exists at all: the plan's global "no new tests" rule is
 * explicitly overridden for this task only (see task-11-brief.md). `call.ts`
 * now performs its own `fetch()` instead of delegating to frappe-ui, and
 * there is no TypeScript compiler in this project to catch a shape mistake
 * in that rewrite — these five cases are the only real gate on it.
 *
 * Each test does its own `vi.resetModules()` + dynamic import (matching
 * `connectivity.test.ts`'s convention) so the connectivity module's
 * module-level state — and any async reachability ping a 5xx report can
 * kick off (see connectivity.ts `reportRequestOutcome`) — never bleeds
 * across tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const METHOD = "pospire.pospire.api.offline.ping";

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (window as unknown as { csrf_token?: string }).csrf_token;
});

async function importFresh() {
	const { call } = await import("@/utils/call");
	const { connectivity } = await import("@/offline/connectivity");
	return { call, connectivity };
}

/** A resolved-fetch stand-in. Only the members `liveFetch` touches are set. */
function fakeResponse(opts: {
	status: number;
	ok?: boolean;
	jsonBody?: unknown;
	textBody?: string;
}): Response {
	const ok = opts.ok ?? (opts.status >= 200 && opts.status < 300);
	const text = opts.textBody ?? JSON.stringify(opts.jsonBody ?? {});
	return {
		ok,
		status: opts.status,
		json: async () => opts.jsonBody,
		text: async () => text,
	} as Response;
}

function setCsrfToken(value: string | undefined) {
	if (value === undefined) {
		delete (window as unknown as { csrf_token?: string }).csrf_token;
	} else {
		(window as unknown as { csrf_token?: string }).csrf_token = value;
	}
}

// ---------------------------------------------------------------------------
// 1. Request shape
// ---------------------------------------------------------------------------

describe("liveFetch request shape", () => {
	it("posts to /api/method/<method> with frappe-ui's headers/body and gates the CSRF header on a real token", async () => {
		const { call } = await importFresh();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(fakeResponse({ status: 200, jsonBody: { message: { ok: true } } }));
		vi.stubGlobal("fetch", fetchMock);

		setCsrfToken("a-real-csrf-token");
		await call({ method: METHOD, args: { foo: "bar" }, intent: "read" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`/api/method/${METHOD}`);
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			Accept: "application/json",
			"Content-Type": "application/json; charset=utf-8",
			"X-Frappe-Site-Name": window.location.hostname,
			"X-Frappe-CSRF-Token": "a-real-csrf-token",
		});
		expect(init.body).toBe(JSON.stringify({ foo: "bar" }));

		// The unrendered placeholder must NOT produce a CSRF header — sending
		// the literal string would look like a (bogus) token to the server.
		fetchMock.mockClear();
		setCsrfToken("{{ csrf_token }}");
		await call({ method: METHOD, args: { foo: "bar" }, intent: "read" });
		const [, init2] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init2.headers).not.toHaveProperty("X-Frappe-CSRF-Token");
	});
});

// ---------------------------------------------------------------------------
// 2. Success
// ---------------------------------------------------------------------------

describe("liveFetch success", () => {
	it("resolves to the message payload, not the envelope", async () => {
		const { call } = await importFresh();
		const payload = { server_time: "2026-08-10T00:00:00Z", ok: true };
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				fakeResponse({
					status: 200,
					// `other_envelope_field` stands in for things like `docs` that a
					// 2xx body can carry alongside `message` — the caller must never
					// see them.
					jsonBody: { message: payload, other_envelope_field: "should-not-leak" },
				}),
			),
		);

		const result = await call({ method: METHOD, args: {}, intent: "read" });

		expect(result).toEqual(payload);
	});
});

// ---------------------------------------------------------------------------
// 3. Structured 409 — the case this task exists for
// ---------------------------------------------------------------------------

describe("liveFetch structured error", () => {
	it("carries error_code/details/status through a structured 409", async () => {
		const { call } = await importFresh();
		const body = {
			exc_type: "OfflineSubmitError",
			error_code: "siblings_not_ready",
			details: { missing_offline_ids: ["a", "b"] },
			http_status_code: 409,
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ status: 409, jsonBody: body })));

		await expect(call({ method: METHOD, args: {}, intent: "read" })).rejects.toMatchObject({
			error_code: "siblings_not_ready",
			details: { missing_offline_ids: ["a", "b"] },
			status: 409,
			http_status_code: 409,
			exc_type: "OfflineSubmitError",
		});
	});
});

// ---------------------------------------------------------------------------
// 4. Non-JSON error body
// ---------------------------------------------------------------------------

describe("liveFetch non-JSON error body", () => {
	it("does not throw a SyntaxError on an HTML 502 and leaves structured fields undefined", async () => {
		const { call } = await importFresh();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					fakeResponse({ status: 502, textBody: "<html>Bad Gateway</html>" }),
				),
		);

		const err: unknown = await call({ method: METHOD, args: {}, intent: "read" }).catch(
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SyntaxError);
		const e = err as Record<string, unknown>;
		expect(e.status).toBe(502);
		expect(e.error_code).toBeUndefined();
		expect(e.details).toBeUndefined();
		// http_status_code falls back to the real HTTP status when the
		// (absent, unparseable) body has none of its own.
		expect(e.http_status_code).toBe(502);
	});
});

// ---------------------------------------------------------------------------
// 5. Network rejection
// ---------------------------------------------------------------------------

describe("liveFetch network rejection", () => {
	it("propagates a fetch rejection out of call() without reporting a success outcome", async () => {
		const { call, connectivity } = await importFresh();
		const reportSpy = vi.spyOn(connectivity, "reportRequestOutcome");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

		await expect(call({ method: METHOD, args: {}, intent: "read" })).rejects.toThrow(
			"Failed to fetch",
		);

		expect(reportSpy).not.toHaveBeenCalledWith("success");
	});
});
