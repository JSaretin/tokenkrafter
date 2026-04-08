import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async () => {
	const { data } = await supabaseAdmin
		.from('created_tokens')
		.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, type_key, logo_url, description, total_supply, created_at')
		.order('created_at', { ascending: false })
		.limit(200);

	return { tokens: data || [] };
};
