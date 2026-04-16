import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const CHAIN_MAP: Record<string, number> = {
	bsc: 56, eth: 1, base: 8453, arbitrum: 42161, polygon: 137,
};
const CHAIN_ID_TO_SLUG: Record<number, string> = Object.fromEntries(
	Object.entries(CHAIN_MAP).map(([k, v]) => [v, k])
);

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const launchAddress = params.address?.toLowerCase() || '';
	const chainId = CHAIN_MAP[chainSlug] || 56;

	// Fetch launch data from DB
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('*')
		.eq('address', launchAddress)
		.eq('chain_id', chainId)
		.single();

	// Fetch badges + token trust signals in parallel
	const tokenAddress = launch?.token_address?.toLowerCase();
	const [badgesResult, tokenResult] = await Promise.all([
		supabaseAdmin
			.from('badges')
			.select('badge_type')
			.eq('launch_address', launchAddress)
			.eq('chain_id', chainId),
		tokenAddress
			? supabaseAdmin
				.from('created_tokens')
				.select('is_safu, is_kyc, has_liquidity, lp_burned, lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled, buy_tax_bps, sell_tax_bps, is_taxable, is_mintable, is_partner')
				.eq('address', tokenAddress)
				.eq('chain_id', chainId)
				.single()
			: Promise.resolve({ data: null }),
	]);

	return {
		chainSlug,
		chainId,
		launchAddress,
		launch,
		badges: badgesResult.data?.map(b => b.badge_type) || [],
		tokenTrust: tokenResult.data || null,
	};
};
