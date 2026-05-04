/**
 * Popular Tokens Updater — fetches CoinGecko's per-chain tokenlist
 * (Uniswap Token List Standard JSON) every `POPULAR_INTERVAL` seconds
 * (default 6h), stamps each entry with a market-cap rank from
 * /coins/markets, and writes the result directly to Supabase
 * `platform_config` (key=`popular_tokens`).
 *
 * Why the tokenlist endpoint (`tokens.coingecko.com/<chain>/all.json`):
 * it's what PancakeSwap and other DEXes consume, and it ships
 * `{address, symbol, name, decimals, logoURI}` for every token on
 * the chain in one response (~725 KB for BSC) — including logos for
 * the long tail. Previous versions had to chain-resolve logos
 * client-side via GeckoTerminal's per-token endpoint, which slammed
 * the 30-req/min free quota and surfaced as 429s in the picker.
 *
 * Why the daemon and not the CF Pages function: parsing megabytes of
 * upstream JSON inside a Cloudflare Pages Function blows the per-
 * request CPU budget (the production endpoint kept returning fast
 * 502s even though the same code worked locally). Keeping the work
 * in a long-running daemon and writing straight to Supabase via
 * service role keeps the user-facing GET endpoint as a pure DB read.
 *
 * Env vars:
 *   PUBLIC_SUPABASE_URL        — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Service-role key (DB write access)
 *   POPULAR_INTERVAL           — Refresh interval in seconds (default 21600 = 6h)
 *   POPULAR_CHAINS             — Optional comma-separated override of the chain
 *                                slugs to populate; defaults to every key in
 *                                CG_PLATFORM_BY_CHAIN below.
 */

import { createClient } from '@supabase/supabase-js';

