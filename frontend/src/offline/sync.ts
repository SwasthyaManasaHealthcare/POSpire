/**
 * Sync scheduler (Agent 3).
 *
 * Owns the drain loop that empties the outbox into the server, one entry at
 * a time, in dependency order. Leader-gated across tabs via the Web Locks
 * API (D-26) with a Dexie-lease fallback for older browsers. Pauses on
 * connectivity transitions, resumes on reconnect, and stops cleanly when
 * `Pos.vue` unmounts.
 *
 * Principles (see 01-architecture-principles.md):
 *   P-6:  one scheduler per device at a time. The exported singleton is
 *         intended to be `.start()`-ed from `Pos.vue` onMounted; until
 *         Phase 2 adds the component, we start at module import and never
 *         stop. Documented as a deviation below.
 *   P-7:  dependency ordered — `evaluateParents` + `evaluateClosingReadiness`
 *         gate every send.
 *   P-14: failures propagate. The scheduler classifies error categories and
 *         commits the outcome to Dexie before moving on.
 *
 * Observability: per-cycle summary appended to `metadata.sync_log`, capped
 * at 1,000 entries (05-outbox-and-sync.md §8). Uploaded to the server via
 * `pospire.pospire.api.offline.log_batch` on reconnect (wired from the
 * connectivity module's log flush; here we just append).
 */

