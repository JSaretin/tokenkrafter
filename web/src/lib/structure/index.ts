import type { WithdrawRequestRaw } from './tradeRouter';

// ════════════════════════════════════════════════════════════════════════════
//  Chain-wide types (platform-level, not tied to a single contract)
// ════════════════════════════════════════════════════════════════════════════

export interface SupportedNetwork {
	name: string;
	symbol: string;              // chain slug (e.g. "bsc", "eth", "base")
	chain_id: number;
	native_coin: string;
	usdt_address: string;
	usdc_address: string;
	platform_address: string;
	launchpad_address: string;
	router_address: string;
	dex_router: string;
	trade_router_address: string;
	trade_lens_address?: string;
	rpc: string;
	ws_rpc?: string;
	daemon_rpc?: string;
	explorer_url?: string;
	gecko_network?: string;
	default_bases?: { address: string; symbol: string; name?: string }[];
}

export type SupportedNetworks = SupportedNetwork[];

export interface PaymentOption {
	symbol: string;
	name: string;
	address: string;             // address(0) for native
	decimals: number;
}

/** Generic token summary shape used across the create / manage / explore UIs. */
export interface TokenInfo {
	name: string;
	symbol: string;
	totalSupply: string;
	decimals: number;
	isMintable?: boolean;
	isTaxable?: boolean;
	isPartner?: boolean;
}

const _CHAIN_SLUGS: Record<number, string> = {
	56: 'bsc',
	1: 'eth',
	8453: 'base',
	42161: 'arbitrum',
	137: 'polygon',
};
export function chainSlug(chainId: number): string {
	return _CHAIN_SLUGS[chainId] || 'bsc';
}

// ════════════════════════════════════════════════════════════════════════════
//  Database row shapes — cross-cutting (DB ↔ SSR ↔ UI)
// ════════════════════════════════════════════════════════════════════════════

/** `created_tokens` row slice used in token pickers / dropdowns. */
export interface PlatformTokenRow {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	logo_url?: string;
}

/** `ng_banks` row — Flutterwave bank catalogue mirrored per chain. */
export interface NgBankRow {
	code: string;
	name: string;
	slug: string;
	logo?: string;
	ussd?: string;
}

/** `launches` row, possibly merged with live RPC snapshot (RPC fallback path in
 *  +page.server.ts). All bigint-valued fields are strings because JSON/SSR
 *  cannot carry bigint across the wire. */
export interface LaunchRow {
	address?: string;
	token_address?: string;
	creator?: string;
	curve_type?: number;
	state?: number;
	soft_cap?: string;
	hard_cap?: string;
	deadline?: number | string;
	start_timestamp?: number | string;
	total_base_raised?: string;
	tokens_sold?: string;
	tokens_for_curve?: string;
	tokens_for_lp?: string;
	creator_allocation_bps?: number | string;
	current_price?: string;
	usdt_address?: string;
	total_tokens_required?: string;
	total_tokens_deposited?: string;
	total_buyers?: number;
	total_purchases?: number;
	token_name?: string;
	token_symbol?: string;
	token_decimals?: number;
	usdt_decimals?: number;
	logo_url?: string;
	description?: string;
	website?: string;
	twitter?: string;
	telegram?: string;
	discord?: string;
	video_url?: string;
}

/** `created_tokens` row slice carrying off-chain trust signals (SAFU, LP burn,
 *  tax ceiling lock, owner renouncement). */
export interface TokenTrustRow {
	name?: string;
	symbol?: string;
	decimals?: number;
	is_safu?: boolean;
	is_kyc?: boolean;
	has_liquidity?: boolean;
	lp_burned?: boolean;
	lp_burned_pct?: number;
	tax_ceiling_locked?: boolean;
	owner_renounced?: boolean;
	trading_enabled?: boolean;
	buy_tax_bps?: number;
	sell_tax_bps?: number;
	is_taxable?: boolean;
	is_mintable?: boolean;
	is_partner?: boolean;
	logo_url?: string;
}

/** `withdrawal_requests` row returned by `/api/withdrawals?wallet=…`. */
export interface DbWithdrawalRow {
	id: number;
	withdraw_id: number | null;
	wallet_address: string | null;
	chain_id: number;
	token_in: string | null;
	payment_method: string;
	payment_details: Record<string, unknown>;
	tx_hash: string | null;
}

// ════════════════════════════════════════════════════════════════════════════
//  SSR payloads (+page.server.ts → +page.svelte)
// ════════════════════════════════════════════════════════════════════════════

