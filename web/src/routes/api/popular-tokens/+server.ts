/**
 * GET /api/popular-tokens?chain=bsc
 *
 * Returns every CoinGecko-known token that exists on the requested chain
 * (typically a few thousand entries) so the trade page's token picker
 * can resolve any well-known symbol the user types — ETH, XRP, DOGE,
 * BUSD, etc — without forcing them to paste a contract address.
 *
 * The data is sourced from CoinGecko's `/coins/list?include_platform=true`
 * (free tier, no API key) and cached in
 * `platform_config.value.popular_tokens.<chain>` for 6 hours. Within
 * that window every request is one DB read; on miss / stale we refresh
 * inline (no cron dependency, no scheduled job).
 *
 * The cache layout is:
 *   platform_config[key='popular_tokens'].value = {
 *     bsc: { tokens: [...], updated_at: ISO8601 },
 *     eth: { tokens: [...], updated_at: ISO8601 },
 *     ...
 *   }
 *
 * Each cached token: { address, symbol, name } — minimal so the wire
 * payload stays small. Logos resolve client-side via tokenLogo.ts, and
 * decimals are read on-chain when the user actually picks the token, so
 * a missing decimals here doesn't risk wrong-math at trade time.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// Our `network.symbol` (GeckoTerminal slug) → CoinGecko's `platforms` key.
// Add new chains here as they come online.
const CG_PLATFORM_BY_CHAIN: Record<string, string> = {
	bsc: 'binance-smart-chain',
	eth: 'ethereum',
	polygon: 'polygon-pos',
	arbitrum: 'arbitrum-one',
	base: 'base',
	avalanche: 'avalanche',
	optimism: 'optimistic-ethereum',
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ChainToken {
	address: string;
	symbol: string;
	name: string;
}

interface ChainCache {
	tokens: ChainToken[];
	updated_at: string;
}

async function readCache(): Promise<Record<string, ChainCache>> {
	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'popular_tokens')
		.maybeSingle();
	return (data?.value as Record<string, ChainCache>) || {};
}

async function writeCache(merged: Record<string, ChainCache>): Promise<void> {
	await supabaseAdmin
		.from('platform_config')
		.upsert({ key: 'popular_tokens', value: merged }, { onConflict: 'key' });
}

/**
 * Fetch every CoinGecko token that has a deployment on the requested chain.
 *
 * One call to `/coins/list?include_platform=true` (~5 MB JSON, ~14k
 * tokens across all chains) — we filter to the requested chain
 * server-side before caching, so the wire payload back to the browser
 * is much smaller (~200-500 KB depending on chain).
 */
async function refreshChain(platformKey: string): Promise<ChainToken[]> {
	const res = await fetch(
		'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
		{ headers: { accept: 'application/json' } },
	);
	if (!res.ok) throw new Error(`coingecko list: ${res.status}`);
	const list = await res.json() as Array<{
		id: string; symbol: string; name: string;
		platforms: Record<string, string | null>;
	}>;

	const tokens: ChainToken[] = [];
	for (const c of list) {
		const addr = c.platforms?.[platformKey];
		if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
		tokens.push({
			address: addr,
			symbol: c.symbol.toUpperCase(),
			name: c.name,
		});
	}
	return tokens;
}

export const GET: RequestHandler = async ({ url }) => {
	const chain = (url.searchParams.get('chain') || 'bsc').toLowerCase();
	const platformKey = CG_PLATFORM_BY_CHAIN[chain];
	if (!platformKey) {
		return json({ tokens: [], chain, error: 'unsupported chain' }, { status: 400 });
	}

	const cache = await readCache();
	const entry = cache[chain];
	const fresh = entry && Date.now() - new Date(entry.updated_at).getTime() < CACHE_TTL_MS;

	if (fresh) {
		return json({ tokens: entry.tokens, chain, cached: true, updated_at: entry.updated_at });
	}

	// On miss / stale, refresh inline. CoinGecko free tier is 30 req/min;
	// one request per 6 hours per chain is a rounding error.
	try {
		const tokens = await refreshChain(platformKey);
		const merged = { ...cache, [chain]: { tokens, updated_at: new Date().toISOString() } };
		await writeCache(merged);
		return json({ tokens, chain, cached: false, updated_at: merged[chain].updated_at });
	} catch (e: any) {
		// Refresh failed — serve whatever stale cache we have rather than
		// failing the request, so the picker still resolves known symbols.
		console.error('[popular-tokens] refresh failed:', e?.message || e);
		if (entry) {
			return json({ tokens: entry.tokens, chain, cached: true, stale: true, updated_at: entry.updated_at });
		}
		return json({ tokens: [], chain, error: 'refresh failed' }, { status: 502 });
	}
};