import { connectivity, type ConnectivityState } from "./connectivity";
import { db } from "./db";
import {
	assertOfflineEnabled,
	isOfflineEnabled,
	OfflineDisabledError,
} from "./kill-switch";
import {
	evaluateClosingReadiness,
	evaluateParents,
	getEntry,
	markBlocked,
	markInFlight,
	markIntegrityMismatch,
	markNeedsReview,
	markSynced,
	nextReady,
	onEnqueue,
	resolvePayload,
	scheduleRetry,
	verifyIntegrity,
	MAX_ATTEMPTS,
} from "./outbox";
import { call } from "@/utils/call";
import type {
	LastErrorCategory,
	OutboxEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Web Lock name used for leader election. */
const LEADER_LOCK_NAME = "pospire-sync";
/** BroadcastChannel for cross-tab UI state (queue depth, etc). */
const BROADCAST_CHANNEL_NAME = "pospire-offline";

/** Dexie-lease fallback (D-26) for browsers without Web Locks. */
const LEASE_META_KEY = "scheduler.leader_lease";
const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_EXPIRY_MS = 15_000;

/** Cycle log cap (05-outbox-and-sync.md §8). */
const SYNC_LOG_META_KEY = "sync_log";
const SYNC_LOG_CAP = 1_000;

/** Default wake interval when no entry is due but we have queued work. */
const DEFAULT_WAKE_MS = 1_000;
/** Longer wake when the queue is fully drained. */
const IDLE_WAKE_MS = 30_000;

// ---------------------------------------------------------------------------
// Cycle log
// ---------------------------------------------------------------------------

export interface SyncCycleLog {
	cycle_id: string;
	started_at: number;
	finished_at: number;
	queue_depth_start: number;
	drained: number;
	moved_to_needs_review: Record<string, number>;
	longest_latency_ms: number;
	next_wake_ms: number | null;
	leader: boolean;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class SyncScheduler {
	private running = false;
	private leader = false;
	private loopPromise: Promise<void> | null = null;
	private abort = new AbortController();
	private wakeResolver: (() => void) | null = null;
	/** Set when `kick()` fires before `waitForWake` is armed. */
	private pendingKick = false;
	private connectivityUnsub: (() => void) | null = null;
	private enqueueUnsub: (() => void) | null = null;
	private broadcastChannel: BroadcastChannel | null = null;
	private leaseHeartbeatHandle: ReturnType<typeof setInterval> | null = null;
	private usingLeaseFallback = false;
	private leaseOwnerId = "";
	/** Resolved when the caller's `start()` successfully becomes leader. */
	private leaderAcquired: Promise<void> | null = null;

	/**
	 * Start the scheduler. Acquires the leader lock and begins the drain loop.
	 * Idempotent. Phase 2 will call this from `Pos.vue` onMounted.
	 */
	async start(): Promise<void> {
		if (this.running) return this.leaderAcquired ?? Promise.resolve();
		this.running = true;

		this.connectivityUnsub = connectivity.onChange((s) =>
			this.handleConnectivity(s),
		);
		this.enqueueUnsub = onEnqueue(() => this.kick());

		// Leader election — Web Locks preferred; Dexie-lease fallback.
		if (
			typeof navigator !== "undefined" &&
			typeof navigator.locks !== "undefined" &&
			typeof navigator.locks.request === "function"
		) {
			this.leaderAcquired = this.acquireWebLock();
		} else {
			this.leaderAcquired = this.acquireLease();
		}

		if (typeof BroadcastChannel !== "undefined") {
			this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
		}

		return this.leaderAcquired;
	}

	/**
	 * Stop the scheduler. Releases the leader lock, cancels timers, and
	 * aborts the in-flight fetch (if any).
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.leader = false;
		this.abort.abort();
		this.abort = new AbortController();

		this.connectivityUnsub?.();
		this.connectivityUnsub = null;
		this.enqueueUnsub?.();
		this.enqueueUnsub = null;

		if (this.leaseHeartbeatHandle) {
			clearInterval(this.leaseHeartbeatHandle);
			this.leaseHeartbeatHandle = null;
		}
		if (this.usingLeaseFallback) {
			await this.releaseLease().catch(() => {
				/* best-effort */
			});
			this.usingLeaseFallback = false;
		}

		if (this.broadcastChannel) {
			this.broadcastChannel.close();
			this.broadcastChannel = null;
		}

		// Let any waiter on `kick()` resolve and drop out of the loop.
		this.pendingKick = true;
		this.resolveWake();
		// Await loop termination so callers can confidently re-start if
		// they want to.
		if (this.loopPromise) {
			await this.loopPromise.catch(() => {
				/* already handled inside */
			});
			this.loopPromise = null;
		}
	}

	/** Wake the drain loop. Called on connectivity change / new enqueue. */
	kick(): void {
		this.resolveWake();
	}

	/** Snapshot for the banner / debug UI. */
	status(): { running: boolean; leader: boolean } {
		return { running: this.running, leader: this.leader };
	}

	// -------------------------------------------------------------------
	// Leader election
	// -------------------------------------------------------------------

	private async acquireWebLock(): Promise<void> {
		// `navigator.locks.request` resolves when the callback returns; the
		// callback is what holds the lock. We hold the lock for as long as
		// the scheduler is running.
		return new Promise<void>((resolvePromise) => {
			navigator.locks
				.request(
					LEADER_LOCK_NAME,
					{ mode: "exclusive" },
					async () => {
						this.leader = true;
						resolvePromise();
						// Start / continue the drain loop under the lock.
						this.loopPromise = this.drainLoop();
						try {
							await this.loopPromise;
						} finally {
							this.leader = false;
							this.loopPromise = null;
						}
					},
				)
				.catch((err) => {
					// Request rejected — e.g. document is frozen. Fall back to
					// a lease so at least one tab keeps draining.
					console.warn(
						"[sync] Web Lock rejected, falling back to Dexie lease",
						err,
					);
					this.acquireLease().then(resolvePromise).catch(() => {
						resolvePromise();
					});
				});
		});
	}

	private async acquireLease(): Promise<void> {
		this.usingLeaseFallback = true;
		this.leaseOwnerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		const tryAcquire = async (): Promise<boolean> => {
			return db.transaction("rw", db.metadata, async () => {
				const existing = await db.metadata.get(LEASE_META_KEY);
				const now = Date.now();
				const stale =
					!existing ||
					typeof existing.value !== "object" ||
					existing.value === null ||
					(existing.value as { heartbeat_at?: number }).heartbeat_at === undefined ||
					now -
						((existing.value as { heartbeat_at?: number })
							.heartbeat_at ?? 0) >
						LEASE_EXPIRY_MS;
				if (!stale) return false;
				await db.metadata.put({
					key: LEASE_META_KEY,
					value: {
						owner_id: this.leaseOwnerId,
						heartbeat_at: now,
					},
					updated_at: now,
				});
				return true;
			});
		};

		// Poll until we win.
		while (this.running) {
			const won = await tryAcquire();
			if (won) break;
			await sleep(LEASE_HEARTBEAT_MS);
		}
		if (!this.running) return;

		this.leader = true;

		// Heartbeat so other tabs see us as alive.
		this.leaseHeartbeatHandle = setInterval(() => {
			void this.heartbeatLease();
		}, LEASE_HEARTBEAT_MS);

		this.loopPromise = this.drainLoop();
		this.loopPromise
			.catch((err) => {
				console.error("[sync] drain loop crashed", err);
			})
			.finally(() => {
				this.leader = false;
				this.loopPromise = null;
			});
	}

	private async heartbeatLease(): Promise<void> {
		if (!this.running || !this.leader) return;
		await db
			.transaction("rw", db.metadata, async () => {
				const existing = await db.metadata.get(LEASE_META_KEY);
				if (
					!existing ||
					typeof existing.value !== "object" ||
					existing.value === null
				) {
					return;
				}
				const value = existing.value as {
					owner_id?: string;
					heartbeat_at?: number;
				};
				if (value.owner_id !== this.leaseOwnerId) {
					// We were preempted. Surrender leadership.
					this.leader = false;
					this.resolveWake();
					return;
				}
				await db.metadata.put({
					key: LEASE_META_KEY,
					value: {
						owner_id: this.leaseOwnerId,
						heartbeat_at: Date.now(),
					},
					updated_at: Date.now(),
				});
			})
			.catch(() => {
				/* lease write fails are transient; next heartbeat will retry */
			});
	}

	private async releaseLease(): Promise<void> {
		await db.transaction("rw", db.metadata, async () => {
			const existing = await db.metadata.get(LEASE_META_KEY);
			if (
				existing &&
				typeof existing.value === "object" &&
				existing.value !== null &&
				(existing.value as { owner_id?: string }).owner_id ===
					this.leaseOwnerId
			) {
				await db.metadata.delete(LEASE_META_KEY);
			}
		});
	}

	// -------------------------------------------------------------------
	// Drain loop
	// -------------------------------------------------------------------

	private async drainLoop(): Promise<void> {
		while (this.running && this.leader) {
			const cycle = this.beginCycle();

			// Pause while offline or kill-switched.
			if (!connectivity.isOnline()) {
				cycle.next_wake_ms = null;
				await this.finishCycle(cycle);
				await this.waitForOnline();
				continue;
			}

			let killed = false;
			try {
				killed = !(await isOfflineEnabled());
			} catch {
				killed = false;
			}
			if (killed) {
				cycle.next_wake_ms = null;
				await this.finishCycle(cycle);
				await sleep(IDLE_WAKE_MS);
				continue;
			}

			const entry = await nextReady<Record<string, unknown>>();
			if (!entry) {
				cycle.next_wake_ms = IDLE_WAKE_MS;
				await this.finishCycle(cycle);
				await this.waitForWake(IDLE_WAKE_MS);
				continue;
			}

			// Dependency / closure gating.
			const gate = await this.checkGate(entry);
			if (gate === "waiting") {
				// Nudge next_attempt_at forward so we re-check soon without
				// busy-looping.
				await scheduleRetry(
					entry.offline_id,
					entry.attempt_count,
					"network_error",
					"waiting_for_siblings",
				);
				cycle.next_wake_ms = DEFAULT_WAKE_MS;
				await this.finishCycle(cycle);
				await this.waitForWake(DEFAULT_WAKE_MS);
				continue;
			}
			if (gate === "blocked") {
				await markBlocked(
					entry.offline_id,
					entry.type === "closing_entry"
						? "waiting_for_siblings"
						: "waiting_for_parent",
				);
				cycle.next_wake_ms = DEFAULT_WAKE_MS;
				await this.finishCycle(cycle);
				// Try the next entry immediately — this one is parked until a
				// parent resolves.
				await this.yieldToEventLoop();
				continue;
			}

			// Integrity check before claim.
			const integrity = await verifyIntegrity(entry);
			if (!integrity.ok) {
				await markIntegrityMismatch(entry.offline_id, integrity.detail);
				cycle.drained += 1;
				cycle.moved_to_needs_review["integrity_mismatch"] =
					(cycle.moved_to_needs_review["integrity_mismatch"] ?? 0) + 1;
				await this.finishCycle(cycle);
				await this.yieldToEventLoop();
				continue;
			}

			// Claim (compare-and-swap). If we lose the race (another tab
			// somehow beat us to it), move on.
			const claimed = await markInFlight(entry.offline_id);
			if (!claimed) {
				await this.yieldToEventLoop();
				continue;
			}

			const sendStart = performance.now();
			try {
				const result = await this.sendEntry(entry);
				const latency = performance.now() - sendStart;
				cycle.longest_latency_ms = Math.max(
					cycle.longest_latency_ms,
					latency,
				);
				cycle.drained += 1;

				if (result.kind === "synced") {
					await markSynced(entry.offline_id, result.serverDocName);
					// Any entries blocked on this row are now unblocked; the
					// next drain tick picks them up. We don't explicitly
					// unblock here to avoid a scan on every send — the next
					// `evaluateParents` call will resolve them.
				} else if (result.kind === "retry") {
					await scheduleRetry(
						entry.offline_id,
						entry.attempt_count + 1,
						result.category,
						result.detail,
					);
				} else {
					await markNeedsReview(
						entry.offline_id,
						result.category,
						result.detail,
					);
					cycle.moved_to_needs_review[result.category] =
						(cycle.moved_to_needs_review[result.category] ?? 0) + 1;
				}
			} catch (err) {
				// Unexpected error inside the send pipeline — treat as
				// transient so we don't drop the row.
				const detail = err instanceof Error ? err.message : String(err);
				await scheduleRetry(
					entry.offline_id,
					entry.attempt_count + 1,
					"network_error",
					detail,
				);
			}

			await this.finishCycle(cycle);
			// Yield so the UI thread can paint between entries
			// (05-outbox-and-sync.md §4.2).
			await this.yieldToEventLoop();
		}
	}

	private async checkGate(
		entry: OutboxEntry<unknown>,
	): Promise<"ready" | "waiting" | "blocked"> {
		const parent = await evaluateParents(entry);
		if (parent !== "ready") return parent;
		// Strict closure for closing_entry.
		if (entry.type === "closing_entry") {
			const closure = await evaluateClosingReadiness(entry);
			if (closure !== "ready") return closure;
		}
		return "ready";
	}

	// -------------------------------------------------------------------
	// Send pipeline
	// -------------------------------------------------------------------

	private async sendEntry(
		entry: OutboxEntry<Record<string, unknown>>,
	): Promise<SendResult> {
		const method = methodForEntry(entry);
		if (!method) {
			return {
				kind: "needsReview",
				category: "schema_mismatch",
				detail: `No server method registered for outbox type "${entry.type}"`,
			};
		}

		const resolvedPayload = (await resolvePayload(entry)) as Record<
			string,
			unknown
		>;

		// Defensive: ensure posting_date + owner_user are inside the inner
		// `data` JSON so the server's _apply_payload_metadata accepts the
		// request. The adapter normally puts them there at enqueue time, but
		// (a) older queued rows pre-dating the adapter fix may not have them,
		// and (b) the outbox stores authoritative posting_date / owner_user
		// snapshots at the entry level — we prefer the entry's snapshot over
		// any value left over from cart-time defaults.
		const replayPayload = patchInnerDataMetadata(
			resolvedPayload,
			entry.posting_date,
			entry.owner_user,
		);

		try {
			// F7: bypass call()'s online/offline gate. The scheduler has
			// already (a) checked connectivity at drain-loop scope, (b) carries
			// a resolved offline.* method, and (c) has a server-shaped payload
			// from the outbox row. Re-entering call()'s normal flow would risk
			// re-enqueueing if connectivity flips during the send.
			const res = (await call({
				method,
				args: {
					...replayPayload,
					offline_id: entry.offline_id,
					device_id: entry.device_id,
				},
				intent: "write",
				offlineIdempotencyKey: entry.offline_id,
				bypassConnectivityForReplay: true,
			})) as {
				name?: string;
				server_doc_name?: string;
				was_already_submitted?: boolean;
				docstatus?: number;
				is_background_job?: boolean;
			};

			// F6: refuse to mark "synced" if the server response represents a
			// not-yet-final state. posapp.submit_invoice can return a draft
			// (docstatus !== 1) when posa_allow_submissions_in_background_job
			// is on; treating that as synced hides any later background-job
			// failure. Idempotency makes a retry safe — the next POST returns
			// the same name and (eventually) docstatus=1.
			const docstatus = typeof res.docstatus === "number" ? res.docstatus : null;
			if (
				docstatus !== null &&
				docstatus !== 1 &&
				docstatus !== 2 // 2 = cancelled, also a settled terminal state
			) {
				return {
					kind: "retry",
					category: "server_5xx", // closest transient bucket; backoff applies
					detail: `server returned docstatus=${docstatus}` +
						(res.is_background_job ? " (background_job)" : ""),
				};
			}

			// 2xx with terminal docstatus (or no docstatus reported) → synced.
			const docName =
				res.server_doc_name ?? res.name ?? entry.server_doc_name;
			if (!docName) {
				return {
					kind: "needsReview",
					category: "validation_error",
					detail: "server returned 2xx but no doc name",
				};
			}
			return { kind: "synced", serverDocName: docName };
		} catch (err) {
			if (err instanceof OfflineDisabledError) {
				// Kill switch flipped mid-send. Requeue as retry.
				return {
					kind: "retry",
					category: "network_error",
					detail: "kill switch flipped during send",
				};
			}
			return classifySendError(err, entry.attempt_count, entry);
		}
	}

	// -------------------------------------------------------------------
	// Connectivity integration
	// -------------------------------------------------------------------

	private handleConnectivity(s: ConnectivityState): void {
		if (s.status === "online" || s.status === "degraded") {
			this.kick();
		}
		// We don't cancel mid-send on offline — the inflight fetch either
		// errors out via `TypeError: Failed to fetch` (classified as
		// network_error) or succeeds. Aborting mid-fetch adds more edge
		// cases than it prevents.
	}

	private async waitForOnline(): Promise<void> {
		if (connectivity.isOnline()) return;
		await new Promise<void>((resolve) => {
			const unsub = connectivity.onChange((s) => {
				if (s.status === "online" || s.status === "degraded") {
					unsub();
					resolve();
				}
			});
			// Safety: if scheduler stops while we wait, resolve anyway.
			const stopCheck = setInterval(() => {
				if (!this.running) {
					clearInterval(stopCheck);
					unsub();
					resolve();
				}
			}, 500);
		});
	}

	// -------------------------------------------------------------------
	// Wake primitive — either a timeout or a `kick()` resolves.
	// -------------------------------------------------------------------

	private waitForWake(timeoutMs: number): Promise<void> {
		// If a kick landed between loop iterations, consume it and return
		// immediately so we don't miss the signal.
		if (this.pendingKick) {
			this.pendingKick = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				this.wakeResolver = null;
				clearTimeout(t);
				resolve();
			};
			const t = setTimeout(done, timeoutMs);
			this.wakeResolver = done;
		});
	}

	private resolveWake(): void {
		const r = this.wakeResolver;
		if (r) {
			this.wakeResolver = null;
			r();
		} else {
			// No one is waiting yet; remember the kick so the next
			// `waitForWake` consumes it.
			this.pendingKick = true;
		}
	}

	private yieldToEventLoop(): Promise<void> {
		return new Promise((r) => setTimeout(r, 0));
	}

	// -------------------------------------------------------------------
	// Cycle logging
	// -------------------------------------------------------------------

	private beginCycle(): SyncCycleLog {
		return {
			cycle_id: cryptoRandomId(),
			started_at: Date.now(),
			finished_at: 0,
			queue_depth_start: 0,
			drained: 0,
			moved_to_needs_review: {},
			longest_latency_ms: 0,
			next_wake_ms: DEFAULT_WAKE_MS,
			leader: this.leader,
		};
	}

	private async finishCycle(cycle: SyncCycleLog): Promise<void> {
		cycle.finished_at = Date.now();
		try {
			cycle.queue_depth_start = await db.outbox
				.where("status")
				.anyOf(["enqueued", "in_flight", "retry_pending"])
				.count();
		} catch {
			cycle.queue_depth_start = -1;
		}
		await appendSyncLog(cycle);
		this.publishStateToPeers(cycle);
	}

	/** Compute the scheduler's current phase for peer broadcast. */
	private currentPhase(draining: boolean): "idle" | "draining" | "paused" {
		if (!this.running) return "idle";
		if (draining) return "draining";
		// Running but no active cycle — non-leader, kill-switched, or offline
		// → "paused". Leader idling between cycles → "idle".
		if (!this.leader) return "paused";
		return "idle";
	}

	private publishStateToPeers(cycle: SyncCycleLog | null, draining = false): void {
		if (!this.broadcastChannel) return;
		try {
			this.broadcastChannel.postMessage({
				kind: "sync_state",
				phase: this.currentPhase(draining),
				leader: this.leader,
				queue_depth: cycle?.queue_depth_start ?? null,
				drained: cycle?.drained ?? 0,
				needs_review: cycle
					? Object.values(cycle.moved_to_needs_review).reduce((a, b) => a + b, 0)
					: 0,
				at: cycle?.finished_at ?? Date.now(),
			});
		} catch {
			/* channel closed / post failed — not fatal */
		}
	}
}

