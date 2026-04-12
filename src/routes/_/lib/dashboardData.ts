/**
 * Admin dashboard data loaders.
 *
 * Pulled out of DashboardTab.svelte so the component can focus on rendering.
 * These functions are pure async fetchers — they return data, they don't
 * mutate Svelte state. The caller owns the `$state` assignments.
 */

import { ethers } from 'ethers';
import { FACTORY_ABI, ERC20_ABI } from '$lib/tokenCrafter';
import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
import { queryAdminLens, type AdminLensResult, type TokenInfo, type LaunchInfo } from '$lib/adminLens';
import type { SupportedNetwork } from '$lib/structure';

export type { AdminLensResult, TokenInfo, LaunchInfo };

export type DailyStats = {
	stat_date: string;
	tokens_created: number;
	partner_tokens_created: number;
	creation_fees_usdt: number;
	launches_created: number;
	launches_graduated: number;
	total_raised_usdt: number;
	launch_fees_usdt: number;
	tax_revenue_usdt: number;
};

export type DashboardData = {
	daily: DailyStats[];
	totals: DailyStats & { total_tokens: number };
	visitors: { total_visitors: number; browsing: number; creating: number; investing: number };
};

export type ChainData = {
	network: SupportedNetwork;
	totalTokens: bigint;
	totalLaunches: bigint;
	totalFeeUsdt: bigint;
	tokenFeeUsdt: bigint;
	launchFeeUsdt: bigint;
	launchFee: string;
	platformWallet: string;
	owner: string;
	usdtDecimals: number;
	isOwner: boolean;
	/** Token count per type key (0-7): basic, mintable, taxable, tax+mint, partner, partner+mint, partner+tax, partner+tax+mint */
	countPerType: number[];
	/** Creation fee per type key (raw bigint) */
	feesPerType: bigint[];
};

/**
 * Fetch on-chain state for every supported chain that has a deployed
 * platform. Uses each factory's `getState()` to batch-read owner, totals,
 * and fee accrual in one call.
 */
export async function loadAllChains(
	supportedNetworks: SupportedNetwork[],
	providers: Map<number, ethers.JsonRpcProvider>,
	userAddress: string | null,
): Promise<ChainData[]> {
	const results: ChainData[] = [];

	for (const net of supportedNetworks) {
		if (!net.platform_address || net.platform_address === '0x') continue;
		const provider = providers.get(net.chain_id);
		if (!provider) continue;

		try {
			const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, provider);

			// Single getState() call — matches the contract's current shape:
			//   (owner, totalTokens, totalFeeUsdt, feesPerType[8], countPerType[8],
			//    taxToStable, taxSlippage, refLevels, autoDistribute)
			const [owner, totalTokens, tokenFeeUsdt, feesPerTypeRaw, countPerTypeRaw] = await factory.getState();

			let lpTotal = 0n, lpFeeUsdt = 0n, lpFee = '0', lpPW = '';
			let ud = 18;

			try {
				const usdtC = new ethers.Contract(await factory.usdt(), ERC20_ABI, provider);
				ud = Number(await usdtC.decimals());
			} catch {}

			if (net.launchpad_address && net.launchpad_address !== '0x') {
				try {
					const lp = new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
					// LaunchpadFactory.getState() returns (owner, total, totalFee, launchFee).
					const [, lpTotalCount, lpTotalFee, lpFeeRaw] = await lp.getState();
					lpTotal = lpTotalCount;
					lpFeeUsdt = lpTotalFee;
					lpFee = ethers.formatUnits(lpFeeRaw, ud);
					lpPW = await lp.platformWallet();
				} catch {}
			}

			results.push({
				network: net,
				totalTokens,
				totalLaunches: lpTotal,
				totalFeeUsdt: tokenFeeUsdt + lpFeeUsdt,
				tokenFeeUsdt,
				launchFeeUsdt: lpFeeUsdt,
				launchFee: lpFee,
				platformWallet: lpPW,
				owner,
				usdtDecimals: ud,
				isOwner: userAddress ? userAddress.toLowerCase() === owner.toLowerCase() : false,
				countPerType: (countPerTypeRaw || []).map((n: bigint) => Number(n)),
				feesPerType: feesPerTypeRaw || [],
			});
		} catch {}
	}

	return results;
}

export type DateRange =
	| { kind: 'days'; days: number }
	| { kind: 'absolute'; from: string; to?: string };

function rangeToQuery(range: DateRange | undefined): string {
	if (!range) return 'days=90';
	if (range.kind === 'days') return `days=${range.days}`;
	const parts = [`from=${encodeURIComponent(range.from)}`];
	if (range.to) parts.push(`to=${encodeURIComponent(range.to)}`);
	return parts.join('&');
}

/**
 * Fetch + merge cross-chain platform stats from Supabase. Aggregates the
 * per-chain `/api/platform-stats` responses into a single DashboardData.
 *
 * `range` controls the window: defaults to last 90 days when omitted.
 */
