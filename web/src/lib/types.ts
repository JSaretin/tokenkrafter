/**
 * Shared TypeScript types for Supabase rows, API envelopes, and wallet state.
 *
 * Hand-written to match supabase/schema.sql — keep the two in sync when
 * adding/removing columns. We prefer hand-written over `supabase gen types`
 * for now because (a) it avoids a build step, (b) the schema is small enough
 * to track manually, and (c) we can document the fields inline.
 *
 * When a field is `string | null`, that means the DB column is nullable.
 * When a field is `string` only, the column is NOT NULL.
 *
 * Numeric columns stored as `numeric(20,6)` come back as strings from PostgREST
 * by default, so they're typed as `string` here — parse to `number`/`bigint`
 * at the call site if you need arithmetic.
 */

// ── Shared primitives ────────────────────────────────────────────────────

/** Ethereum-style hex address, lowercased. Use `ethers.getAddress()` before
 *  displaying if you want checksum casing. */
export type Address = string;

/** A bigint stored as a decimal string (PostgREST returns bigints as strings). */
export type DecimalString = string;

/** ISO-8601 timestamp from `timestamptz` columns. */
export type Timestamp = string;

// ── created_tokens ───────────────────────────────────────────────────────

export interface CreatedToken {
	id: number;
	address: Address;
	chain_id: number;
	creator: Address;
	name: string;
	symbol: string;
	decimals: number;
	/** Snapshot of totalSupply at daemon index time. "0" for pre-save rows. */
	total_supply: DecimalString;
	is_taxable: boolean;
	is_mintable: boolean;
	is_partner: boolean;
	logo_url: string | null;
	description: string | null;
	website: string | null;
	twitter: string | null;
	telegram: string | null;
	created_at: Timestamp;
}

// ── launches ─────────────────────────────────────────────────────────────

export type LaunchState = 0 | 1 | 2 | 3; // Pending | Active | Graduated | Refunding
export type CurveType = 0 | 1 | 2 | 3;   // Linear | SquareRoot | Quadratic | Exponential

export interface LaunchRow {
	id: number;
	address: Address;
	chain_id: number;
	token_address: Address;
	creator: Address;
	curve_type: CurveType;
	state: LaunchState;
	soft_cap: DecimalString;
	hard_cap: DecimalString;
	total_base_raised: DecimalString;
	tokens_sold: DecimalString;
	tokens_for_curve: DecimalString;
	tokens_for_lp: DecimalString;
	creator_allocation_bps: number;
	current_price: DecimalString;
	deadline: number;
	start_timestamp: number;
	total_tokens_required: DecimalString;
	total_tokens_deposited: DecimalString;
	is_partner: boolean;
	token_name: string | null;
	token_symbol: string | null;
	token_decimals: number;
	usdt_decimals: number;
	description: string | null;
	logo_url: string | null;
	website: string | null;
	twitter: string | null;
	telegram: string | null;
	discord: string | null;
	video_url: string | null;
	created_at: Timestamp;
	updated_at: Timestamp;
}

// ── launch_transactions ──────────────────────────────────────────────────

export interface LaunchTransaction {
	id: number;
	launch_address: Address;
	chain_id: number;
	buyer: Address;
	base_amount: DecimalString;
	tokens_received: DecimalString;
	tx_hash: string | null;
	created_at: Timestamp;
}

// ── comments ─────────────────────────────────────────────────────────────

export interface Comment {
	id: number;
	launch_address: Address;
	chain_id: number;
	wallet_address: Address;
	message: string;
	created_at: Timestamp;
}

// ── badges ───────────────────────────────────────────────────────────────

export interface Badge {
	id: number;
	launch_address: Address;
	chain_id: number;
	badge_type: string;
	granted_at: Timestamp;
	granted_by: Address | null;
	proof_url: string | null;
}

// ── withdrawal_requests ──────────────────────────────────────────────────

export type WithdrawalStatus =
	| 'pending'
	| 'awaiting_trade'
	| 'confirmed'
	| 'cancelled'
	| 'rejected'
	| 'failed';

export interface WithdrawalRequest {
	id: number;
	withdraw_id: number | null;
	chain_id: number;
	wallet_address: Address;
	token_in: Address;
	token_in_symbol: string | null;
	gross_amount: DecimalString;
	fee: DecimalString;
	net_amount: DecimalString;
	payment_method: string;
	payment_details: Record<string, unknown>;
	status: WithdrawalStatus;
	admin_note: string | null;
	tx_hash: string | null;
	confirmed_at: Timestamp | null;
	created_at: Timestamp;
	updated_at: Timestamp;
}

// ── recent_transactions ──────────────────────────────────────────────────

export interface RecentTransaction {
	id: number;
	chain_id: number;
	launch_address: Address;
	token_symbol: string;
	token_name: string;
	buyer: Address;
	tokens_amount: DecimalString;
	base_amount: DecimalString;
	base_symbol: string;
	base_decimals: number;
	token_decimals: number;
	tx_hash: string | null;
	created_at: Timestamp;
}

// ── wallets (multi-wallet embedded wallet storage) ───────────────────────

export interface WalletRow {
	id: string;               // uuid
	user_id: string;          // uuid
	name: string;
	primary_blob: string;
	recovery_blob_1: string | null;
	recovery_blob_2: string | null;
	recovery_blob_3: string | null;
	account_count: number;
	default_address: Address | null;
	is_imported: boolean;
	is_primary: boolean;
	preferences: Record<string, unknown>;
	created_at: Timestamp;
	updated_at: Timestamp;
}

// ── token_aliases / referral_aliases ─────────────────────────────────────

export interface TokenAlias {
	id: number;
	alias: string;
	token_address: Address;
	chain_id: number;
	creator: Address;
	created_at: Timestamp;
}

export interface ReferralAlias {
	id: number;
	alias: string;
	wallet_address: Address;
	created_at: Timestamp;
}

// ── API envelopes ────────────────────────────────────────────────────────

/** Standard shape every `/api/*` route should return on error. */
export interface ApiError {
	error: string;
	code?: string;
	details?: unknown;
}

/** Paginated list shape for endpoints that support offset/limit. */
export interface Paginated<T> {
	items: T[];
	total: number;
	offset: number;
	limit: number;
}

// ── Gecko enrichment ─────────────────────────────────────────────────────

export interface GeckoInfo {
	price_usd: number;
	volume_24h: number;
	price_change_24h: number;
	has_data: boolean;
}

export type GeckoLookup = Record<string, GeckoInfo>;

// ── Explore/Manage view-model types ──────────────────────────────────────

/** Row shape returned by explore's server load (chain-first or DB-first). */
export interface ExploreToken extends Pick<
	CreatedToken,
	| 'address'
	| 'chain_id'
	| 'name'
	| 'symbol'
	| 'decimals'
	| 'creator'
	| 'is_mintable'
	| 'is_taxable'
	| 'is_partner'
	| 'total_supply'
	| 'logo_url'
	| 'description'
> {
	/** May be null when the row comes from a chain-first loader with no DB row. */
	created_at: Timestamp | null;
}

/** Row shape used in the manage-tokens list (enriched with network info). */
export interface ManageTokenItem extends ExploreToken {
	chain_symbol: string;
	network_name: string;
	website?: string | null;
	twitter?: string | null;
	telegram?: string | null;
}
