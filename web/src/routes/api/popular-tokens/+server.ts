/**
 * GET /api/popular-tokens?chain=bsc
 *
 * Pure DB read of `platform_config[key='popular_tokens'].value.<chain>`.
 * The popular-tokens-updater daemon (`daemons/src/popular-tokens-updater.ts`)
 * is responsible for refreshing this row from CoinGecko's
 * `/coins/list?include_platform=true` every 6h. We don't fetch
 * upstream here because parsing CoinGecko's 2.6 MB response inside a
 * Cloudflare Pages Function blows the per-request CPU budget — every
 * call kept returning fast 502s. Keeping the endpoint as a single DB
 * read sidesteps that entirely.
 *
 * If the cache row is empty (daemon hasn't run yet), the endpoint
 * returns an empty list rather than 500'ing — the picker still works,
 * users just have to paste the address until the daemon populates the
 * row. Once populated, every chain switch is one DB read.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

interface ChainToken {
	address: string;
	symbol: string;
	name: string;
}

interface ChainCache {
	tokens: ChainToken[];
	updated_at: string;
}

export const GET: RequestHandler = async ({ url }) => {
	const chain = (url.searchParams.get('chain') || 'bsc').toLowerCase();

	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'popular_tokens')
		.maybeSingle();

	const cache = (data?.value as Record<string, ChainCache>) || {};
	const entry = cache[chain];

	if (!entry) {
		return json({ tokens: [], chain, updated_at: null });
	}
	return json({ tokens: entry.tokens, chain, updated_at: entry.updated_at });
};