// ---------------------------------------------------------------------------
// Send result discriminator
// ---------------------------------------------------------------------------

type SendResult =
	| { kind: "synced"; serverDocName: string }
	| {
			kind: "retry";
			category: NonNullable<LastErrorCategory>;
			detail: string | null;
	  }
	| {
			kind: "needsReview";
			category: NonNullable<LastErrorCategory>;
			detail: string | null;
	  };

// ---------------------------------------------------------------------------
// Method resolution — maps outbox type → server endpoint.
// ---------------------------------------------------------------------------

function methodForEntry(entry: OutboxEntry<unknown>): string | null {
	switch (entry.type) {
		case "customer":
			return "pospire.pospire.api.offline.create_customer";
		case "material_receipt":
			return "pospire.pospire.api.offline.create_material_receipt";
		case "invoice":
			return "pospire.pospire.api.offline.submit_invoice";
		case "opening_entry":
			return "pospire.pospire.api.offline.create_opening_entry";
		case "closing_entry":
			return "pospire.pospire.api.offline.create_closing_entry";
		case "return":
			// TODO(agent-6): `create_return` endpoint not implemented server-
			// side yet. D-30 puts returns in scope. The client wiring here is
			// correct; expect 404 until Agent 6 ships the endpoint, at which
			// point retries succeed without code change.
			return "pospire.pospire.api.offline.create_return";
		case "payment":
			// Payment entries go through the online payment pipeline in v1;
			// offline payment enqueue is not wired.
			return null;
		case "cash_movement":
			return null;
	}
}

