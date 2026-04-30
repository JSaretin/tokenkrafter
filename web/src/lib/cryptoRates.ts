/**
 * Native-coin USD price helpers shared between /api/rates/refresh
 * (cron-driven bulk update) and /api/onramp/quote (lazy fallback when
 * the cached price is missing on the on-ramp critical path).
 *
 * Source of truth in DB: `platform_config.exchange_rates.crypto.{SYMBOL}`
 *   (e.g. crypto.BNB = 612.34 means 1 BNB ≈ $612.34).
 */
import { supabaseAdmin } from '$lib/supabaseServer';

export const NATIVE_GECKO_IDS: Record<string, string> = {
	BNB: 'binancecoin',
	ETH: 'ethereum',
	MATIC: 'matic-network',
	AVAX: 'avalanche-2',
	BASE: 'ethereum',
};

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';

/**
 * Fetch all native USD prices from CoinGecko. Returns whatever it
 * managed to retrieve; caller decides whether to persist or merge.
 */
export async function fetchAllNativePrices(timeoutMs = 4000): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	const ids = Array.from(new Set(Object.values(NATIVE_GECKO_IDS))).join(',');
	try {
		const res = await fetch(`${COINGECKO_API}?ids=${ids}&vs_currencies=usd`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return out;
		const data = await res.json();
		for (const [symbol, geckoId] of Object.entries(NATIVE_GECKO_IDS)) {
			const usd = data?.[geckoId]?.usd;
			if (typeof usd === 'number' && usd > 0) out[symbol] = usd;
		}
	} catch {}
	return out;
}

/**
 * Lazy single-symbol fetcher used by hot paths (e.g. on-ramp quote
 * when the cached crypto.{symbol} entry is missing). Persists the
 * result back into platform_config.exchange_rates.crypto so the next
 * caller hits the cache. Tight timeout — if CoinGecko is slow we'd
 * rather degrade to "no drip" than block the quote.
 */
export async function fetchAndCacheNativePrice(symbol: string): Promise<number> {
	const geckoId = NATIVE_GECKO_IDS[symbol];
	if (!geckoId) return 0;
	let usd = 0;
	try {
		const res = await fetch(`${COINGECKO_API}?ids=${geckoId}&vs_currencies=usd`, {
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return 0;
		const data = await res.json();
		usd = Number(data?.[geckoId]?.usd);
		if (!Number.isFinite(usd) || usd <= 0) return 0;
	} catch {
		return 0;
	}

	// Read-modify-write the exchange_rates row so we don't clobber the
	// fiat block. Best-effort — a write failure here just means the
	// next caller refetches; doesn't break this quote.
	try {
		const { data: cur } = await supabaseAdmin
			.from('platform_config')
			.select('value')
			.eq('key', 'exchange_rates')
			.single();
		const value = (cur?.value as any) ?? {};
		value.crypto = { ...(value.crypto ?? {}), [symbol]: usd };
		await supabaseAdmin
			.from('platform_config')
			.update({ value, updated_at: new Date().toISOString() })
			.eq('key', 'exchange_rates');
	} catch (e: any) {
		console.warn('[cryptoRates] write-back failed:', e?.message?.slice(0, 100));
	}

	return usd;
}
