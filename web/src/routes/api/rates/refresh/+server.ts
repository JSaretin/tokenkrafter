import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';
import { fetchAllNativePrices } from '$lib/cryptoRates';

const RATE_API = 'https://open.er-api.com/v6/latest/USD';
const CURRENCIES = ['NGN', 'GBP', 'EUR', 'GHS', 'KES'];

/**
 * POST /api/rates/refresh
 *
 * Fetches live exchange rates and updates platform_config:
 *   - Fiat (USD-based) for the on-ramp / off-ramp NGN pricing.
 *   - Native crypto USD prices for the on-ramp gas drip — quote endpoint
 *     uses these to convert the BNB drip cost into a USDT deduction.
 * Auth: daemon-only (isDaemonAuth — TX_CONFIRM_SECRET or SYNC_SECRET).
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Daemon access required');

	// Fetch fiat rates
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

	// Fetch native crypto prices. Best-effort: a CoinGecko outage must
	// not break fiat rates — we just leave the previous crypto block as-is.
	let crypto = await fetchAllNativePrices();
	if (Object.keys(crypto).length === 0) {
		const { data: prev } = await supabaseAdmin
			.from('platform_config')
			.select('value')
			.eq('key', 'exchange_rates')
			.single();
		crypto = (prev?.value?.crypto as Record<string, number>) ?? {};
	}

	const { error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.update({
			value: {
				base: 'USD',
				rates,
				crypto,
				source: 'open.er-api.com + coingecko',
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
	const cryptoStr = Object.entries(crypto).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(', ');
	console.log(`[rates/refresh] Updated fiat: ${rateStr} | crypto: ${cryptoStr}`);

	return json({ success: true, rates, crypto });
};
