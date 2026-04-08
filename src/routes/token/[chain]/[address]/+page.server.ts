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

export const load: PageServerLoad = async ({ params }) => {
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const tokenAddress = params.address?.toLowerCase() || '';
	const chain = CHAIN_MAP[chainSlug] || CHAIN_MAP.bsc;

	// Fetch DB + on-chain in parallel
	const [dbResult, onChainResult] = await Promise.all([
		// 1. DB metadata
		(async () => {
			try {
				const { data } = await supabaseAdmin
					.from('created_tokens')
					.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, type_key, logo_url, description, website, twitter, telegram, total_supply, created_at')
					.eq('address', tokenAddress)
					.eq('chain_id', chain.id)
					.single();
				return data;
			} catch { return null; }
		})(),

		// 2. On-chain ERC20 basics
		(async () => {
			try {
				const provider = new ethers.JsonRpcProvider(chain.rpc);
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
	]);

	return {
		chainSlug,
		tokenAddress,
		chain,
		dbData: dbResult,
		onChainData: onChainResult,
	};
};
