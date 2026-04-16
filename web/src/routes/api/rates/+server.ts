import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/rates?currencies=NGN,GBP,EUR
// Reads from platform_config table (updated hourly by pg_cron)
export const GET: RequestHandler = async ({ url }) => {
	const currencies = url.searchParams.get('currencies')?.split(',') || ['NGN'];

	// Read rates from DB (updated by pg_cron every hour)
	const { data: settings } = await supabaseAdmin
		.from('platform_config')
		.select('value, updated_at')
		.eq('key', 'exchange_rates')
		.single();

	// Read admin override
	const { data: override } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'rate_override')
		.single();

	const rates: Record<string, number> = settings?.value?.rates || {};
	const spreadBps = override?.value?.spread_bps ?? 30; // 0.3% default
	const overrides: Record<string, number | null> = override?.value || {};

	const result: Record<string, number> = {};
	for (const c of currencies) {
		const code = c.trim().toUpperCase();
		// Admin override takes priority
		if (overrides[code] !== undefined && overrides[code] !== null) {
			result[code] = overrides[code] as number;
		} else if (rates[code]) {
			// Apply spread (reduce rate by X bps)
			result[code] = rates[code] * (1 - spreadBps / 10000);
		}
	}

	return json({
		base: 'USD',
		rates: result,
		spread_bps: spreadBps,
		source: settings?.value?.source || 'fallback',
		updated_at: settings?.updated_at || null
	});
};
