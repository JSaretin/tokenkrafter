import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

const CHAIN_MAP: Record<string, { id: number; name: string; symbol: string; rpc: string; gecko: string; explorer: string }> = {
	bsc: { id: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', gecko: 'bsc', explorer: 'https://bscscan.com' },
	eth: { id: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://eth.llamarpc.com', gecko: 'eth', explorer: 'https://etherscan.io' },
	base: { id: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://mainnet.base.org', gecko: 'base', explorer: 'https://basescan.org' },
	arbitrum: { id: 42161, name: 'Arbitrum', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', gecko: 'arbitrum', explorer: 'https://arbiscan.io' },
	polygon: { id: 137, name: 'Polygon', symbol: 'MATIC', rpc: 'https://polygon-rpc.com', gecko: 'polygon_pos', explorer: 'https://polygonscan.com' },
};

const ERC20_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
];

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const tokenAddress = params.address?.toLowerCase() || '';
	const chain = CHAIN_MAP[chainSlug] || CHAIN_MAP.bsc;

	// Fetch DB + on-chain + GeckoTerminal in parallel
	const [dbResult, onChainResult, geckoResult] = await Promise.all([
		// 1. DB metadata
		(async () => {
			try {
				const { data } = await supabaseAdmin
					.from('created_tokens')
					.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, total_supply, logo_url, description, website, twitter, telegram, created_at')
					.eq('address', tokenAddress)
					.eq('chain_id', chain.id)
					.single();
				return data;
			} catch { return null; }
		})(),

		// 2. On-chain ERC20 basics
		(async () => {
			try {
				const provider = new ethers.JsonRpcProvider(chain.rpc, chain.id, { staticNetwork: true });
				const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
				const [name, symbol, decimals, supply] = await Promise.all([
					contract.name().catch(() => ''),
					contract.symbol().catch(() => ''),
					contract.decimals().catch(() => 18),
					contract.totalSupply().catch(() => 0n),
				]);
				return { name, symbol, decimals: Number(decimals), totalSupply: supply.toString() };
			} catch {
				return null;
			}
		})(),

		// 3. GeckoTerminal: token info + pools
		(async () => {
			try {
				const headers = { Accept: 'application/json;version=20230203' };
				const [tokenRes, poolsRes] = await Promise.all([
					fetch(`https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/tokens/${tokenAddress}`, { headers }),
					fetch(`https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/tokens/${tokenAddress}/pools`, { headers }),
				]);
				const tokenJson = tokenRes.ok ? await tokenRes.json() : null;
				const poolsJson = poolsRes.ok ? await poolsRes.json() : null;

				const attrs = tokenJson?.data?.attributes || {};
				const pools = (poolsJson?.data || []).map((p: any) => {
					const a = p.attributes || {};
					const baseId = p.relationships?.base_token?.data?.id || '';
					const quoteId = p.relationships?.quote_token?.data?.id || '';
					const dexId = p.relationships?.dex?.data?.id || '';
					return {
						address: a.address,
						name: a.name,
						dex: dexId,
						price_usd: a.base_token_price_usd,
						reserve_usd: parseFloat(a.reserve_in_usd || '0'),
						volume_24h: parseFloat(a.volume_usd?.h24 || '0'),
						price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
						txns_24h: (a.transactions?.h24?.buys || 0) + (a.transactions?.h24?.sells || 0),
						buys_24h: a.transactions?.h24?.buys || 0,
						sells_24h: a.transactions?.h24?.sells || 0,
						created_at: a.pool_created_at,
						base_token: baseId.split('_').pop() || '',
						quote_token: quoteId.split('_').pop() || '',
					};
				});

				return {
					price_usd: parseFloat(attrs.price_usd || '0'),
					fdv_usd: parseFloat(attrs.fdv_usd || '0'),
					total_reserve_usd: parseFloat(attrs.total_reserve_in_usd || '0'),
					volume_24h: parseFloat(attrs.volume_usd?.h24 || '0'),
					image_url: attrs.image_url || null,
					pools,
				};
			} catch {
				return null;
			}
		})(),
	]);

	return {
		chainSlug,
		tokenAddress,
		chain,
		dbData: dbResult,
		onChainData: onChainResult,
		geckoData: geckoResult,
	};
};