// Our `network.symbol` (GeckoTerminal slug) → CoinGecko's chain key.
// The same slug is used as the CG `platforms` key on /coins/list and
// as the path segment on tokens.coingecko.com/<slug>/all.json.
// Mirror this map in the GET endpoint when you add a chain.
const CG_PLATFORM_BY_CHAIN: Record<string, string> = {
	bsc: 'binance-smart-chain',
	eth: 'ethereum',
	polygon: 'polygon-pos',
	arbitrum: 'arbitrum-one',
	base: 'base',
	avalanche: 'avalanche',
	optimism: 'optimistic-ethereum',
};

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERVAL_MS = parseInt(process.env.POPULAR_INTERVAL || '21600') * 1000;
const CHAINS = (process.env.POPULAR_CHAINS || Object.keys(CG_PLATFORM_BY_CHAIN).join(','))
	.split(',')
	.map((s) => s.trim().toLowerCase())
	.filter((s) => s in CG_PLATFORM_BY_CHAIN);

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('❌ PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
	process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface ChainToken {
	address: string;
	symbol: string;
	name: string;
	// On-chain decimals straight from the tokenlist (correct, not
	// defaulted to 18). The frontend still re-reads on-chain when the
	// user picks the token, so a wrong value here would self-correct,
	// but having the right one means correct USD math for the
	// preview row before they click.
	decimals: number;
	// Market-cap rank from CoinGecko's global top-N. Lower = more popular.
	// Tokens beyond the top-N (most of them) get `rank: 9999` so they
	// sort last but stay in the list for substring search to pick up.
	rank: number;
	// Logo URL straight from the tokenlist — every CG-known token on
	// the chain has one, so the picker no longer needs to lazy-resolve
	// per row via GeckoTerminal's rate-limited token endpoint.
	logo: string;
}

interface TokenListEntry {
	chainId: number;
	address: string;
	name: string;
	symbol: string;
	decimals: number;
	logoURI?: string;
}

async function fetchTokenList(slug: string): Promise<TokenListEntry[]> {
	const res = await fetch(`https://tokens.coingecko.com/${slug}/all.json`);
	if (!res.ok) throw new Error(`tokenlist ${slug}: ${res.status}`);
	const data = (await res.json()) as { tokens: TokenListEntry[] };
	return data.tokens || [];
}

async function refresh() {
	const ts = new Date().toISOString().slice(11, 19);
	try {
		// Three upstream sources, fetched in parallel:
		//  - /coins/list?include_platform=true → CG `id` ↔ chain address
		//    map. Needed to translate the rank-by-id from /coins/markets
		//    into a rank-by-address we can join against the tokenlist.
		//  - /coins/markets?per_page=250 → top 250 by market cap, gives
		//    us `id → rank`.
		//  - tokens.coingecko.com/<slug>/all.json (one per chain) →
		//    full per-chain inventory with addresses, decimals, logos.
		const tokenlistPromises = CHAINS.map((chain) =>
			fetchTokenList(CG_PLATFORM_BY_CHAIN[chain]).catch((e) => {
				console.error(`[${ts}] ✗ tokenlist ${chain}: ${e.message}`);
				return [] as TokenListEntry[];
			}),
		);
		const [listRes, marketsRes, ...tokenLists] = await Promise.all([
			fetch(
				'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
				{ headers: { accept: 'application/json' } },
			),
			fetch(
				'https://api.coingecko.com/api/v3/coins/markets'
					+ '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false',
				{ headers: { accept: 'application/json' } },
			),
			...tokenlistPromises,
		]);
		if (!listRes.ok) {
			console.error(`[${ts}] ✗ coingecko list ${listRes.status}`);
			return;
		}
		if (!marketsRes.ok) {
			console.error(`[${ts}] ✗ coingecko markets ${marketsRes.status}`);
			return;
		}
		const list = (await listRes.json()) as Array<{
			id: string;
			symbol: string;
			name: string;
			platforms: Record<string, string | null>;
		}>;
		const markets = (await marketsRes.json()) as Array<{
			id: string;
			market_cap_rank: number | null;
		}>;

		// id → rank from /coins/markets.
		const rankById = new Map<string, number>();
		for (const m of markets) {
			if (m.market_cap_rank != null) rankById.set(m.id, m.market_cap_rank);
		}

		const merged: Record<string, { tokens: ChainToken[]; updated_at: string }> = {};
		const updatedAt = new Date().toISOString();

		for (let i = 0; i < CHAINS.length; i++) {
			const chain = CHAINS[i];
			const platformKey = CG_PLATFORM_BY_CHAIN[chain];
			const tokenlist = tokenLists[i];

			// Per-chain address → rank map. We walk /coins/list once per
			// chain and only keep entries that have an address on this
			// platform; their CG `id` lets us look up the rank.
			const rankByAddress = new Map<string, number>();
			for (const c of list) {
				const addr = c.platforms?.[platformKey];
				if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
				const rank = rankById.get(c.id);
				if (rank != null) rankByAddress.set(addr.toLowerCase(), rank);
			}

			const tokens: ChainToken[] = [];
			for (const t of tokenlist) {
				if (!t.address || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) continue;
				const lower = t.address.toLowerCase();
				tokens.push({
					address: t.address,
					symbol: (t.symbol || '').toUpperCase(),
					name: t.name || '',
					decimals: typeof t.decimals === 'number' ? t.decimals : 18,
					rank: rankByAddress.get(lower) ?? 9999,
					logo: t.logoURI || '',
				});
			}

			// Sort by rank ascending, then symbol — stable order for the
			// frontend so paginated rendering surfaces well-known tokens
			// first and the long tail comes after.
			tokens.sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
			merged[chain] = { tokens, updated_at: updatedAt };
		}

		const { error } = await supabase
			.from('platform_config')
			.upsert({ key: 'popular_tokens', value: merged }, { onConflict: 'key' });
		if (error) {
			console.error(`[${ts}] ✗ supabase upsert: ${error.message}`);
			return;
		}

		const counts = CHAINS.map((c) => `${c}=${merged[c].tokens.length}`).join(' ');
		const ranked = CHAINS.map((c) => merged[c].tokens.filter((t) => t.rank < 9999).length).reduce((a, b) => a + b, 0);
		console.log(`[${ts}] ✓ ${counts} (ranked: ${ranked})`);
	} catch (e: any) {
		console.error(`[${ts}] ✗ ${e?.message || e}`);
	}
}

console.log(
	`[popular-tokens-updater] refreshing chains [${CHAINS.join(',')}] every ${INTERVAL_MS / 1000}s`,
);
refresh();
setInterval(refresh, INTERVAL_MS);
