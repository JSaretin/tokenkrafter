/**
 * Token logo resolution with two-tier cache + rate-limited GeckoTerminal lookups.
 *
 * Priority on read:  KNOWN_LOGOS (sync) → in-memory cache → IndexedDB → network.
 * Priority on write: in-memory + IDB (so reloads skip the network).
 *
 * Why the rate limiter: the trade-page picker mounts hundreds of rows
 * with infinite scroll, and lazy-resolution per row used to fan out
 * concurrent fetches that blew GeckoTerminal's 30-req/min free quota
 * almost instantly (visible as 429s in the browser console). The
 * queue spaces requests ~2.5s apart, capping us at ~24/min — below
 * the limit, with a small margin for other GT consumers in the app.
 *
 * Negative results (no logo found) are cached too, with a shorter TTL,
 * so the queue isn't permanently filled with retries for tokens that
 * legitimately don't have an image upstream.
 */

import { idbGet, idbSet } from './idb';

const KNOWN_LOGOS: Record<string, string> = {
	'BNB': 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
	'WBNB': 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
	'ETH': 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
	'WETH': 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
	'USDT': 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
	'USDC': 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
	'BUSD': 'https://assets.coingecko.com/coins/images/9576/small/BUSD.png',
	'DAI': 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png',
	'MATIC': 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
	'AVAX': 'https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png',
};

// Persisted resolution cache: keep positives forever in IDB (logos
// rarely change), keep negatives only 24h so we retry occasionally
// in case GeckoTerminal indexes a token after first miss.
const LOGO_TTL_POSITIVE_MS = 0;                    // no expiry
const LOGO_TTL_NEGATIVE_MS = 24 * 60 * 60 * 1000;  // 24h

// Cache: address:chainId → logoUrl (or '' for no logo found)
const _cache = new Map<string, string>();
// In-flight fetches to avoid duplicate requests
const _pending = new Map<string, Promise<string>>();

function cacheKey(address: string, chainId: number): string {
	return `${address.toLowerCase()}:${chainId}`;
}

/** Get a known logo by symbol (instant, no fetch) */
export function getKnownLogo(symbol: string): string {
	return KNOWN_LOGOS[symbol?.toUpperCase()] || '';
}

/** Get cached logo if available (no fetch) */
export function getCachedLogo(address: string, chainId: number): string | undefined {
	return _cache.get(cacheKey(address, chainId));
}

/** Set a logo in cache (e.g. from token list data) */
export function setCachedLogo(address: string, chainId: number, logoUrl: string): void {
	_cache.set(cacheKey(address, chainId), logoUrl);
	// Persist for the next page load. No await — opportunistic.
	idbSet('logos', cacheKey(address, chainId), logoUrl, LOGO_TTL_POSITIVE_MS);
}

// ── Rate-limited queue for GeckoTerminal calls ─────────────────────────
// GT free tier = 30 req/min. We pace at ~24/min (1 every 2500ms) so we
// have headroom for other GT consumers (activity-bot, etc.) without
// stepping on each other.
const QUEUE_INTERVAL_MS = 2500;
let _lastFetchAt = 0;

async function paceQueue(): Promise<void> {
	const now = Date.now();
	const wait = Math.max(0, _lastFetchAt + QUEUE_INTERVAL_MS - now);
	_lastFetchAt = now + wait;
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * Resolve a token logo URL. Checks in-memory → IDB → GeckoTerminal/DB.
 * Returns '' if no logo found. The same in-flight promise is returned
 * to concurrent callers so the queue never schedules duplicate fetches
 * for the same address.
 */
export async function resolveTokenLogo(
	address: string,
	chainId: number = 56,
	geckoNetwork: string = 'bsc'
): Promise<string> {
	if (!address) return '';

	const key = cacheKey(address, chainId);

	// 1. In-memory cache.
	const cached = _cache.get(key);
	if (cached !== undefined) return cached;

	// 2. In-flight fetches.
	const pending = _pending.get(key);
	if (pending) return pending;

	// 3. IDB-persisted cache.
	const persisted = await idbGet<string>('logos', key);
	if (persisted !== null) {
		_cache.set(key, persisted);
		return persisted;
	}

	// 4. Network — paced by the queue.
	const promise = (async () => {
		await paceQueue();
		const url = await _fetchLogo(address, chainId, geckoNetwork);
		_cache.set(key, url);
		// Persist positives forever, negatives short — see TTL constants above.
		idbSet('logos', key, url, url ? LOGO_TTL_POSITIVE_MS : LOGO_TTL_NEGATIVE_MS);
		return url;
	})();
	_pending.set(key, promise);

	try {
		return await promise;
	} finally {
		_pending.delete(key);
	}
}

async function _fetchLogo(address: string, chainId: number, geckoNetwork: string): Promise<string> {
	const addr = address.toLowerCase();

	// 1. GeckoTerminal (free, no DB cost)
	try {
		const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/tokens/${addr}`);
		if (res.ok) {
			const data = await res.json();
			const img = data?.data?.attributes?.image_url;
			if (img && !img.includes('missing') && img.startsWith('http')) return img;
		}
	} catch {}

	// 2. Our DB (last resort — costs IO budget)
	try {
		const res = await fetch(`/api/token-metadata?address=${addr}&chain_id=${chainId}`);
		if (res.ok) {
			const data = await res.json();
			if (data?.logo_url) return data.logo_url;
		}
	} catch {}

	return '';
}

/** Clear the entire cache (useful on network switch) */
export function clearLogoCache(): void {
	_cache.clear();
}
