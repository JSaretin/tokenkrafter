/**
 * GET /api/onramp/rate?chain_id=56
 *
 * Returns the current NGN sell rate used by the on-ramp. Read-only —
 * no DB write. Cached for 60s on the edge so the client can poll safely
 * for a fresh-looking preview without hammering Supabase.
 *
 * The locked rate the user actually pays at comes from the
 * /api/onramp/quote endpoint; this is purely for the preview-as-you-type
 * UX before the user commits.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const CACHE_60S = 'public, max-age=60, s-maxage=60, stale-while-revalidate=300';

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const chain_id = Number(url.searchParams.get('chain_id') ?? 56);
	if (!Number.isFinite(chain_id) || chain_id <= 0) return error(400, 'Invalid chain_id');

	const [{ data: settings }, { data: override }] = await Promise.all([
		supabaseAdmin.from('platform_config').select('value').eq('key', 'exchange_rates').single(),
		supabaseAdmin.from('platform_config').select('value').eq('key', 'rate_override').single(),
	]);

	// On-ramp applies the spread in the BUY direction (mirror of off-ramp,
	// which subtracts). `rate_override.NGN` (when set) is a hard override
	// that bypasses the spread.
	const overridden = override?.value?.NGN;
	const raw = settings?.value?.rates?.NGN;
	const spreadBps = override?.value?.spread_bps ?? 30;
	const rate = typeof overridden === 'number' && overridden > 0
		? overridden
		: typeof raw === 'number' && raw > 0
			? raw * (1 + spreadBps / 10000)
			: null;

	if (!rate) return error(503, 'Exchange rate unavailable');

	setHeaders({ 'cache-control': CACHE_60S });
	return json({
		chain_id,
		rate_x100: Math.round(rate * 100),
		fetched_at: Math.floor(Date.now() / 1000),
	});
};
