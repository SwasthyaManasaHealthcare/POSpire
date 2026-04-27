/**
 * Single API boundary for POSpire's Vue SPA (P-2).
 *
 * Every network call in `frontend/src/` MUST flow through this function.
 * Direct `frappe-ui` imports in components are forbidden (enforced by
 * `no-restricted-imports`). See 09-api-boundary.md for the full contract.
 *
 * Responsibilities:
 *   - Decide online-live vs. offline-cache vs. outbox-enqueue per method.
 *   - Attach `offline_id` (generated if not supplied) for offline-capable writes.
 *   - Report request outcomes back to the connectivity detector.
 *   - Emit one instrumentation event per call.
 *
 * NOT this wrapper's responsibility:
 *   - Retry (outbox owns it for writes; reads fail and the caller decides).
 *   - Auth (frappe-ui session cookie handling).
 *   - Request batching / response transformation.
 */

// This file is the ONE exception to the `no-restricted-imports` ban on
// `frappe-ui`. See eslint.config.js override.
import { call as frappeUiCall } from "frappe-ui";

import {
	getMethodConfig,
	isReadConfig,
	isWriteConfig,
	UnregisteredMethod,
	type MethodConfig,
	type ReadMethodConfig,
	type WriteMethodConfig,
} from "./call-registry";
import { connectivity } from "@/offline/connectivity";
import { getOutboxEnqueue, getReadCache } from "@/offline/runtime";
import type { OutboxEnqueueAck } from "@/offline/types";

// Re-export so consumers don't need to import from the registry module.
export { UnregisteredMethod };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallOptions {
	/** Frappe-whitelisted method path (must be in call-registry). */
	method: string;
	/** Positional/keyword args passed to the server method. */
	args?: Record<string, unknown>;
	/** Determines offline behaviour. Read = cache/live; Write = outbox/live. */
	intent: "read" | "write";
	/** Optional cache hint for reads. Defaults to `method + stable(args)`. */
	cacheKey?: string;
	/** Read TTL in ms. Defaults to the per-method value in the registry. */
	cacheTTLMs?: number;
	/** Writes only. Auto-generated if omitted. Reused across retries. */
	offlineIdempotencyKey?: string;
	/** Cancel the in-flight request. */
	abortSignal?: AbortSignal;
	/**
	 * Internal use by the sync scheduler. When `true`, bypasses the
	 * online/offline gate and the registry's `toOfflinePayload` adapter:
	 * the request goes straight to live fetch with the supplied method+args.
	 * Prevents replay re-entrancy if connectivity flips mid-drain (F7).
	 *
	 * MUST NOT be set by component-level callers; only `@/offline/sync` uses
	 * it. Idempotency on `pos_offline_id` keeps duplicate POSTs safe.
	 */
	bypassConnectivityForReplay?: boolean;
}

/** A cached read surfaces `stale: true` so callers type-narrow structurally. */
export interface StaleReadResult<T = unknown> {
	data: T;
	stale: true;
	cachedAt: number;
}

export type CallResult<T = unknown> = T | StaleReadResult<T> | OutboxEnqueueAck;

// ---------------------------------------------------------------------------
// Error surfaces (09-api-boundary.md §7)
// ---------------------------------------------------------------------------

export class OfflineReadUnavailable extends Error {
	readonly method: string;
	readonly cacheKey: string;
	constructor(method: string, cacheKey: string) {
		super(
			`Offline read for "${method}" is unavailable: no cache entry for ${cacheKey}.`,
		);
		this.name = "OfflineReadUnavailable";
		this.method = method;
		this.cacheKey = cacheKey;
	}
}

export class OfflineWriteUnavailable extends Error {
	readonly method: string;
	constructor(method: string) {
		super(
			`Offline write for "${method}" is unavailable: outbox is not registered. ` +
				"Integration gap — Agent 3's outbox must call registerOutboxEnqueue.",
		);
		this.name = "OfflineWriteUnavailable";
		this.method = method;
	}
}

export class MethodPolicyError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "MethodPolicyError";
	}
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

export interface CallInstrumentation {
	method: string;
	intent: "read" | "write";
	offline: boolean;
	cacheHit?: boolean;
	durationMs: number;
	outcome: "ok" | "error" | "enqueued";
	attempt: number;
}