export async function loadDashboardStats(
	supportedNetworks: SupportedNetwork[],
	range?: DateRange,
): Promise<{ data: DashboardData; recentLaunches: any[] }> {
	const activeChains = supportedNetworks.filter(
		(n) => n.platform_address && n.platform_address !== '0x',
	);
	const qs = rangeToQuery(range);
	const statsFetches = activeChains.map((n) =>
		fetch(`/api/platform-stats?chain_id=${n.chain_id}&${qs}`).then((r) => (r.ok ? r.json() : null)),
	);
	const launchesRes = await fetch(`/api/launches?limit=10`);

	const allStats = await Promise.all(statsFetches);

	const merged: DashboardData = {
		daily: [],
		totals: {
			tokens_created: 0,
			partner_tokens_created: 0,
			creation_fees_usdt: 0,
			launches_created: 0,
			launches_graduated: 0,
			total_raised_usdt: 0,
			launch_fees_usdt: 0,
			tax_revenue_usdt: 0,
			stat_date: '',
			total_tokens: 0,
		},
		visitors: { total_visitors: 0, browsing: 0, creating: 0, investing: 0 },
	};

	const dailyMap = new Map<string, DailyStats>();
	for (const stats of allStats) {
		if (!stats) continue;
		const t = stats.totals;
		merged.totals.tokens_created += t.tokens_created || 0;
		merged.totals.partner_tokens_created += t.partner_tokens_created || 0;
		merged.totals.creation_fees_usdt += t.creation_fees_usdt || 0;
		merged.totals.launches_created += t.launches_created || 0;
		merged.totals.launches_graduated += t.launches_graduated || 0;
		merged.totals.total_raised_usdt += t.total_raised_usdt || 0;
		merged.totals.launch_fees_usdt += t.launch_fees_usdt || 0;
		merged.totals.tax_revenue_usdt += t.tax_revenue_usdt || 0;
		merged.totals.total_tokens += t.total_tokens || 0;

		if (stats.visitors) {
			merged.visitors.total_visitors = Math.max(
				merged.visitors.total_visitors,
				stats.visitors.total_visitors || 0,
			);
			merged.visitors.browsing += stats.visitors.browsing || 0;
			merged.visitors.creating += stats.visitors.creating || 0;
			merged.visitors.investing += stats.visitors.investing || 0;
		}

		for (const day of stats.daily || []) {
			const existing = dailyMap.get(day.stat_date);
			if (existing) {
				existing.tokens_created += day.tokens_created || 0;
				existing.partner_tokens_created += day.partner_tokens_created || 0;
				existing.creation_fees_usdt += parseFloat(day.creation_fees_usdt) || 0;
				existing.launches_created += day.launches_created || 0;
				existing.launches_graduated += day.launches_graduated || 0;
				existing.total_raised_usdt += parseFloat(day.total_raised_usdt) || 0;
				existing.launch_fees_usdt += parseFloat(day.launch_fees_usdt) || 0;
				existing.tax_revenue_usdt += parseFloat(day.tax_revenue_usdt) || 0;
			} else {
				dailyMap.set(day.stat_date, {
					stat_date: day.stat_date,
					tokens_created: day.tokens_created || 0,
					partner_tokens_created: day.partner_tokens_created || 0,
					creation_fees_usdt: parseFloat(day.creation_fees_usdt) || 0,
					launches_created: day.launches_created || 0,
					launches_graduated: day.launches_graduated || 0,
					total_raised_usdt: parseFloat(day.total_raised_usdt) || 0,
					launch_fees_usdt: parseFloat(day.launch_fees_usdt) || 0,
					tax_revenue_usdt: parseFloat(day.tax_revenue_usdt) || 0,
				});
			}
		}
	}

	merged.daily = [...dailyMap.values()].sort((a, b) => a.stat_date.localeCompare(b.stat_date));

	let recentLaunches: any[] = [];
	if (launchesRes.ok) recentLaunches = await launchesRes.json();

	return { data: merged, recentLaunches };
}

/** Fetch the 20 most recent tokens from the indexed DB (includes logo_url). */
export async function loadRecentTokens(): Promise<any[]> {
	try {
		const res = await fetch('/api/created-tokens?limit=20');
		if (res.ok) return await res.json();
	} catch {}
	return [];
}

/**
 * Fetch all admin dashboard data via a single AdminLens eth_call per chain.
 * Returns factory state, launchpad state, recent tokens (on-chain), and
 * recent launches — all in one RPC round-trip per network.
 */
export async function loadAdminLens(
	supportedNetworks: SupportedNetwork[],
	providers: Map<number, ethers.JsonRpcProvider>,
	userAddress: string | null,
	recentTokenCount = 10,
	recentLaunchCount = 10,
): Promise<{
	chains: ChainData[];
	lensResults: Map<number, AdminLensResult>;
}> {
	const chains: ChainData[] = [];
	const lensResults = new Map<number, AdminLensResult>();

	for (const net of supportedNetworks) {
		if (!net.platform_address || net.platform_address === '0x') continue;
		const provider = providers.get(net.chain_id);
		if (!provider) continue;

		try {
			const result = await queryAdminLens(
				provider,
				net.platform_address,
				net.launchpad_address || ethers.ZeroAddress,
				recentTokenCount,
				recentLaunchCount,
			);

			lensResults.set(net.chain_id, result);

			const fs = result.factory;
			const lp = result.launchpad;
			const ud = fs.usdtDecimals || 18;

			chains.push({
				network: net,
				totalTokens: BigInt(fs.totalTokens),
				totalLaunches: BigInt(lp.totalLaunches),
				totalFeeUsdt: fs.totalFeeUsdt + lp.totalFeeUsdt,
				tokenFeeUsdt: fs.totalFeeUsdt,
				launchFeeUsdt: lp.totalFeeUsdt,
				launchFee: ethers.formatUnits(lp.launchFee, ud),
				platformWallet: lp.platformWallet || fs.platformWallet,
				owner: fs.owner,
				usdtDecimals: ud,
				isOwner: userAddress ? userAddress.toLowerCase() === fs.owner.toLowerCase() : false,
				countPerType: fs.countPerType,
				feesPerType: fs.feesPerType,
			});
		} catch (e) {
			console.warn(`AdminLens failed for ${net.name}:`, (e as any)?.message?.slice(0, 200));
		}
	}

	return { chains, lensResults };
}
