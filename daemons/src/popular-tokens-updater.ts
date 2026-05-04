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
}

async function refresh() {
	const ts = new Date().toISOString().slice(11, 19);
	try {
		const res = await fetch(
			'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
			{ headers: { accept: 'application/json' } },
		);
		if (!res.ok) {
			console.error(`[${ts}] ✗ coingecko ${res.status}`);
			return;
		}
		const list = (await res.json()) as Array<{
			id: string;
			symbol: string;
			name: string;
			platforms: Record<string, string | null>;
		}>;
		console.log(`[${ts}] coingecko returned ${list.length} tokens total`);

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
				});
			}
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
