import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const { data } = await supabaseAdmin
		.from('launches')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(100);

	const launches = data || [];

	// Fill missing launch logos with the underlying token's logo
	const needLogo = launches.filter(l => !l.logo_url && l.token_address);
	if (needLogo.length > 0) {
		const { data: tokenLogos } = await supabaseAdmin
			.from('created_tokens')
			.select('address, logo_url')
			.in('address', needLogo.map(l => l.token_address.toLowerCase()));
		const logoByAddr = new Map((tokenLogos || []).filter(t => t.logo_url).map(t => [t.address.toLowerCase(), t.logo_url]));
		for (const l of launches) {
			if (!l.logo_url) l.logo_url = logoByAddr.get(l.token_address?.toLowerCase()) || null;
		}
	}

	return { launches };
};
