import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const { data } = await supabaseAdmin
		.from('launches')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(100);

	return { launches: data || [] };
};
