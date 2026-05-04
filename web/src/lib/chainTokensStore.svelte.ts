/**
 * Chain-tokens store — shared cache of CoinGecko-known tokens per chain.
 *
 * Reads directly from CoinGecko's per-chain tokenlist CDN
 * (`tokens.coingecko.com/<slug>/all.json`) — the same endpoint
 * PancakeSwap and other DEXes consume. The response is CORS-enabled
 * (`access-control-allow-origin: *`) and Cloudflare-cached
 * (`max-age=1800`), so we get globally-edged delivery for free without
 * needing our own server route or daemon in the hot path.
 *
 * Each entry on the wire has `{address, name, symbol, decimals, logoURI}` —
 * no rank from this endpoint, but the file is small enough (~700 KB
 * for BSC, ~1.2 MB for ethereum) that we cache the whole thing in IDB
 * with a 6h TTL and serve stale-while-revalidate on subsequent loads
 * so the picker is instant on revisit.
 *
 * Stale-while-revalidate semantics: on read, if we have any cached
 * data we surface it immediately (even if past TTL); concurrently we
 * kick off a background refresh that updates the cache + reactive
 * state when fresh data lands. So users never wait on the network
 * after the first session.
 */

import { idbGet, idbSet } from './idb';

export type ChainToken = {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	logo: string;
};

// Our `network.symbol` slug → CoinGecko's path segment on
// tokens.coingecko.com. Mirrors the daemon's chain map. Add new
// chains here when they come online.
const CG_PATH_BY_CHAIN: Record<string, string> = {
	bsc: 'binance-smart-chain',
	eth: 'ethereum',
	polygon: 'polygon-pos',
	arbitrum: 'arbitrum-one',
	base: 'base',
	avalanche: 'avalanche',
	optimism: 'optimistic-ethereum',
};

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — well past the CDN's 30min, comfortable for a token list.

const _cache = $state<Record<string, ChainToken[]>>({});
const _inflight = new Set<string>();

/**
 * Synchronous, reactive read of the cached list for a chain. Returns
 * `[]` if the slug hasn't been preloaded yet — consumers using
 * `$derived` will re-run when the cache populates.
 */
export function getChainTokens(slug: string): ChainToken[] {
	if (!slug) return [];
	return _cache[slug.toLowerCase()] || [];
}

/**
 * Kick off a fetch for the given chain. Idempotent — concurrent
 * calls dedupe via the in-flight set; once resolved, repeat calls
 * for the same slug within the TTL no-op. Safe to fire from
 * `onMount` in the root layout to warm the cache during app idle.
 */
export async function preloadChainTokens(slug: string): Promise<void> {
	if (!slug) return;
	const key = slug.toLowerCase();
	const cgPath = CG_PATH_BY_CHAIN[key];
	if (!cgPath) return;
	if (_inflight.has(key)) return;

	// Stale-while-revalidate: surface IDB-cached data immediately even
	// if it's past TTL. The decision to actually re-fetch happens after.
	if (_cache[key] === undefined) {
		const persisted = await idbGet<ChainToken[]>('tradelens', `chain-tokens:${key}`);
		if (persisted) _cache[key] = persisted;
	}

	// If we already have hot data within TTL, no refresh needed.
	const lastFetchedAt = await idbGet<number>('tradelens', `chain-tokens:${key}:ts`);
	if (lastFetchedAt && Date.now() - lastFetchedAt < TTL_MS && _cache[key]?.length) return;

	_inflight.add(key);
	try {
		const res = await fetch(`https://tokens.coingecko.com/${cgPath}/all.json`);
		if (!res.ok) return;
		const data = (await res.json()) as {
			tokens?: Array<{
				chainId: number;
				address: string;
				name: string;
				symbol: string;
				decimals: number;
				logoURI?: string;
			}>;
		};
		const tokens: ChainToken[] = [];
		for (const t of data.tokens || []) {
			if (!t.address || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) continue;
			tokens.push({
				address: t.address,
				symbol: (t.symbol || '').toUpperCase(),
				name: t.name || '',
				decimals: typeof t.decimals === 'number' ? t.decimals : 18,
				logo: t.logoURI || '',
			});
		}
		_cache[key] = tokens;
		// Persist asynchronously — opportunistic, no need to await.
		idbSet('tradelens', `chain-tokens:${key}`, tokens, 0);
		idbSet('tradelens', `chain-tokens:${key}:ts`, Date.now(), 0);
	} catch {
		// Network failure is fine — we keep whatever's already in cache,
		// and the next preload call will retry.
	} finally {
		_inflight.delete(key);
	}
}
