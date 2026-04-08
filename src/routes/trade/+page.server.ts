import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async () => {
	const [launchesResult, banksResult, ratesResult] = await Promise.all([
		// Token list from launches
		supabaseAdmin
			.from('launches')
			.select('token_address, token_symbol, token_name, token_decimals, logo_url')
			.order('created_at', { ascending: false })
			.limit(50),

		// Nigerian banks (cached in DB)
		supabaseAdmin
			.from('ng_banks')
			.select('code, name, slug')
			.eq('active', true)
			.order('name'),

		// Exchange rates
		(async () => {
			const { data: settings } = await supabaseAdmin
				.from('platform_config')
				.select('value')
				.eq('key', 'exchange_rates')
				.single();

			const { data: override } = await supabaseAdmin
				.from('platform_config')
				.select('value')
				.eq('key', 'rate_override')
				.single();

			const rates: Record<string, number> = settings?.value?.rates || {};
			const spreadBps = override?.value?.spread_bps ?? 30;
			const overrides: Record<string, number | null> = override?.value || {};

			const result: Record<string, number> = {};
			for (const code of ['NGN', 'GBP', 'EUR', 'GHS', 'KES']) {
				if (overrides[code] !== undefined && overrides[code] !== null) {
					result[code] = overrides[code] as number;
				} else if (rates[code]) {
					result[code] = rates[code] * (1 - spreadBps / 10000);
				}
			}
			return result;
		})(),
	]);

	const platformTokens = (launchesResult.data || [])
		.filter((l: any) => l.token_address && l.token_symbol)
		.map((l: any) => ({
			address: l.token_address,
			symbol: l.token_symbol,
			name: l.token_name || l.token_symbol,
			decimals: l.token_decimals || 18,
			logo_url: l.logo_url,
		}));

	return {
		platformTokens,
		ngBanks: banksResult.data || [],
		fiatRates: ratesResult,
	};
};
