/**
 * Native-coin USD price helpers shared between /api/rates/refresh
 * (cron-driven bulk update) and /api/onramp/quote (lazy fallback when
 * the cached price is missing on the on-ramp critical path).
 *
 * Source of truth in DB: `platform_config.exchange_rates.crypto.{SYMBOL}`
 *   (e.g. crypto.BNB = 612.34 means 1 BNB ≈ $612.34).
 *
 * Why Binance and not CoinGecko: CoinGecko's free tier rate-limits /
 * blocks fetches originating from Cloudflare Pages (CF egress IPs hit
 * their bot protection). Binance's public ticker has no auth, no rate
 * limits at our volume, and is reachable from CF. The shape is also
 * simpler.
 */
import { supabaseAdmin } from '$lib/supabaseServer';

/**
 * Map our internal native_coin symbol (as stored in
 * platform_config.networks[*].native_coin) to its Binance USDT-paired
 * ticker. Note: Polygon's native rebranded MATIC→POL on Binance, so
 * `MATIC` here resolves to `POLUSDT`. Add chains as supported.
 */
export const NATIVE_BINANCE_PAIRS: Record<string, string> = {
	BNB: 'BNBUSDT',
	ETH: 'ETHUSDT',
	MATIC: 'POLUSDT',
	AVAX: 'AVAXUSDT',
	BASE: 'ETHUSDT',
};

const BINANCE_TICKER = 'https://api.binance.com/api/v3/ticker/price';

function pairToSymbol(pair: string): string | null {
	for (const [symbol, p] of Object.entries(NATIVE_BINANCE_PAIRS)) {
		if (p === pair) return symbol;
	}
	return null;
}

/**
 * Fetch all native USD prices from Binance. Returns whatever it
 * managed to retrieve; caller decides whether to persist or merge.
 */
export async function fetchAllNativePrices(timeoutMs = 4000): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	const pairs = Array.from(new Set(Object.values(NATIVE_BINANCE_PAIRS)));
	// Binance bulk takes a JSON array string in the `symbols` query param.
	const url = `${BINANCE_TICKER}?symbols=${encodeURIComponent(JSON.stringify(pairs))}`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return out;
		const data = await res.json();
		if (!Array.isArray(data)) return out;
		for (const row of data) {
			const symbol = pairToSymbol(row?.symbol ?? '');
			const price = Number(row?.price);
			if (!symbol || !Number.isFinite(price) || price <= 0) continue;
			// First-write wins — if multiple internal symbols map to the
			// same pair (e.g. BASE and ETH both → ETHUSDT), each picks
			// up the same price.
			for (const [s, p] of Object.entries(NATIVE_BINANCE_PAIRS)) {
				if (p === row.symbol && !(s in out)) out[s] = price;
			}
		}
	} catch {}
	return out;
}

/**
 * Lazy single-symbol fetcher used by hot paths (e.g. on-ramp quote
 * when the cached crypto.{symbol} entry is missing). Persists the
 * result back into platform_config.exchange_rates.crypto so the next
 * caller hits the cache. Tight timeout — if Binance is slow we'd
 * rather degrade to "no drip" than block the quote.
 */
export async function fetchAndCacheNativePrice(symbol: string): Promise<number> {
	const pair = NATIVE_BINANCE_PAIRS[symbol];
	if (!pair) return 0;
	let usd = 0;
	try {
		const res = await fetch(`${BINANCE_TICKER}?symbol=${pair}`, {
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return 0;
		const data = await res.json();
		usd = Number(data?.price);
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
