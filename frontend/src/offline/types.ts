/**
 * Shared types for the offline storage layer.
 *
 * These types describe the Dexie row shapes and the small utility types
 * used by the encryption layer. Keep this module dependency-free so it can
 * be imported from repos, db, crypto, and (eventually) Pinia stores without
 * pulling Dexie into unrelated bundles.
 */

// ---------------------------------------------------------------------------
// Enums — string-literal unions so they survive across structured-clone /
// JSON and keep Dexie indexes simple.
// ---------------------------------------------------------------------------

export type ShiftStatus =
	| "open"
	| "closed_pending_sync"
	| "syncing"
	| "synced"
	| "reconciled"
	| "needs_review";

export type OutboxStatus =
	| "enqueued"
	| "in_flight"
	| "retry_pending"
	| "synced"
	| "needs_review"
	| "voided";

export type OutboxType =
	| "customer"
	| "material_receipt"
	| "invoice"
	| "return"
	| "payment"
	| "cash_movement"
	| "opening_entry"
	| "closing_entry";

export type OutboxBlockedReason =
	| "waiting_for_parent"
	| "waiting_for_siblings"
	| "integrity_mismatch"
	| "schema_mismatch"
	| null;

export type LastErrorCategory =
	| "network"
	| "auth"
	| "validation"
	| "conflict"
	| "server_error"
	| "integrity"
	| "schema"
	| "unknown"
	| null;

// ---------------------------------------------------------------------------
// Encryption envelope — how every encrypted blob is persisted.
// ---------------------------------------------------------------------------

/**
 * On-disk representation of an encrypted payload. We store the IV, ciphertext,
 * the SHA-256 of canonical-JSON plaintext (integrity guard), and the key-id
 * that produced the ciphertext so rotation (D-24) can decrypt with the right
 * key.
 *
 * AAD (additionalData) is NOT stored — the caller re-supplies it on decrypt
 * (typically the record's primary key / offline_id). Binding AAD prevents
 * ciphertext swapping between rows.
 */
export interface EncryptedEnvelope {
	iv: Uint8Array; // 12 random bytes
	ciphertext: Uint8Array; // AES-GCM ciphertext (includes 128-bit auth tag)
	payload_integrity_hash: string; // hex SHA-256 of canonical-JSON plaintext
	key_id: string; // id of the CryptoKey that encrypted this record
	alg: "AES-GCM-256";
	v: 1; // envelope schema version
}

// ---------------------------------------------------------------------------
// Rows — one per object store.
// ---------------------------------------------------------------------------

export interface ItemRow {
	item_code: string;
	item_name: string;
	item_group: string;
	/** Multi-entry indexed — any element satisfies a `where('barcodes')` query. */
	barcodes: string[];
	uom: string;
	standard_rate: number;
	/** Advisory only (P-13); keyed by warehouse name. */
	last_known_qty_by_warehouse: Record<string, number>;
	has_batch_no: boolean;
	has_serial_no: boolean;
	cached_at: number;
	/** Keyed by price-list name → rate. */
	price_list_prices: Record<string, number>;
}

/**
 * Customers are encrypted as a whole row (PII). At rest, the Dexie row holds
 * {name, _ciphertext}. The repo transparently wraps/unwraps so callers see
 * the plain shape below.
 */
export interface CustomerRow {
	/** May be `OFFLINE-CUST-<uuid8>` for offline-created rows. */
	name: string;
	customer_name: string;
	mobile_no: string | null;
	tax_id: string | null;
	customer_group: string | null;
	offline_created: boolean;
	offline_id: string | null;
	cached_at: number;
	email_id?: string | null;
	/** Optional loyalty/other extra fields sit here without needing schema bumps. */
	extra?: Record<string, unknown>;
}

/**
 * On-disk customer — encrypted envelope + the indexed columns we need to
 * query without decrypting. `customer_name`, `mobile_no`, `customer_group`
 * are kept plaintext as indexes so we can search without streaming the whole
 * table through decrypt. That's an acceptable leak per §6 (catalog-level
 * search; PII leakage is tax_id + addresses which stay encrypted).
 */
