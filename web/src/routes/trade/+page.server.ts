import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { getBanks } from '$lib/flutterwave';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const [tokensResult, banksResult, ratesResult] = await Promise.all([
		// Platform tokens (first page — client fetches more via search/pagination)
		supabaseAdmin
			.from('created_tokens')
			.select('address, name, symbol, decimals, logo_url')
			.order('created_at', { ascending: false })
			.limit(30),

		// Nigerian banks — DB cache with Flutterwave fallback
		(async () => {
			const { data } = await supabaseAdmin
				.from('ng_banks')
				.select('code, name, slug')
				.order('name');

			if (data && data.length > 0) return { data };

			try {
				const flwBanks = await getBanks();
				if (flwBanks.length > 0) {
					const rows = flwBanks.map(b => ({
						code: b.code,
						name: b.name,
						slug: b.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
						active: true
					}));
					await supabaseAdmin.from('ng_banks').update({ active: false }).neq('code', '');
					await supabaseAdmin.from('ng_banks').upsert(rows, { onConflict: 'code' });
					return { data: rows.map(b => ({ code: b.code, name: b.name, slug: b.slug })) };
				}
			} catch {}
			return { data: [] };
		})(),

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
			const onrampFeeBps = Number(override?.value?.onramp_fee_bps ?? 250);
			const overrides: Record<string, number | null> = override?.value || {};

			// Off-ramp / sell rates: mid × (1 − spread).
			const sell: Record<string, number> = {};
			for (const code of ['NGN', 'GBP', 'EUR', 'GHS', 'KES']) {
				if (overrides[code] !== undefined && overrides[code] !== null) {
					sell[code] = overrides[code] as number;
				} else if (rates[code]) {
					sell[code] = rates[code] * (1 - spreadBps / 10000);
				}
			}

			// On-ramp / buy NGN rate: mid × (1 + spread). The override (when
			// set) is a hard rate and bypasses the spread on both sides.
			let onrampNgn: number | null = null;
			if (typeof overrides.NGN === 'number' && overrides.NGN > 0) {
				onrampNgn = overrides.NGN as number;
			} else if (typeof rates.NGN === 'number' && rates.NGN > 0) {
				onrampNgn = rates.NGN * (1 + spreadBps / 10000);
			}

			return { sell, onrampNgn, onrampFeeBps };
		})(),
	]);

	const platformTokens = (tokensResult.data || [])
		.filter((t: any) => t.address && t.symbol)
		.map((t: any) => ({
			address: t.address,
			symbol: t.symbol,
			name: t.name || t.symbol,
			decimals: t.decimals || 18,
			logo_url: t.logo_url,
		}));

	return {
		platformTokens,
		ngBanks: banksResult.data || [],
		// `fiatRates` historically held only the off-ramp/sell rates as a
		// flat dict; preserved here so off-ramp callers don't have to
		// change. On-ramp NGN rate + fee are exposed alongside.
		fiatRates: ratesResult.sell,
		onrampNgnRate: ratesResult.onrampNgn,
		onrampFeeBps: ratesResult.onrampFeeBps,
	};
};