// ---------------------------------------------------------------------------
// Error classification — maps thrown errors to SendResult categories.
// ---------------------------------------------------------------------------

function classifySendError(
	err: unknown,
	attemptCount: number,
	entry?: { server_doc_name: string | null },
): SendResult {
	// frappe-ui rejections + our own wrappers all end up here. We pull
	// `status`, `error_code`, and a few common shapes.
	const detail = err instanceof Error ? err.message : String(err);
	const status = extractStatus(err);
	const errorCode = extractErrorCode(err);

	// Idempotent duplicate — the server already accepted this offline_id on a
	// prior attempt. Mark synced (not retry): semantically this IS success
	// (P-5). Use the doc name from the error envelope, or the one we stored
	// from a prior attempt. If neither is available, fall through to retry
	// so a fresh POST gets us a 2xx with the canonical name.
	if (errorCode === "was_already_submitted") {
		const docName = extractServerDocName(err) ?? entry?.server_doc_name ?? null;
		if (docName) {
			return { kind: "synced", serverDocName: docName };
		}
		return {
			kind: "retry",
			category: "idempotent_duplicate",
			detail: "was_already_submitted but no doc name in envelope",
		};
	}

	if (typeof status === "number") {
		if (status === 426) {
			return {
				kind: "needsReview",
				category: "schema_mismatch",
				detail,
			};
		}
		if (status === 400 || status === 417) {
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "validation_error"),
				detail,
			};
		}
		if (status === 403) {
			return { kind: "needsReview", category: "permission_error", detail };
		}
		if (status === 404) {
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "customer_missing"),
				detail,
			};
		}
		if (status === 409) {
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "batch_or_serial_conflict"),
				detail,
			};
		}
		if (status >= 500 && status < 600) {
			if (attemptCount + 1 >= MAX_ATTEMPTS) {
				return { kind: "needsReview", category: "retry_exhausted", detail };
			}
			return { kind: "retry", category: "server_5xx", detail };
		}
		if (status >= 400 && status < 500) {
			return { kind: "needsReview", category: "validation_error", detail };
		}
	}

	// Treat unclassifiable / network-shaped errors as retryable.
	if (attemptCount + 1 >= MAX_ATTEMPTS) {
		return { kind: "needsReview", category: "retry_exhausted", detail };
	}
	if (isTimeoutLike(err)) {
		return { kind: "retry", category: "timeout", detail };
	}
	return { kind: "retry", category: "network_error", detail };
}

