/**
 * Popular Tokens Updater — fetches CoinGecko's full coins-list every
 * `POPULAR_INTERVAL` seconds (default 6h), filters tokens that exist
 * on each supported chain, writes the result directly to Supabase
 * `platform_config` (key=`popular_tokens`).
 *
 * Why a daemon and not the CF Pages function: parsing CoinGecko's
 * 2.6 MB /coins/list response inside a Cloudflare Pages Function blows
 * the per-request CPU budget — the production endpoint kept returning
 * fast 502s even though the same code worked locally. Moving the
 * upstream fetch + filter into a long-running daemon and writing
 * straight to Supabase via service role keeps the user-facing GET
 * endpoint as a pure DB read (instant, no CPU pressure).
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

// Our `network.symbol` (GeckoTerminal slug) → CoinGecko's `platforms` key.
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
	// Market-cap rank from CoinGecko's global top-N. Lower = more popular.
	// Tokens beyond the top-N (most of them) get `rank: 9999` so they sort
	// last but stay in the list for substring search to pick up.
	rank: number;
}

async function refresh() {
	const ts = new Date().toISOString().slice(11, 19);
	try {
		// Two upstream calls. /coins/list gives us the full token universe
		// with on-chain addresses (~17k entries). /coins/markets gives us
		// the top 250 by market cap with their CG `id` — we use it to
		// stamp a rank on each chain token so the picker can show the
		// well-known ones first without having to type a query.
		const [listRes, marketsRes] = await Promise.all([
			fetch(
				'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
				{ headers: { accept: 'application/json' } },
			),
			fetch(
				'https://api.coingecko.com/api/v3/coins/markets'
					+ '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false',
				{ headers: { accept: 'application/json' } },
			),
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
		console.log(`[${ts}] coingecko: ${list.length} tokens, ${markets.length} ranked`);

		const rankById = new Map<string, number>();
		for (const m of markets) {
			if (m.market_cap_rank != null) rankById.set(m.id, m.market_cap_rank);
		}

		const merged: Record<string, { tokens: ChainToken[]; updated_at: string }> = {};
		const updatedAt = new Date().toISOString();

		for (const chain of CHAINS) {
			const platformKey = CG_PLATFORM_BY_CHAIN[chain];
			const tokens: ChainToken[] = [];
			for (const c of list) {
				const addr = c.platforms?.[platformKey];
				if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
				tokens.push({
					address: addr,
					symbol: c.symbol.toUpperCase(),
					name: c.name,
					rank: rankById.get(c.id) ?? 9999,
				});
			}
			// Sort by rank ascending, then symbol — stable order for the
			// frontend so "show top N" is meaningful and substring search
			// still hits well-known tokens first.
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
		console.log(`[${ts}] ✓ ${counts}`);
	} catch (e: any) {
		console.error(`[${ts}] ✗ ${e?.message || e}`);
	}
}

console.log(
	`[popular-tokens-updater] refreshing chains [${CHAINS.join(',')}] every ${INTERVAL_MS / 1000}s`,
);
refresh();
setInterval(refresh, INTERVAL_MS);