export interface StoredCustomerRow {
	name: string;
	mobile_no: string | null;
	customer_group: string | null;
	offline_created: boolean;
	cached_at: number;
	// Encrypted envelope holding the full CustomerRow:
	envelope: EncryptedEnvelope;
}

export interface ShiftRow {
	offline_id: string;
	device_id: string;
	cashier_user: string;
	pos_profile: Record<string, unknown>;
	/** Encrypted at rest (sensitive financial). */
	opening_cash_by_mop: Record<string, number>;
	opened_at: number;
	opening_server_name: string | null;
	/** Encrypted at rest. */
	closing_cash_by_mop: Record<string, number> | null;
	expected_closing_by_mop: Record<string, number> | null;
	variance_at_close: { by_mop: Record<string, number>; total: number } | null;
	variance_at_sync: { by_mop: Record<string, number>; total: number } | null;
	/** Encrypted at rest. */
	closing_notes: string | null;
	closed_at: number | null;
	closing_server_name: string | null;
	status: ShiftStatus;
	manager_approval_required: boolean;
}

/**
 * On-disk shift. Unencrypted scalar fields stay plain for indexing and quick
 * status reads; the three sensitive fields are envelope-wrapped and stored
 * as siblings. Repo layer hydrates/dehydrates transparently.
 */
export interface StoredShiftRow {
	offline_id: string;
	device_id: string;
	cashier_user: string;
	pos_profile: Record<string, unknown>;
	opened_at: number;
	opening_server_name: string | null;
	expected_closing_by_mop: Record<string, number> | null;
	variance_at_close: { by_mop: Record<string, number>; total: number } | null;
	variance_at_sync: { by_mop: Record<string, number>; total: number } | null;
	closed_at: number | null;
	closing_server_name: string | null;
	status: ShiftStatus;
	manager_approval_required: boolean;
	// Encrypted siblings — may be null when the shift is still open.
	opening_cash_envelope: EncryptedEnvelope | null;
	closing_cash_envelope: EncryptedEnvelope | null;
	closing_notes_envelope: EncryptedEnvelope | null;
}

export interface OutboxEntry<TPayload = unknown> {
	offline_id: string;
	type: OutboxType;
	parent_offline_ids: string[];
	shift_offline_id: string | null;
	device_id: string;
	posting_date: string;
	owner_user: string;
	/** In-memory (post-decrypt) shape. On disk this is the envelope. */
	payload: TPayload;
	payload_integrity_hash: string;
	status: OutboxStatus;
	blocked_reason: OutboxBlockedReason;
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_category: LastErrorCategory;
	last_error_detail: string | null;
	server_doc_name: string | null;
	enqueued_at: number;
	synced_at: number | null;
}

/** On-disk outbox row — payload replaced by envelope. */
export interface StoredOutboxEntry {
	offline_id: string;
	type: OutboxType;
	parent_offline_ids: string[];
	shift_offline_id: string | null;
	device_id: string;
	posting_date: string;
	owner_user: string;
	envelope: EncryptedEnvelope;
	payload_integrity_hash: string;
	status: OutboxStatus;
	blocked_reason: OutboxBlockedReason;
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_category: LastErrorCategory;
	last_error_detail: string | null;
	server_doc_name: string | null;
	enqueued_at: number;
	synced_at: number | null;
}

export interface MetadataRow<V = unknown> {
	key: string;
	value: V;
	updated_at: number;
}

export interface HealthProbeRow {
	id: "probe";
	nonce: string;
	written_at: number;
}

/** Shadow-journal row — append-only second DB, for corruption recovery §8.1. */
export interface JournalRow {
	id?: number; // auto-incrementing
	ts: number;
	type: "outbox_put" | "shift_put" | "outbox_status_change";
	offline_id: string | null;
	/**
	 * Opaque blob copy of the primary row (already-encrypted envelopes for
	 * sensitive rows — we do NOT re-encrypt or decrypt; we mirror what the
	 * primary store wrote). Keeps the journal cheap and avoids a second key.
	 */
	snapshot: unknown;
}
