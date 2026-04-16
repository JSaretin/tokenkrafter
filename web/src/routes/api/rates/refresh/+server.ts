import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

const RATE_API = 'https://open.er-api.com/v6/latest/USD';
const CURRENCIES = ['NGN', 'GBP', 'EUR', 'GHS', 'KES'];

/**
 * POST /api/rates/refresh
 *
 * Fetches live exchange rates and updates platform_config.
 * Auth: TX_CONFIRM_SECRET bearer token (daemon cron ping).
 */
export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	const isDaemon = env.TX_CONFIRM_SECRET && authHeader === `Bearer ${env.TX_CONFIRM_SECRET}`;
	if (!isDaemon) return error(401, 'Daemon access required');

	// Fetch live rates
	let rates: Record<string, number>;
	try {
		const res = await fetch(RATE_API);
		if (!res.ok) return error(502, `Rate API returned ${res.status}`);
		const data = await res.json();
		if (data.result !== 'success' || !data.rates) {
			return error(502, 'Unexpected rate API response');
		}
		rates = {};
		for (const c of CURRENCIES) {
			if (data.rates[c]) rates[c] = data.rates[c];
		}
	} catch (e: any) {
		return error(502, `Rate fetch failed: ${e.message?.slice(0, 100)}`);
	}

	// Update DB
	const { error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.update({
			value: {
				base: 'USD',
				rates,
				source: 'open.er-api.com',
				fetched_at: new Date().toISOString(),
			},
			updated_at: new Date().toISOString(),
		})
		.eq('key', 'exchange_rates');

	if (dbErr) {
		console.error('[rates/refresh] DB error:', dbErr.message);
		return error(500, 'Failed to update rates');
	}

	const rateStr = CURRENCIES.map(c => `${c}=${rates[c] ?? '?'}`).join(', ');
	console.log(`[rates/refresh] Updated: ${rateStr}`);

	return json({ success: true, rates });
};
