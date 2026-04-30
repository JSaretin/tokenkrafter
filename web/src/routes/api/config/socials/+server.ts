/**
 * GET /api/config/socials
 *
 * Public, edge-cacheable read of platform_config.social_links.
 * Operator-edited rarely (URLs change once in a blue moon), read on
 * every page render via the layout's footer — perfect candidate for
 * long-lived CDN caching.
 *
 * Cache strategy:
 *   - max-age=300     (browser caches 5 min)
 *   - s-maxage=604800 (CF edge caches 1 week)
 *   - stale-while-revalidate=2592000 (serve stale up to 30 days while
 *     refreshing in the background; means a CF outage on Supabase
 *     side won't break the footer)
 *
 * After an operator updates the row, propagation is eventual — up to
 * 1 week before all edges refresh. If urgent, purge via Cloudflare
 * dashboard or call this endpoint with `?bust=<random>` to bypass.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const GET: RequestHandler = async () => {
	let socialLinks: Record<string, string> = {};
	try {
		const { data } = await supabaseAdmin
			.from('platform_config')
			.select('value')
			.eq('key', 'social_links')
			.single();
		socialLinks = (data?.value as Record<string, string> | undefined) ?? {};
	} catch (e: any) {
		// Don't 500 on a config-read failure — let the footer degrade
		// gracefully (no socials section). Logging stays server-side.
		console.warn('[config.socials] read failed:', e?.message?.slice(0, 100));
	}

	return json(
		{ socialLinks },
		{
			headers: {
				'Cache-Control':
					'public, max-age=300, s-maxage=604800, stale-while-revalidate=2592000',
			},
		},
	);
};