type InstrumentationSink = (event: CallInstrumentation) => void;

const instrumentationSinks = new Set<InstrumentationSink>();

/** Subscribe to instrumentation events. Used by the reconciliation workspace. */
export function onInstrumentation(fn: InstrumentationSink): () => void {
	instrumentationSinks.add(fn);
	return () => instrumentationSinks.delete(fn);
}

function emit(event: CallInstrumentation): void {
	for (const sink of instrumentationSinks) {
		try {
			sink(event);
		} catch (err) {
			console.error("[call] instrumentation sink threw", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Two calling shapes are supported:
 *
 *   // Canonical (TS):
 *   await call<T>({ method, args, intent: 'read' })
 *
 *   // Legacy positional (accepted during migration; throws if intent can't
 *   // be inferred from the registry):
 *   await call<T>(method, args?)
 *
 * The legacy shape exists so partially-migrated JS/Vue files can keep
 * working during Phase 1. New code MUST use the options object.
 */
export async function call<T = unknown>(opts: CallOptions): Promise<CallResult<T>>;
export async function call<T = unknown>(
	method: string,
	args?: Record<string, unknown>,
): Promise<CallResult<T>>;
export async function call<T = unknown>(
	optsOrMethod: CallOptions | string,
	maybeArgs?: Record<string, unknown>,
): Promise<CallResult<T>> {
	const opts = normalizeOptions(optsOrMethod, maybeArgs);
	const config = getMethodConfig(opts.method); // throws UnregisteredMethod
	validateIntent(opts, config);

	if (isReadConfig(config)) {
		return (await runRead<T>(opts, config)) as CallResult<T>;
	}
	if (isWriteConfig(config)) {
		return (await runWrite<T>(opts, config)) as CallResult<T>;
	}
	// Unreachable — narrowed by the two guards above.
	throw new MethodPolicyError(`Unknown method config shape for ${opts.method}`);
}

function normalizeOptions(
	optsOrMethod: CallOptions | string,
	maybeArgs?: Record<string, unknown>,
): CallOptions {
	if (typeof optsOrMethod === "string") {
		// Legacy positional shape. Intent is inferred from the registry; we
		// set a placeholder here and `validateIntent` enforces agreement.
		const cfg = getMethodConfig(optsOrMethod);
		return {
			method: optsOrMethod,
			args: maybeArgs,
			intent: cfg.intent,
		};
	}
	return optsOrMethod;
}

function validateIntent(opts: CallOptions, config: MethodConfig): void {
	if (opts.intent !== config.intent) {
		throw new MethodPolicyError(
			`Method "${opts.method}" is registered as intent "${config.intent}" ` +
				`but was called with intent "${opts.intent}". Update one or the other.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

async function runRead<T>(opts: CallOptions, config: ReadMethodConfig): Promise<CallResult<T>> {
	const startedAt = nowMs();
	const attempt = 1;
	const cacheKey = opts.cacheKey ?? defaultCacheKey(opts.method, opts.args);
	const ttlMs = opts.cacheTTLMs ?? config.cacheTTLMs;
	const cache = config.offline ? getReadCache() : null;

	if (connectivity.isOnline()) {
		try {
			const result = await liveFetch<T>(opts);
			if (cache) {
				try {
					await cache.write(cacheKey, result, ttlMs);
				} catch (err) {
					// Cache write failures must not fail the read (P-14 allows
					// graceful degradation for non-critical-path writes).
					console.warn("[call] cache write failed", err);
				}
			}
			emit({
				method: opts.method,
				intent: "read",
				offline: false,
				cacheHit: false,
				durationMs: nowMs() - startedAt,
				outcome: "ok",
				attempt,
			});
			return result;
		} catch (err) {
			const classified = classifyFetchError(err);
			connectivity.reportRequestOutcome(classified);

			if (classified === "http_4xx") {
				emit({
					method: opts.method,
					intent: "read",
					offline: false,
					cacheHit: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}
			// network_error or 5xx → fall through to cache on read path
			if (cache) {
				const cached = await safeCacheRead<T>(cache, cacheKey);
				if (cached) {
					emit({
						method: opts.method,
						intent: "read",
						offline: false,
						cacheHit: true,
						durationMs: nowMs() - startedAt,
						outcome: "ok",
						attempt,
					});
					return { data: cached.data, stale: true, cachedAt: cached.cachedAt };
				}
			}
			emit({
				method: opts.method,
				intent: "read",
				offline: false,
				cacheHit: false,
				durationMs: nowMs() - startedAt,
				outcome: "error",
				attempt,
			});
			throw err;
		}
	}

	// Offline path
	if (!config.offline) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey);
	}
	if (!cache) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey);
	}
	const cached = await safeCacheRead<T>(cache, cacheKey);
	if (!cached) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey);
	}
	emit({
		method: opts.method,
		intent: "read",
		offline: true,
		cacheHit: true,
		durationMs: nowMs() - startedAt,
		outcome: "ok",
		attempt,
	});
	return { data: cached.data, stale: true, cachedAt: cached.cachedAt };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

async function runWrite<T>(opts: CallOptions, config: WriteMethodConfig): Promise<CallResult<T>> {
	const startedAt = nowMs();
	const attempt = 1;

	// Sync scheduler replay path (F7): bypass the connectivity gate AND the
	// registry adapter — the scheduler already has the offline.* method and
	// the server-shaped payload from the outbox row. Going through the gate
	// risks re-enqueueing if connectivity flaps mid-drain (idempotency makes
	// duplicate POSTs safe, but state-machine churn is fragile).
	if (opts.bypassConnectivityForReplay) {
		const result = await liveFetch<T>(opts);
		emit({
			method: opts.method,
			intent: "write",
			offline: false,
			durationMs: nowMs() - startedAt,
			outcome: "ok",
			attempt,
		});
		return result;
	}

	// Generate idempotency key once — SAME id is used on an online-path
	// network_error retry (P-5). Writes that aren't offline-capable still
	// get a key so observability / server-side dedup works if the method
	// later opts in.
	const offlineId = opts.offlineIdempotencyKey ?? generateOfflineId();
	const argsWithKey: Record<string, unknown> = {
		...(opts.args ?? {}),
		offline_id: offlineId,
	};

	if (connectivity.isOnline()) {
		try {
			const result = await liveFetch<T>({ ...opts, args: argsWithKey });
			emit({
				method: opts.method,
				intent: "write",
				offline: false,
				durationMs: nowMs() - startedAt,
				outcome: "ok",
				attempt,
			});
			return result;
		} catch (err) {
			const classified = classifyFetchError(err);
			connectivity.reportRequestOutcome(classified);

			if (classified === "http_4xx") {
				// Validation error — caller must fix the payload. Never enqueue.
				emit({
					method: opts.method,
					intent: "write",
					offline: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}

			// network_error or 5xx — enqueue IF the method is offline-capable.
			// The server enforces idempotency on `offline_id`, so the eventual
			// retry is safe even if the original landed server-side (P-5).
			if (!config.offline) {
				emit({
					method: opts.method,
					intent: "write",
					offline: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}
			const ack = await enqueueWrite(opts, config, argsWithKey, offlineId);
			emit({
				method: opts.method,
				intent: "write",
				offline: false,
				durationMs: nowMs() - startedAt,
				outcome: "enqueued",
				attempt,
			});
			return ack as CallResult<T>;
		}
	}

	// Offline path
	if (!config.offline) {
		emit({
			method: opts.method,
			intent: "write",
			offline: true,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineWriteUnavailable(opts.method);
	}
	const ack = await enqueueWrite(opts, config, argsWithKey, offlineId);
	emit({
		method: opts.method,
		intent: "write",
		offline: true,
		durationMs: nowMs() - startedAt,
		outcome: "enqueued",
		attempt,
	});
	return ack as CallResult<T>;
}

async function enqueueWrite(
	opts: CallOptions,
	config: WriteMethodConfig,
	payload: Record<string, unknown>,
	offlineId: string,
): Promise<OutboxEnqueueAck> {
	const enqueue = getOutboxEnqueue();
	if (!enqueue) {
		throw new OfflineWriteUnavailable(opts.method);
	}
	if (!config.outboxType) {
		throw new MethodPolicyError(
			`Method "${opts.method}" is registered offline-capable but has no outboxType. ` +
				"Fix the registry entry.",
		);
	}

	// Resolve the offline shape via the registry's adapter. Without an
	// adapter, the live UI payload would be enqueued and later rejected by
	// the offline endpoint whose signature is (data, offline_id, device_id, …).
	let methodToPost = opts.method;
	let payloadToEnqueue = payload;
	let parentOfflineIds: string[] = [];
	let shiftOfflineId: string | null = null;
	let postingDate: string | undefined;
	let ownerUser: string | undefined;

	if (config.toOfflinePayload) {
		const adapted = config.toOfflinePayload(opts.args ?? {}, {
			offlineId,
			deviceId: getDeviceId(),
		});
		methodToPost = adapted.method;
		payloadToEnqueue = adapted.payload;
		parentOfflineIds = adapted.parentOfflineIds ?? [];
		shiftOfflineId = adapted.shiftOfflineId ?? null;
		postingDate = adapted.postingDate;
		ownerUser = adapted.ownerUser;
	} else {
		// Belt-and-braces: an offline-capable write without an adapter can't
		// produce a server-shaped payload. Fail loud rather than enqueue
		// garbage that the scheduler will only discover at drain time.
		throw new MethodPolicyError(
			`Method "${opts.method}" is offline-capable but missing toOfflinePayload. ` +
				"Add the adapter to the registry entry.",
		);
	}

	return enqueue(config.outboxType, payloadToEnqueue, {
		offlineIdempotencyKey: offlineId,
		method: methodToPost,
		outboxType: config.outboxType,
		parentOfflineIds,
		shiftOfflineId,
		postingDate,
		ownerUser,
	});
}

/**
 * Resolve the device's UUID. Stored at `pospire.device_id` by
 * `seedDeviceId()` inside `initOfflineStorage`. May be `null` if init never
 * ran (offline-disabled mode).
 */
function getDeviceId(): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem("pospire.device_id");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// frappe-ui glue
// ---------------------------------------------------------------------------

/**
 * Invoke frappe-ui's `call` with the right shape. On success, mark the
 * connectivity detector with a recent-success; classification of errors is
 * handled by the caller so read/write paths can apply their own policy.
 */
async function liveFetch<T>(opts: CallOptions): Promise<T> {
	// frappe-ui's `call` resolves to the response `message` body for 2xx,
	// and rejects with an object carrying HTTP details for non-2xx.
	// We don't try to unify that here — we just classify in classifyFetchError.
	// NOTE: abortSignal is accepted on the options but frappe-ui's call
	// signature is (method, args). AbortSignal wiring lands with Agent 3
	// once frappe-ui's request layer is replaced by a fetch-abortable client.
	const result = (await frappeUiCall(opts.method, opts.args ?? {})) as T;
	connectivity.reportRequestOutcome("success");
	return result;
}

/** Classify an error thrown by frappe-ui's `call`. */
function classifyFetchError(err: unknown): "network_error" | "http_4xx" | "http_5xx" {
	// frappe-ui rejects with various shapes — defensive parsing.
	if (!err || typeof err !== "object") return "network_error";
	const e = err as Record<string, unknown>;
	const statusCandidates = [e.status, e.statusCode, e.httpStatus];
	for (const s of statusCandidates) {
		if (typeof s === "number") {
			if (s >= 500 && s < 600) return "http_5xx";
			if (s >= 400 && s < 500) return "http_4xx";
		}
	}
	// `TypeError: Failed to fetch` etc. fall through to network_error.
	return "network_error";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeCacheRead<T>(
	cache: ReturnType<typeof getReadCache>,
	key: string,
): Promise<{ data: T; cachedAt: number } | null> {
	if (!cache) return null;
	try {
		const entry = await cache.read<T>(key);
		if (!entry) return null;
		return { data: entry.data, cachedAt: entry.cachedAt };
	} catch (err) {
		console.warn("[call] cache read failed", err);
		return null;
	}
}

function defaultCacheKey(method: string, args: Record<string, unknown> | undefined): string {
	if (!args) return method;
	try {
		return `${method}::${stableStringify(args)}`;
	} catch {
		return method;
	}
}

/** Stable-key stringify. Deterministic for plain JSON-like inputs. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

/** UUID v4 — browser-native when available, JS fallback otherwise. */
function generateOfflineId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// RFC-4122 v4 fallback.
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default call;