/**
 * Defensively patches posting_date + owner_user into the inner `data` JSON
 * so the server's `_apply_payload_metadata` (P-5, P-11) accepts the request
 * even if the adapter at enqueue time forgot them, or the outbox row was
 * created before the adapters were fixed.
 */
function patchInnerDataMetadata(
	payload: Record<string, unknown>,
	postingDate: string | null | undefined,
	ownerUser: string | null | undefined,
): Record<string, unknown> {
	const dataField = payload.data;
	if (typeof dataField !== "string") return payload;
	let inner: Record<string, unknown>;
	try {
		const parsed = JSON.parse(dataField);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return payload;
		}
		inner = parsed as Record<string, unknown>;
	} catch {
		return payload; // not JSON — leave alone
	}
	let mutated = false;
	if (!inner.posting_date && postingDate) {
		inner.posting_date = postingDate;
		mutated = true;
	}
	if (!inner.owner_user && !inner.owner && ownerUser) {
		inner.owner_user = ownerUser;
		mutated = true;
	}
	if (!mutated) return payload;
	return { ...payload, data: JSON.stringify(inner) };
}

/**
 * Pulls a server doc name out of an error envelope, if present. Frappe's
 * error shapes vary; we probe the common locations.
 */
function extractServerDocName(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["server_doc_name", "name", "doc_name"]) {
		const v = e[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const details = e["details"] as Record<string, unknown> | undefined;
	if (details) {
		for (const k of ["server_doc_name", "name", "doc_name"]) {
			const v = details[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	return undefined;
}

function extractStatus(err: unknown): number | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["status", "statusCode", "httpStatus"]) {
		const v = e[k];
		if (typeof v === "number") return v;
	}
	return undefined;
}

function extractErrorCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["error_code", "code", "exc_type"]) {
		const v = e[k];
		if (typeof v === "string") return v;
	}
	// Frappe commonly wraps in `messages[0].error_code` or `_server_messages`.
	const msgs = e["messages"];
	if (Array.isArray(msgs) && msgs.length > 0) {
		const first = msgs[0] as Record<string, unknown>;
		if (typeof first?.error_code === "string") return first.error_code;
	}
	return undefined;
}

