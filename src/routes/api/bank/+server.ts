import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { getBanks } from '$lib/flutterwave';

// GET /api/bank — list Nigerian banks (Flutterwave only, cached in DB)
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
			return json(data);
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

			return json(rows.map(b => ({ code: b.code, name: b.name, slug: b.slug })));
		}
	} catch {}

	// Fallback to DB
	const { data } = await supabaseAdmin
		.from('ng_banks')
		.select('code, name, slug')
		.eq('active', true)
		.order('name');

	return json(data || []);
};
