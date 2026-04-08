import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const GECKO_NETWORKS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon_pos' };

export const load: PageServerLoad = async () => {
	const { data } = await supabaseAdmin
		.from('created_tokens')
		.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, type_key, logo_url, description, total_supply, created_at')
		.order('created_at', { ascending: false })
		.limit(200);

	const tokens = data || [];

	// Fetch GeckoTerminal prices for the first 30 tokens (server-side for instant render)
	const geckoData: Record<string, { price_usd: number; volume_24h: number; price_change_24h: number; has_data: boolean }> = {};
	if (tokens.length > 0) {
		// Group by chain
		const byChain: Record<string, string[]> = {};
		for (const t of tokens.slice(0, 30)) {
			const net = GECKO_NETWORKS[t.chain_id] || 'bsc';
			if (!byChain[net]) byChain[net] = [];
			byChain[net].push(t.address);
		}

		await Promise.all(Object.entries(byChain).map(async ([net, addrs]) => {
			try {
				const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/multi/${addrs.join(',')}`);
				if (!res.ok) return;
				const json = await res.json();
				for (const item of json?.data || []) {
					const a = item.attributes;
					if (!a) continue;
					const addr = (item.id || '').split('_').pop()?.toLowerCase();
					if (!addr) continue;
					// Only mark as has_data if there's an actual price (not just pool existence)
					geckoData[addr] = {
						price_usd: parseFloat(a.price_usd || '0'),
						volume_24h: parseFloat(a.volume_usd?.h24 || '0'),
						price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
						has_data: a.price_usd != null && parseFloat(a.price_usd) > 0,
					};
				}
			} catch {}
		}));
	}

	return { tokens, geckoData };
};