function errorCodeToCategory(
	errorCode: string | undefined,
	fallback: LastErrorCategory,
): LastErrorCategory {
	if (!errorCode) return fallback;
	// Code names chosen to match 12-server-side-changes.md §5.
	switch (errorCode) {
		case "customer_missing":
			return "customer_missing";
		case "batch_conflict":
		case "serial_conflict":
		case "batch_or_serial_conflict":
			return "batch_or_serial_conflict";
		case "stock_shortage":
			return "stock_shortage";
		case "accounting_period_closed":
			return "accounting_period_closed";
		case "schema_mismatch":
			return "schema_mismatch";
		case "validation_error":
			return "validation_error";
		case "permission_error":
			return "permission_error";
		default:
			return fallback;
	}
}

function isTimeoutLike(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as Record<string, unknown>;
	const name = typeof e.name === "string" ? e.name : "";
	return name === "AbortError" || name === "TimeoutError";
}

// ---------------------------------------------------------------------------
// metadata.sync_log — cycle log persistence
// ---------------------------------------------------------------------------

async function appendSyncLog(entry: SyncCycleLog): Promise<void> {
	try {
		await db.transaction("rw", db.metadata, async () => {
			const row = await db.metadata.get(SYNC_LOG_META_KEY);
			const list = Array.isArray(row?.value)
				? (row.value as SyncCycleLog[])
				: [];
			list.push(entry);
			while (list.length > SYNC_LOG_CAP) list.shift();
			await db.metadata.put({
				key: SYNC_LOG_META_KEY,
				value: list,
				updated_at: Date.now(),
			});
		});
	} catch {
		// Logging must never take down the drain. Swallow here (NOT on the
		// send path).
	}
}

