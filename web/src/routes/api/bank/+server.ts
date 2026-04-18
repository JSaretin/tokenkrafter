import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { getBanks } from '$lib/flutterwave';

// Bank list is extremely stable — new banks get added maybe once a year,
// and a user seeing a day-old cache is a non-issue (they'd still find
// their bank). 3 months of browser + Cloudflare caching saves a Supabase
// round trip on every trade-page load.
const CACHE_3_MONTHS =
	'public, max-age=7776000, s-maxage=7776000, stale-while-revalidate=86400';

// Admins who pass ?refresh=true want a fresh Flutterwave fetch — don't let
// a CDN serve them a stale copy.
const CACHE_BYPASS = 'private, no-store';

// GET /api/bank — list Nigerian banks (Flutterwave, cached in DB)
export const GET: RequestHandler = async ({ url }) => {
	const refresh = url.searchParams.get('refresh') === 'true';

	// Try DB cache first
	if (!refresh) {
		const { data } = await supabaseAdmin
			.from('ng_banks')
			.select('code, name, slug')
			.eq('active', true)
			.order('name');

		if (data && data.length > 0) {
			return json(data, { headers: { 'cache-control': CACHE_3_MONTHS } });
		}
	}

	// Fetch from Flutterwave and replace DB
	try {
		const flwBanks = await getBanks();

		if (flwBanks.length > 0) {
			const rows = flwBanks.map(b => ({
				code: b.code,
				name: b.name,
				slug: b.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
				active: true
			}));

			// Deactivate all existing, then upsert fresh data
			await supabaseAdmin.from('ng_banks').update({ active: false }).neq('code', '');
			await supabaseAdmin.from('ng_banks').upsert(rows, { onConflict: 'code' });

			const payload = rows.map(b => ({ code: b.code, name: b.name, slug: b.slug }));
			// Refresh path bypasses caches so admin sees the new list immediately.
			// Non-refresh path that falls through here (DB was empty) gets the
			// long cache since it's now the canonical answer.
			return json(payload, {
				headers: { 'cache-control': refresh ? CACHE_BYPASS : CACHE_3_MONTHS },
			});
		}
	} catch {}

	// Fallback to DB (Flutterwave was unreachable / returned empty)
	const { data } = await supabaseAdmin
		.from('ng_banks')
		.select('code, name, slug')
		.eq('active', true)
		.order('name');

	return json(data || [], { headers: { 'cache-control': CACHE_3_MONTHS } });
};
