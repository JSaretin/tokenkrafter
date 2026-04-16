import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';
import { queryTradeLens } from '$lib/tradeLens';
import { getNetworks } from '$lib/platformConfig';

const CHAIN_MAP: Record<string, { id: number; name: string; symbol: string; rpc: string; explorer: string }> = {
	bsc: { id: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-dataseed.binance.org/', explorer: 'https://bscscan.com' },
	eth: { id: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://eth.llamarpc.com', explorer: 'https://etherscan.io' },
	base: { id: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
	arbitrum: { id: 42161, name: 'Arbitrum', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
	polygon: { id: 137, name: 'Polygon', symbol: 'MATIC', rpc: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com' },
};

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const tokenAddress = params.address?.toLowerCase() || '';
	const chain = CHAIN_MAP[chainSlug] || CHAIN_MAP.bsc;

	// Fetch DB + TradeLensV2 (on-chain: token info + pools + tax) in parallel
	const [dbResult, lensResult] = await Promise.all([
		// 1. DB metadata
		(async () => {
			try {
				const { data } = await supabaseAdmin
					.from('created_tokens')
					.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, total_supply, logo_url, description, website, twitter, telegram, created_at, is_safu, has_liquidity, lp_burned, lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled, buy_tax_bps, sell_tax_bps')
					.eq('address', tokenAddress)
					.eq('chain_id', chain.id)
					.single();
				return data;
			} catch { return null; }
		})(),

		// 2. TradeLensV2: token info + all pools + tax sim in one eth_call
		(async () => {
			try {
				// Get network config for dex_router + base tokens
				const networks = await getNetworks();
				const net = networks.find(n => n.chain_id === chain.id);
				if (!net?.dex_router) return null;

				const provider = new ethers.JsonRpcProvider(chain.rpc, chain.id, { staticNetwork: true });

				// Base tokens to check pools for (from network.default_bases + WETH)
				const baseTokens: string[] = [];
				const routerContract = new ethers.Contract(net.dex_router, ['function WETH() view returns (address)'], provider);
				const weth = await routerContract.WETH().catch(() => '');
				if (weth) baseTokens.push(weth);
				if (net.usdt_address && !baseTokens.includes(net.usdt_address)) baseTokens.push(net.usdt_address);
				if (net.usdc_address && !baseTokens.includes(net.usdc_address)) baseTokens.push(net.usdc_address);
				// Add any default_bases not already included
				for (const b of (net as any).default_bases || []) {
					if (b.address && !baseTokens.some((x: string) => x.toLowerCase() === b.address.toLowerCase())) {
						baseTokens.push(b.address);
					}
				}

				const result = await queryTradeLens(
					provider,
					net.dex_router,
					[tokenAddress],       // single token
					tokenAddress,          // simulateTax for this token
					ethers.parseEther('0.001'),
					ethers.ZeroAddress,    // no user
					chain.id,
					baseTokens,
				);

				// Resolve base token symbols for pool names
				const baseSymbols: Record<string, string> = {};
				if (weth) baseSymbols[weth.toLowerCase()] = net.native_coin || 'BNB';
				if (net.usdt_address) baseSymbols[net.usdt_address.toLowerCase()] = 'USDT';
				if (net.usdc_address) baseSymbols[net.usdc_address.toLowerCase()] = 'USDC';
				for (const b of (net as any).default_bases || []) {
					if (b.address) baseSymbols[b.address.toLowerCase()] = b.symbol || '???';
				}

				const tokenInfo = result.tokens?.[0] || null;
				const DEAD = '0x000000000000000000000000000000000000dEaD';
				const LP_ABI = [
					'function balanceOf(address) view returns (uint256)',
					'function totalSupply() view returns (uint256)',
				];
				const rawPools = (tokenInfo?.pools || [])
					.filter((p: any) => p.pairAddress && p.pairAddress !== ethers.ZeroAddress);

				// Batch LP burn checks in parallel
				const pools = await Promise.all(rawPools.map(async (p: any) => {
					const baseSym = baseSymbols[p.base?.toLowerCase()] || p.base?.slice(0, 6) || '???';
					const sym = tokenInfo?.symbol || '???';
					let lp_burned = false;
					let lp_burned_pct = 0;
					try {
						const pair = new ethers.Contract(p.pairAddress, LP_ABI, provider);
						const [deadBal, totalLp] = await Promise.all([
							pair.balanceOf(DEAD),
							pair.totalSupply(),
						]);
						if (deadBal > 0n && totalLp > 0n) {
							lp_burned = true;
							lp_burned_pct = Number((deadBal * 10000n) / totalLp);
						}
					} catch {}
					return {
						address: p.pairAddress,
						name: `${sym} / ${baseSym}`,
						base: p.base,
						base_symbol: baseSym,
						reserve_token: p.reserveToken?.toString() || '0',
						reserve_base: p.reserveBase?.toString() || '0',
						has_liquidity: p.hasLiquidity,
						lp_burned,
						lp_burned_pct,
					};
				}));

				return {
					tokenInfo: tokenInfo ? {
						name: tokenInfo.name,
						symbol: tokenInfo.symbol,
						decimals: tokenInfo.decimals,
						totalSupply: tokenInfo.totalSupply?.toString() || '0',
						hasLiquidity: tokenInfo.hasLiquidity,
					} : null,
					pools,
					taxInfo: result.taxInfo || null,
				};
			} catch (e) {
				console.warn('TradeLensV2 failed:', (e as any)?.message?.slice(0, 80));
				return null;
			}
		})(),
	]);

	return {
		chainSlug,
		tokenAddress,
		chain,
		dbData: dbResult,
		lensData: lensResult,
	};
};
