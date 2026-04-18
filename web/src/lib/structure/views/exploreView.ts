import type { ExplorePool, TokenTrustRow } from '../index';

/**
 * Minimal on-chain token shape surfaced by SSR (TradeLensV2 tokenInfo slice).
 * Kept as a local alias so exploreView stays decoupled from tradeLens internals.
 */
export interface ExploreOnChainInfo {
	name?: string;
	symbol?: string;
	decimals?: number;
	totalSupply?: string;
	hasLiquidity?: boolean;
}

/**
 * `created_tokens` DB row slice used by the explore page. A superset of
 * TokenTrustRow with a few extra columns (creator, created_at, total_supply,
 * social links). Kept optional because every consumer runs through a
 * fallback chain that tolerates missing fields.
 */
export interface ExploreDbRow extends TokenTrustRow {
	address?: string;
	chain_id?: number;
	creator?: string;
	total_supply?: string;
	description?: string;
	website?: string;
	twitter?: string;
	telegram?: string;
	created_at?: string | number | null;
}

/**
 * Collapsed display shape for the explore page — every field that combines
 * DB metadata, on-chain reads, and pool snapshots into a single "what the
 * UI renders" value. Does NOT contain user-specific derivations
 * (userAddress, isCreator) — those stay in the component because they
 * depend on async context/stores.
 */
export interface ExploreView {
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	logoUrl: string;
	description: string;
	website: string;
	twitter: string;
	telegram: string;
	creator: string;
	createdAt: string;
	isOnPlatform: boolean;
	hasLiquidity: boolean;
	activePools: ExplorePool[];
	allBurned: boolean;
	// Extra DB trust flags folded in — callers already read them conditionally
	// and collapsing them here lets sub-components take a single `view` prop.
	isSafu: boolean;
	ownerRenounced: boolean;
	taxCeilingLocked: boolean;
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
}

/**
 * Pure projection from SSR payload → display shape. Runs every render via
 * `$derived(toExploreView(...))` — must stay side-effect-free.
 *
 * @param dbData         `created_tokens` DB row (null for non-platform tokens)
 * @param onChainData    TradeLensV2 tokenInfo slice (null if lens failed)
 * @param pools          Resolved pool list from SSR (may be empty)
 * @param unknownLabel   i18n fallback for the display name when nothing resolves
 */
export function toExploreView(
	dbData: ExploreDbRow | null | undefined,
	onChainData: ExploreOnChainInfo | null | undefined,
	pools: ExplorePool[],
	unknownLabel: string,
): ExploreView {
	const activePools = pools.filter(p => p.has_liquidity);
	const allBurned = pools.length > 0 && pools.every(p => p.lp_burned && p.lp_burned_pct >= 9900);

	return {
		name: dbData?.name || onChainData?.name || unknownLabel,
		symbol: dbData?.symbol || onChainData?.symbol || '???',
		decimals: dbData?.decimals || onChainData?.decimals || 18,
		totalSupply: onChainData?.totalSupply || '0',
		logoUrl: dbData?.logo_url || '',
		description: dbData?.description || '',
		website: dbData?.website || '',
		twitter: dbData?.twitter || '',
		telegram: dbData?.telegram || '',
		creator: dbData?.creator || '',
		createdAt: dbData?.created_at ? new Date(dbData.created_at).toLocaleDateString() : '',
		isOnPlatform: !!dbData,
		hasLiquidity: !!(onChainData?.hasLiquidity || pools.some(p => p.has_liquidity)),
		activePools,
		allBurned,
		isSafu: !!dbData?.is_safu,
		ownerRenounced: !!dbData?.owner_renounced,
		taxCeilingLocked: !!dbData?.tax_ceiling_locked,
		isTaxable: !!dbData?.is_taxable,
		isMintable: !!dbData?.is_mintable,
		isPartner: !!dbData?.is_partner,
	};
}
