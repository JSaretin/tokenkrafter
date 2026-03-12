import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/badges?address=0x...&chain_id=56
// If no address provided, returns all badges (for listing page)
export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address');
	const chainId = url.searchParams.get('chain_id');

	let query = supabaseAdmin
		.from('badges')
		.select('launch_address, chain_id, badge_type, granted_at, proof_url');

	if (address) {
		query = query.eq('launch_address', address.toLowerCase());
	}

	if (chainId) {
		query = query.eq('chain_id', Number(chainId));
	}

	const { data, error: dbError } = await query;

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data ?? []);
};
