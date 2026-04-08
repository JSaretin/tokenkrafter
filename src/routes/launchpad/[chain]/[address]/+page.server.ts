import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const CHAIN_MAP: Record<string, number> = {
	bsc: 56, eth: 1, base: 8453, arbitrum: 42161, polygon: 137,
};
const CHAIN_ID_TO_SLUG: Record<number, string> = Object.fromEntries(
	Object.entries(CHAIN_MAP).map(([k, v]) => [v, k])
);

export const load: PageServerLoad = async ({ params }) => {
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

	// Fetch badges
	const { data: badges } = await supabaseAdmin
		.from('badges')
		.select('badge_type')
		.eq('launch_address', launchAddress)
		.eq('chain_id', chainId);

	return {
		chainSlug,
		chainId,
		launchAddress,
		launch,
		badges: badges?.map(b => b.badge_type) || [],
	};
};
