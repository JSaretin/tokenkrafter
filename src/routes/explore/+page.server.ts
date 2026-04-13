import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { getNetworks } from '$lib/platformConfig';
import { ethers } from 'ethers';

const GECKO_NETWORKS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon_pos' };

const SUPPLY_ABI = ['function totalSupply() view returns (uint256)'];

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });

	// Load DB rows and network config in parallel.
	const [tokensResult, networks] = await Promise.all([
		supabaseAdmin
			.from('created_tokens')
			.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, total_supply, logo_url, description, created_at, is_safu, has_liquidity, lp_burned, lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled, buy_tax_bps, sell_tax_bps')
			.order('is_safu', { ascending: false })
			.order('has_liquidity', { ascending: false })
			.order('created_at', { ascending: false })
			.limit(200),
		getNetworks(),
	]);

	const tokens = tokensResult.data || [];
	const rpcByChain: Record<number, string> = {};
	for (const n of networks) {
		if (n.rpc) rpcByChain[n.chain_id] = n.rpc;
	}

	// Fetch GeckoTerminal prices + live on-chain supply for the first 30 tokens
	// in parallel so the above-the-fold cards render instantly on SSR.
	const geckoData: Record<string, { price_usd: number; volume_24h: number; price_change_24h: number; has_data: boolean }> = {};
	const supplyData: Record<string, string> = {};

	if (tokens.length > 0) {
		const topTokens = tokens.slice(0, 30);

		// Group by gecko network slug for the price fetch
		const geckoByNet: Record<string, string[]> = {};
		// Group by chain_id for the supply fetch
		const supplyByChain: Record<number, string[]> = {};
		for (const t of topTokens) {
			const net = GECKO_NETWORKS[t.chain_id] || 'bsc';
			if (!geckoByNet[net]) geckoByNet[net] = [];
			geckoByNet[net].push(t.address);
			if (!supplyByChain[t.chain_id]) supplyByChain[t.chain_id] = [];
			supplyByChain[t.chain_id].push(t.address);
		}

		const geckoFetches = Object.entries(geckoByNet).map(async ([net, addrs]) => {
			try {
				const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/multi/${addrs.join(',')}`);
				if (!res.ok) return;
				const json = await res.json();
				for (const item of json?.data || []) {
					const a = item.attributes;
					if (!a) continue;
					const addr = (item.id || '').split('_').pop()?.toLowerCase();
					if (!addr) continue;
					geckoData[addr] = {
						price_usd: parseFloat(a.price_usd || '0'),
						volume_24h: parseFloat(a.volume_usd?.h24 || '0'),
						price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
						has_data: a.price_usd != null && parseFloat(a.price_usd) > 0,
					};
				}
			} catch {}
		});

		const supplyFetches = Object.entries(supplyByChain).map(async ([cidStr, addrs]) => {
			const cid = Number(cidStr);
			const rpc = rpcByChain[cid];
			if (!rpc) return;
			try {
				const provider = new ethers.JsonRpcProvider(rpc, cid, { staticNetwork: true });
				await Promise.all(addrs.map(async (addr) => {
					try {
						const c = new ethers.Contract(addr, SUPPLY_ABI, provider);
						const s: bigint = await c.totalSupply();
						supplyData[`${cid}:${addr.toLowerCase()}`] = s.toString();
					} catch {}
				}));
			} catch {}
		});

		await Promise.all([...geckoFetches, ...supplyFetches]);
	}

	return { tokens, geckoData, supplyData };
};