/** Drain the sync log for upload via `log_batch`. Clears on read. */
export async function drainSyncLog(): Promise<SyncCycleLog[]> {
	return db.transaction("rw", db.metadata, async () => {
		const row = await db.metadata.get(SYNC_LOG_META_KEY);
		const list = Array.isArray(row?.value)
			? (row.value as SyncCycleLog[])
			: [];
		await db.metadata.put({
			key: SYNC_LOG_META_KEY,
			value: [],
			updated_at: Date.now(),
		});
		return list;
	});
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function cryptoRandomId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Re-export helper for the peek UI (optional).
// ---------------------------------------------------------------------------

export async function getEntryByOfflineId(
	offlineId: string,
): Promise<OutboxEntry<unknown> | undefined> {
	return getEntry(offlineId);
}

// ---------------------------------------------------------------------------
// Singleton — ONE scheduler per device.
//
// PHASE 2 HANDOFF: `Pos.vue` will own `scheduler.start()` / `scheduler.stop()`
// in its `onMounted` / `onUnmounted` hooks (P-6). During Phase 1 there is no
// component to own that lifecycle; the only caller is `main.js`-level code
// that imports this module. We intentionally do NOT auto-start on import so
// tests / Storybook / node harnesses can import without spinning up a drain
// loop against a mock DB. The Phase 2 task is to:
//
//   import { scheduler } from "@/offline/sync";
//   onMounted(() => { scheduler.start() });
//   onUnmounted(() => { scheduler.stop() });
//
// Until then, non-pos bootstrap code should call `scheduler.start()` once
// from its equivalent root (e.g. the Vuetify root mount in `main.js`).
// ---------------------------------------------------------------------------

export const scheduler = new SyncScheduler();

export default scheduler;

// Re-export error for banner convenience.
export { OfflineDisabledError };

/**
 * Trigger assertion at module init so the kill-switch module gets a chance
 * to cache an initial value before the first enqueue. Fire-and-forget — any
 * failure is tolerated by the kill-switch module's own defaults.
 */
void assertOfflineEnabled().catch(() => {
	/* default is enabled; nothing to do */
});
