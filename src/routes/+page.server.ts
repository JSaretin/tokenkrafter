import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async () => {
	const { data } = await supabaseAdmin
		.from('launches')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(100);

	return { launches: data || [] };
};
