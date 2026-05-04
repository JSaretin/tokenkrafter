/**
 * GET /api/popular-tokens?chain=bsc
 *
 * Returns ~50 top market-cap tokens that exist on the requested chain,
 * with their on-chain ERC20 address — so the trade page's token picker
 * can offer ETH / XRP / BNB / DOGE / etc. without forcing the user to
 * paste a contract address.
 *
 * The data is sourced from CoinGecko (free tier, no API key) and cached
 * in `platform_config.value.popular_tokens.<chain>` for an hour. Within
 * that window every request is a single DB read; on miss / stale we
 * refresh inline (no cron dependency, no scheduled job).
 *
 * The cache layout is:
 *   platform_config[key='popular_tokens'].value = {
 *     bsc: { tokens: [...], updated_at: ISO8601 },
 *     eth: { tokens: [...], updated_at: ISO8601 },
 *     ...
 *   }
 *
 * Each cached token: { address, symbol, name, decimals: 18, logo, rank, priceUsd }
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

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface PopularToken {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	logo: string;
	rank: number;
	priceUsd: number;
}

interface ChainCache {
	tokens: PopularToken[];
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
 * Fetch top market-cap tokens that exist on the requested chain.
 *
 * CoinGecko's free tier doesn't let us filter `/coins/markets` by
 * platform, so we pull the global top 250 by market cap and then
 * cross-reference `/coins/list?include_platform=true` to extract the
 * on-chain address for the requested chain. Tokens without a deployment
 * on that chain drop out.
 */
async function refreshChain(chain: string, platformKey: string): Promise<PopularToken[]> {
	// 1. Top 250 by market cap (one call, ~150 KB).
	const marketsRes = await fetch(
		'https://api.coingecko.com/api/v3/coins/markets'
			+ '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false',
		{ headers: { accept: 'application/json' } },
	);
	if (!marketsRes.ok) throw new Error(`coingecko markets: ${marketsRes.status}`);
	const markets = await marketsRes.json() as Array<{
		id: string; symbol: string; name: string; image: string;
		market_cap_rank: number | null; current_price: number | null;
	}>;

	// 2. Coin list with platform addresses (one call, ~5 MB but cached upstream).
	const listRes = await fetch(
		'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
		{ headers: { accept: 'application/json' } },
	);
	if (!listRes.ok) throw new Error(`coingecko list: ${listRes.status}`);
	const list = await listRes.json() as Array<{
		id: string; platforms: Record<string, string | null>;
	}>;
	const addressById = new Map<string, string>();
	for (const c of list) {
		const addr = c.platforms?.[platformKey];
		if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) addressById.set(c.id, addr);
	}

	// 3. Join + trim to top 50 with valid addresses.
	const tokens: PopularToken[] = [];
	for (const m of markets) {
		const address = addressById.get(m.id);
		if (!address) continue;
		tokens.push({
			address,
			symbol: m.symbol.toUpperCase(),
			name: m.name,
			// CoinGecko doesn't expose decimals on /coins/markets. 18 is the
			// ERC20 default and correct for almost every bridged token; the
			// trade page reads decimals on-chain when the user actually
			// selects the token, so a wrong default here gets corrected
			// before any math runs.
			decimals: 18,
			logo: m.image,
			rank: m.market_cap_rank ?? 999,
			priceUsd: m.current_price ?? 0,
		});
		if (tokens.length >= 50) break;
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
	// two requests per refresh is well under, and we only refresh once
	// per hour per chain anyway.
	try {
		const tokens = await refreshChain(chain, platformKey);
		const merged = { ...cache, [chain]: { tokens, updated_at: new Date().toISOString() } };
		await writeCache(merged);
		return json({ tokens, chain, cached: false, updated_at: merged[chain].updated_at });
	} catch (e: any) {
		// Refresh failed — serve whatever stale cache we have rather than
		// failing the request, so the modal still shows something.
		console.error('[popular-tokens] refresh failed:', e?.message || e);
		if (entry) {
			return json({ tokens: entry.tokens, chain, cached: true, stale: true, updated_at: entry.updated_at });
		}
		return json({ tokens: [], chain, error: 'refresh failed' }, { status: 502 });
	}
};
