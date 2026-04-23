import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

const CHAIN_MAP: Record<string, number> = {
	bsc: 56, eth: 1, base: 8453, arbitrum: 42161, polygon: 137,
};

const CHAIN_RPC: Record<number, string> = {
	56: 'https://bsc-dataseed.binance.org/',
	1: 'https://eth.llamarpc.com',
	8453: 'https://mainnet.base.org',
	42161: 'https://arb1.arbitrum.io/rpc',
	137: 'https://polygon-rpc.com',
};

const LAUNCH_INFO_ABI = [
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)',
	'function totalTokensRequired() view returns (uint256)',
	'function totalTokensDeposited() view returns (uint256)',
	'function effectiveState() view returns (uint8)',
	'function totalBuyers() view returns (uint256)',
	'function totalPurchases() view returns (uint256)',
	'function token() view returns (address)',
];

const TOKEN_META_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
];

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=30, s-maxage=60' });
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const launchAddress = params.address?.toLowerCase() || '';
	const chainId = CHAIN_MAP[chainSlug] || 56;

	// Fetch launch data from DB
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('*')
		.eq('address', launchAddress)
		.eq('chain_id', chainId)
		.single();

	// If DB has no data, fallback to RPC
	if (!launch) {
		const rpc = CHAIN_RPC[chainId];
		if (!rpc) return { chainSlug, chainId, launchAddress, launch: null, badges: [], tokenTrust: null };

		try {
			const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
			const instance = new ethers.Contract(launchAddress, LAUNCH_INFO_ABI, provider);

			const [info, totalTokensRequired, totalTokensDeposited, effectiveState, totalBuyers, totalPurchases] = await Promise.all([
				instance.getLaunchInfo(),
				instance.totalTokensRequired(),
				instance.totalTokensDeposited(),
				instance.effectiveState().catch(() => null),
				instance.totalBuyers().catch(() => 0n),
				instance.totalPurchases().catch(() => 0n),
			]);

			const state = effectiveState != null ? Number(effectiveState) : Number(info.state_);
			const tokenAddress = info.token_;

			// Fetch token metadata
			const tokenContract = new ethers.Contract(tokenAddress, TOKEN_META_ABI, provider);
			const [name, symbol, decimals] = await Promise.all([
				tokenContract.name().catch(() => 'Unknown'),
				tokenContract.symbol().catch(() => '???'),
				tokenContract.decimals().catch(() => 18),
			]);

			// Check if token is in DB (platform token). Supabase returns
			// { data, error } rather than throwing, so no try/catch needed.
			const { data: tokenData } = await supabaseAdmin
				.from('created_tokens')
				.select('name, symbol, decimals, is_safu, is_kyc, has_liquidity, lp_burned, lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled, buy_tax_bps, sell_tax_bps, is_taxable, is_mintable, is_partner, logo_url')
				.eq('address', tokenAddress.toLowerCase())
				.eq('chain_id', chainId)
				.single();

			const rpcLaunch = {
				address: launchAddress,
				token_address: tokenAddress,
				creator: info.creator_,
				curve_type: Number(info.curveType_),
				state,
				soft_cap: info.softCap_.toString(),
				hard_cap: info.hardCap_.toString(),
				deadline: Number(info.deadline_),
				start_timestamp: Number(info.startTimestamp_),
				total_base_raised: info.totalBaseRaised_.toString(),
				tokens_sold: info.tokensSold_.toString(),
				tokens_for_curve: info.tokensForCurve_.toString(),
				tokens_for_lp: info.tokensForLP_.toString(),
				creator_allocation_bps: Number(info.creatorAllocationBps_),
				current_price: info.currentPrice_.toString(),
				usdt_address: info.usdt_,
				total_tokens_required: totalTokensRequired.toString(),
				total_tokens_deposited: totalTokensDeposited.toString(),
				total_buyers: Number(totalBuyers),
				total_purchases: Number(totalPurchases),
				token_name: name,
				token_symbol: symbol,
				token_decimals: Number(decimals),
				usdt_decimals: 18,
				logo_url: tokenData?.logo_url || '',
				description: '',
			};

			return {
				chainSlug,
				chainId,
				launchAddress,
				launch: rpcLaunch,
				badges: [],
				tokenTrust: tokenData || null,
			};
		} catch {
			return { chainSlug, chainId, launchAddress, launch: null, badges: [], tokenTrust: null };
		}
	}

	// Fetch badges + token trust signals in parallel
	const tokenAddress = launch?.token_address?.toLowerCase();
	const [badgesResult, tokenResult] = await Promise.all([
		supabaseAdmin
			.from('badges')
			.select('badge_type')
			.eq('launch_address', launchAddress)
			.eq('chain_id', chainId),
		tokenAddress
			? supabaseAdmin
				.from('created_tokens')
				.select('name, symbol, decimals, is_safu, is_kyc, has_liquidity, lp_burned, lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled, buy_tax_bps, sell_tax_bps, is_taxable, is_mintable, is_partner, logo_url')
				.eq('address', tokenAddress)
				.eq('chain_id', chainId)
				.single()
			: Promise.resolve({ data: null }),
	]);

	// Fill missing launch fields from token data
	if (launch && tokenResult.data) {
		if (!launch.token_name && tokenResult.data.name) launch.token_name = tokenResult.data.name;
		if (!launch.token_symbol && tokenResult.data.symbol) launch.token_symbol = tokenResult.data.symbol;
		if (!launch.token_decimals && tokenResult.data.decimals) launch.token_decimals = tokenResult.data.decimals;
	}
	if (launch && !launch.logo_url && tokenResult.data?.logo_url) {
		launch.logo_url = tokenResult.data.logo_url;
	}

	return {
		chainSlug,
		chainId,
		launchAddress,
		launch,
		badges: badgesResult.data?.map(b => b.badge_type) || [],
		tokenTrust: tokenResult.data || null,
	};
};
