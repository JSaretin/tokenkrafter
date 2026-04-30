/**
 * GET /api/config/team
 *
 * Public, edge-cacheable read of platform_config.team. Operator
 * edits roster from the admin panel; team page renders the result.
 *
 * Cache strategy mirrors /api/config/socials — team changes are
 * infrequent (new hire, departure), so a long edge cache is the
 * right tradeoff. Manual CF purge on save if instant propagation
 * is needed.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const GET: RequestHandler = async () => {
	let team: unknown[] = [];
	try {
		const { data } = await supabaseAdmin
			.from('platform_config')
			.select('value')
			.eq('key', 'team')
			.single();
		const value = data?.value;
		if (Array.isArray(value)) team = value;
	} catch (e: any) {
		console.warn('[config.team] read failed:', e?.message?.slice(0, 100));
	}

	return json(
		{ team },
		{
			headers: {
				'Cache-Control':
					'public, max-age=300, s-maxage=604800, stale-while-revalidate=2592000',
			},
		},
	);
};