/** /trade page server payload. */
export interface TradePageServerData {
	platformTokens: PlatformTokenRow[];
	ngBanks: NgBankRow[];
	fiatRates: Record<string, number>;
}

// ════════════════════════════════════════════════════════════════════════════
//  Normalized UI shapes (derived from on-chain reads)
// ════════════════════════════════════════════════════════════════════════════

/** Pool shape produced by explore SSR — combines TradeLens reserves with
 *  resolved base symbol + LP burn detection. */
export interface ExplorePool {
	address: string;
	name: string;
	base: string;
	base_symbol: string;
	reserve_token: string;       // stringified bigint
	reserve_base: string;
	has_liquidity: boolean;
	lp_burned: boolean;
	lp_burned_pct: number;       // 0-10000 bps
}

/** Per-wallet row view for a token's setTaxDistribution state. The contract
 *  stores these as two parallel arrays (`taxWallets[]`, `taxSharesBps[]`);
 *  this is the zipped row shape most UIs want. */
export interface TaxDistributionRow {
	addr: string;
	shareBps: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Browser / storage shapes
// ════════════════════════════════════════════════════════════════════════════

/** EIP-1193 provider injected by wallets on `window.ethereum`. */
export interface Eip1193Provider {
	request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

/** LocalStorage row for the in-app "imported tokens" list (shared between
 *  trade / explore / manage pages). */
export interface ImportedTokenRow {
	address?: string;
	name?: string;
	symbol?: string;
	decimals?: number;
	logoUrl?: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Withdrawal composites — on-chain record enriched with DB metadata
// ════════════════════════════════════════════════════════════════════════════

/** On-chain withdrawal record with timestamps unwrapped to `number` (as the
 *  TradeRouterClient returns them). */
export interface WithdrawalRecord extends Omit<WithdrawRequestRaw, 'createdAt' | 'expiresAt'> {
	createdAt: number;
	expiresAt: number;
}

/** On-chain withdrawal record + DB-side metadata that survives across page
 *  reloads (payment method, tx hash, locked NGN rate). */
export interface MergedWithdrawal extends WithdrawalRecord {
	id: number | string;
	withdraw_id: number;
	chain_id: number;
	payment_method: string;
	payment_details: Record<string, unknown>;
	tx_hash: string;
	db_status: string;
}

/** Shape the confirm/status modal consumes. Does not mirror the on-chain
 *  `WithdrawRequest` 1:1 — combines DB + on-chain fields as display strings. */
export interface WithdrawalView {
	id: string | number;
	withdraw_id: string | number;
	chain_id: number;
	wallet_address: string | null;
	status: string;
	net_amount: string;
	fee: string;
	gross_amount: string;
	payment_method: string;
	payment_details: Record<string, unknown>;
	tx_hash: string;
	created_at: string;
	expiresAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Contract-specific structure — namespaced to avoid symbol collisions
//  (many contracts define overlapping names like TokenInfoRaw / LaunchInfoRaw)
// ════════════════════════════════════════════════════════════════════════════

export * as ERC20 from './erc20';

// Root contracts
export * as Affiliate from './affiliate';
export * as LaunchInstance from './launchInstance';
export * as LaunchpadFactory from './launchpadFactory';
export * as PlatformRouter from './platformRouter';
export * as TokenFactory from './tokenFactory';
export * as TradeRouter from './tradeRouter';

// Shared interfaces
export * as DexInterfaces from './shared/dexInterfaces';
export * as IAffiliate from './shared/iAffiliate';
export * as TokenInterfaces from './shared/tokenInterfaces';

// Simulators (lens contracts)
export * as AdminLens from './simulators/adminLens';
export * as ExploreLens from './simulators/exploreLens';
export * as LaunchLens from './simulators/launchLens';
export * as LaunchPreflight from './simulators/launchPreflight';
export * as MultiCallLens from './simulators/multiCallLens';
export * as PlatformLens from './simulators/platformLens';
export * as PlatformLensV2 from './simulators/platformLensV2';
export * as RouteFinder from './simulators/routeFinder';
export * as SafuLens from './simulators/safuLens';
export * as TradeLens from './simulators/tradeLens';
export * as TradeLensV2 from './simulators/tradeLensV2';

// Token variants
export * as BasicToken from './tokens/basicToken';
export * as PartnerToken from './tokens/partnerToken';
export * as PartnerTaxableToken from './tokens/partnerTaxableToken';
export * as TaxableToken from './tokens/taxableToken';
