/**
 * Token logo resolution with in-memory cache.
 * Priority: KNOWN_LOGOS → DB → GeckoTerminal → '' (empty)
 */

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
}

/**
 * Resolve a token logo URL. Checks cache first, then fetches from DB and GeckoTerminal.
 * Returns '' if no logo found.
 */
export async function resolveTokenLogo(
	address: string,
	chainId: number = 56,
	geckoNetwork: string = 'bsc'
): Promise<string> {
	if (!address) return '';

	const key = cacheKey(address, chainId);

	// Check cache
	const cached = _cache.get(key);
	if (cached !== undefined) return cached;

	// Check if already fetching
	const pending = _pending.get(key);
	if (pending) return pending;

	// Fetch
	const promise = _fetchLogo(address, chainId, geckoNetwork);
	_pending.set(key, promise);

	try {
		const result = await promise;
		_cache.set(key, result);
		return result;
	} finally {
		_pending.delete(key);
	}
}

async function _fetchLogo(address: string, chainId: number, geckoNetwork: string): Promise<string> {
	const addr = address.toLowerCase();

	// 1. Our DB
	try {
		const res = await fetch(`/api/token-metadata?address=${addr}&chain_id=${chainId}`);
		if (res.ok) {
			const data = await res.json();
			if (data?.logo_url) return data.logo_url;
		}
	} catch {}

	// 2. GeckoTerminal
	try {
		const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/tokens/${addr}`);
		if (res.ok) {
			const data = await res.json();
			const img = data?.data?.attributes?.image_url;
			if (img && !img.includes('missing') && img.startsWith('http')) return img;
		}
	} catch {}

	return '';
}

/** Clear the entire cache (useful on network switch) */
export function clearLogoCache(): void {
	_cache.clear();
}
