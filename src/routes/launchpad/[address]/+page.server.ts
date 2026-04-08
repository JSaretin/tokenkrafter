import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const CHAIN_ID_TO_SLUG: Record<number, string> = {
	56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon',
};

// Redirect old /launchpad/0x... to /launchpad/[chain]/0x...
export const load: PageServerLoad = async ({ params }) => {
	const address = params.address?.toLowerCase() || '';

	// Look up chain from DB
	const { data } = await supabaseAdmin
		.from('launches')
		.select('chain_id')
		.eq('address', address)
		.single();

	const chainSlug = CHAIN_ID_TO_SLUG[data?.chain_id] || 'bsc';
	redirect(301, `/launchpad/${chainSlug}/${address}`);
};
