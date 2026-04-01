<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { TokenFactory, FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import Chart from '$lib/Chart.svelte';
	import ChartTypeToggle from '$lib/ChartTypeToggle.svelte';

	let supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	let getUserAddress: () => string | null = getContext('userAddress');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');

	let userAddress = $derived(getUserAddress());
	let providersReady = $derived(getProvidersReady());

	// Dashboard analytics
	type DailyStats = {
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
	type DashboardData = {
		daily: DailyStats[];
		totals: DailyStats & { total_tokens: number };
		visitors: { total_visitors: number; browsing: number; creating: number; investing: number };
	};
	let dashData: DashboardData | null = $state(null);
	let dashLoading = $state(false);
	let recentLaunches: any[] = $state([]);

	// For KPI fallback values
	let totalTokens = $state(0n);
	let lpTotalLaunches = $state(0n);

	// Multi-chain contract data
	type ChainData = {
		network: SupportedNetwork;
		totalTokens: bigint;
		totalLaunches: bigint;
		totalFeeUsdt: bigint;
		launchFee: string;
		platformWallet: string;
		owner: string;
		usdtDecimals: number;
		paymentTokens: string[];
		lpPaymentTokens: string[];
		isOwner: boolean;
	};
	let allChainData: ChainData[] = $state([]);
	let chainsLoading = $state(false);

	async function loadAllChains() {
		chainsLoading = true;
		const providers = getNetworkProviders();
		const results: ChainData[] = [];

		for (const net of supportedNetworks) {
			if (!net.platform_address || net.platform_address === '0x') continue;
			const provider = providers.get(net.chain_id);
			if (!provider) continue;

			try {
				const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, provider);
				const [owner, total, supported] = await Promise.all([
					factory.owner(),
					factory.totalTokensCreated(),
					factory.getSupportedPaymentTokens()
				]);

				let lpTotal = 0n, lpFeeUsdt = 0n, lpFee = '0', lpPW = '', lpOwnerVal = '', lpSupported: string[] = [];
				let ud = 18;

				try {
					const usdtC = new ethers.Contract(await factory.usdt(), ERC20_ABI, provider);
					ud = Number(await usdtC.decimals());
				} catch {}

				if (net.launchpad_address && net.launchpad_address !== '0x') {
					try {
						const lp = new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
						const [lt, lfu, lf, pw, lo, ls] = await Promise.all([
							lp.totalLaunches(), lp.totalLaunchFeeEarnedUsdt(), lp.launchFee(),
							lp.platformWallet(), lp.owner(), lp.getSupportedPaymentTokens()
						]);
						lpTotal = lt; lpFeeUsdt = lfu; lpFee = ethers.formatUnits(lf, ud);
						lpPW = pw; lpOwnerVal = lo; lpSupported = [...ls];
					} catch {}
				}

				results.push({
					network: net,
					totalTokens: total,
					totalLaunches: lpTotal,
					totalFeeUsdt: lpFeeUsdt,
					launchFee: lpFee,
					platformWallet: lpPW,
					owner,
					usdtDecimals: ud,
					paymentTokens: [...supported],
					lpPaymentTokens: lpSupported,
					isOwner: userAddress ? userAddress.toLowerCase() === owner.toLowerCase() : false
				});
			} catch {}
		}

		allChainData = results;
		chainsLoading = false;
	}

	async function loadDashboard() {
		dashLoading = true;
		try {
			const activeChains = supportedNetworks.filter(n => n.platform_address && n.platform_address !== '0x');
			const statsFetches = activeChains.map(n => fetch(`/api/platform-stats?chain_id=${n.chain_id}&days=90`).then(r => r.ok ? r.json() : null));
			const launchesRes = await fetch(`/api/launches?limit=10`);

			const allStats = await Promise.all(statsFetches);

			const merged: DashboardData = {
				daily: [],
				totals: { tokens_created: 0, partner_tokens_created: 0, creation_fees_usdt: 0, launches_created: 0, launches_graduated: 0, total_raised_usdt: 0, launch_fees_usdt: 0, tax_revenue_usdt: 0, stat_date: '', total_tokens: 0 },
				visitors: { total_visitors: 0, browsing: 0, creating: 0, investing: 0 }
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
					merged.visitors.total_visitors = Math.max(merged.visitors.total_visitors, stats.visitors.total_visitors || 0);
					merged.visitors.browsing += stats.visitors.browsing || 0;
					merged.visitors.creating += stats.visitors.creating || 0;
					merged.visitors.investing += stats.visitors.investing || 0;
				}

				for (const day of (stats.daily || [])) {
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
							tax_revenue_usdt: parseFloat(day.tax_revenue_usdt) || 0
						});
					}
				}
			}

			merged.daily = [...dailyMap.values()].sort((a, b) => a.stat_date.localeCompare(b.stat_date));
			dashData = merged;

			if (launchesRes.ok) recentLaunches = await launchesRes.json();
		} catch {}
		dashLoading = false;
	}

	let dashTotalRevenue = $derived.by(() => {
		if (!dashData) return 0;
		const t = dashData.totals;
		return (t.creation_fees_usdt || 0) + (t.launch_fees_usdt || 0) + (t.tax_revenue_usdt || 0);
	});

	let dashTokenTypeDistribution = $derived.by(() => {
		const types = [
			{ label: 'Basic', count: 0, color: '#00d2ff' },
			{ label: 'Mintable', count: 0, color: '#f59e0b' },
			{ label: 'Taxable', count: 0, color: '#ef4444' },
			{ label: 'Partner', count: 0, color: '#a78bfa' }
		];
		if (dashData) {
			const t = dashData.totals;
			const total = t.total_tokens || 1;
			const partner = t.partner_tokens_created || 0;
			const regular = (t.tokens_created || 0) - partner;
			types[0].count = Math.max(0, Math.round(regular * 0.5));
			types[1].count = Math.max(0, Math.round(regular * 0.2));
			types[2].count = Math.max(0, Math.round(regular * 0.3));
			types[3].count = partner;
		}
		return types;
	});

	$effect(() => {
		if (providersReady) {
			loadDashboard();
			loadAllChains();
		}
	});
</script>

{#if dashLoading}
	<div class="flex items-center justify-center py-20">
		<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
	</div>
{:else}
	{@const d = dashData}
	{@const t = d?.totals}
	{@const daily = d?.daily || []}
	{@const v = d?.visitors}

	<!-- KPI Strip -->
	<div class="kpi-grid mb-6">
		<div class="kpi-card">
			<div class="kpi-label">Total Revenue</div>
			<div class="kpi-value text-emerald-400">${dashTotalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="kpi-bar bg-emerald-400/20"><div class="kpi-bar-fill bg-emerald-400" style="width: 100%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Total Raised</div>
			<div class="kpi-value text-amber-400">${(t?.total_raised_usdt ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="kpi-bar bg-amber-400/20"><div class="kpi-bar-fill bg-amber-400" style="width: {Math.min(100, (t?.total_raised_usdt ?? 0) / 100)}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Tokens Created</div>
			<div class="kpi-value text-cyan-400">{t?.total_tokens ?? Number(totalTokens)}</div>
			<div class="kpi-bar bg-cyan-400/20"><div class="kpi-bar-fill bg-cyan-400" style="width: {Math.min(100, (t?.total_tokens ?? Number(totalTokens)) * 2)}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Launches</div>
			<div class="kpi-value text-blue-400">{t?.launches_created ?? Number(lpTotalLaunches)}</div>
			<div class="kpi-bar bg-blue-400/20"><div class="kpi-bar-fill bg-blue-400" style="width: {Math.min(100, (t?.launches_created ?? 0) * 5)}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Graduated</div>
			<div class="kpi-value text-purple-400">{t?.launches_graduated ?? 0}</div>
			<div class="kpi-bar bg-purple-400/20"><div class="kpi-bar-fill bg-purple-400" style="width: {Math.min(100, (t?.launches_graduated ?? 0) * 10)}%"></div></div>
		</div>
	</div>

	<!-- Chain Overview -->
	{#if allChainData.length > 0}
		<div class="chart-card mb-4">
			<div class="chart-header">
				<h3 class="chart-title">Chain Overview</h3>
				<span class="text-[10px] text-gray-600 font-mono">{allChainData.length} active chain{allChainData.length > 1 ? 's' : ''}</span>
			</div>
			<div class="p-4">
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-white/5">
								<th class="text-left text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Chain</th>
								<th class="text-right text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Tokens</th>
								<th class="text-right text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Launches</th>
								<th class="text-right text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Fees Earned</th>
								<th class="text-right text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Launch Fee</th>
								<th class="text-center text-gray-500 text-[10px] font-mono uppercase py-2 px-2">Owner</th>
							</tr>
						</thead>
						<tbody>
							{#each allChainData as chain}
								<tr class="border-b border-white/3 hover:bg-white/[0.02] transition">
									<td class="py-2.5 px-2">
										<span class="text-white text-xs font-mono font-semibold">{chain.network.name}</span>
										<span class="text-gray-600 text-[10px] ml-1">({chain.network.symbol})</span>
									</td>
									<td class="py-2.5 px-2 text-right text-cyan-400 font-mono text-xs">{chain.totalTokens.toString()}</td>
									<td class="py-2.5 px-2 text-right text-purple-400 font-mono text-xs">{chain.totalLaunches.toString()}</td>
									<td class="py-2.5 px-2 text-right text-emerald-400 font-mono text-xs">${parseFloat(ethers.formatUnits(chain.totalFeeUsdt, chain.usdtDecimals)).toFixed(2)}</td>
									<td class="py-2.5 px-2 text-right text-gray-400 font-mono text-xs">${chain.launchFee}</td>
									<td class="py-2.5 px-2 text-center">
										{#if chain.isOwner}
											<span class="text-emerald-400 text-[10px] font-mono">You</span>
										{:else}
											<span class="text-gray-600 text-[10px] font-mono">{chain.owner.slice(0,6)}...{chain.owner.slice(-4)}</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	{/if}

	<!-- Revenue Chart -->
	<div class="flex items-center justify-between mb-3">
		<span class="chart-title" style="margin: 0;">Charts</span>
		<ChartTypeToggle />
	</div>
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Revenue (90d)</h3>
			</div>
			{#if daily.length === 0}
				<div class="chart-empty">No data yet</div>
			{:else}
				{@const dates = daily.map(dd => dd.stat_date?.slice(5) || '')}
				<Chart option={{
					tooltip: { trigger: 'axis' },
					legend: { data: ['Creation', 'Launch', 'Tax'], top: 4, right: 12 },
					xAxis: { type: 'category', data: dates, axisLabel: { interval: Math.floor(dates.length / 6) } },
					yAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
					series: [
						{ name: 'Creation', type: 'line', data: daily.map(dd => parseFloat(String(dd.creation_fees_usdt)) || 0), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#10b981' }, areaStyle: { color: 'rgba(16,185,129,0.08)' } },
						{ name: 'Launch', type: 'line', data: daily.map(dd => parseFloat(String(dd.launch_fees_usdt)) || 0), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#00d2ff' }, areaStyle: { color: 'rgba(0,210,255,0.06)' } },
						{ name: 'Tax', type: 'line', data: daily.map(dd => parseFloat(String(dd.tax_revenue_usdt)) || 0), smooth: true, lineStyle: { width: 1.5, type: 'dashed' }, itemStyle: { color: '#a78bfa' }, areaStyle: { color: 'rgba(167,139,250,0.06)' } }
					]
				}} />
			{/if}
		</div>

		<!-- Token Creation Bar Chart -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Token Creation (90d)</h3>
			</div>
			{#if daily.length === 0}
				<div class="chart-empty">No data yet</div>
			{:else}
				{@const dates = daily.map(dd => dd.stat_date?.slice(5) || '')}
				<Chart option={{
					tooltip: { trigger: 'axis' },
					legend: { data: ['Regular', 'Partner'], top: 4, right: 12 },
					xAxis: { type: 'category', data: dates, axisLabel: { interval: Math.floor(dates.length / 6) } },
					yAxis: { type: 'value' },
					series: [
						{ name: 'Regular', type: 'bar', stack: 'tokens', data: daily.map(dd => (dd.tokens_created || 0) - (dd.partner_tokens_created || 0)), itemStyle: { color: '#00d2ff', borderRadius: [0, 0, 0, 0] }, barMaxWidth: 12 },
						{ name: 'Partner', type: 'bar', stack: 'tokens', data: daily.map(dd => dd.partner_tokens_created || 0), itemStyle: { color: '#a78bfa', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 12 }
					]
				}} />
			{/if}
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
		<!-- Launch Activity -->
		<div class="chart-card lg:col-span-2">
			<div class="chart-header">
				<h3 class="chart-title">Launch Activity (90d)</h3>
			</div>
			{#if daily.length === 0}
				<div class="chart-empty">No data yet</div>
			{:else}
				{@const dates = daily.map(dd => dd.stat_date?.slice(5) || '')}
				<Chart option={{
					tooltip: { trigger: 'axis' },
					legend: { data: ['Created', 'Graduated'], top: 4, right: 12 },
					xAxis: { type: 'category', data: dates, axisLabel: { interval: Math.floor(dates.length / 6) } },
					yAxis: { type: 'value' },
					series: [
						{ name: 'Created', type: 'bar', data: daily.map(dd => dd.launches_created || 0), itemStyle: { color: '#00d2ff', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 10 },
						{ name: 'Graduated', type: 'bar', data: daily.map(dd => dd.launches_graduated || 0), itemStyle: { color: '#10b981', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 10 }
					]
				}} />
			{/if}
		</div>

		<!-- Token Type Pie -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Token Types</h3>
			</div>
			{#each [dashTokenTypeDistribution.filter(tp => tp.count > 0)] as pieData}
			<Chart height="240px" option={{
				tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
				series: [{
					type: 'pie',
					radius: ['40%', '70%'],
					center: ['50%', '55%'],
					label: { show: true, color: '#94a3b8', fontSize: 10, formatter: '{b}\n{c}' },
					labelLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
					data: pieData.map(tp => ({ name: tp.label, value: tp.count, itemStyle: { color: tp.color } })),
					emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } }
				}]
			}} />
			{/each}
		</div>
	</div>

	<!-- Revenue Breakdown + Recent Activity -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Revenue Breakdown -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Revenue Breakdown</h3>
			</div>
			<div class="p-4">
				{#each [{ creation: t?.creation_fees_usdt ?? 0, launch: t?.launch_fees_usdt ?? 0, tax: t?.tax_revenue_usdt ?? 0 }] as rev}
				{@const creation = rev.creation}
				{@const launch = rev.launch}
				{@const tax = rev.tax}
				{@const revTotal = creation + launch + tax || 1}
				<div class="rev-row">
					<div class="rev-label">
						<span class="legend-dot bg-emerald-400"></span>
						<span>Creation Fees</span>
					</div>
					<span class="rev-amount text-emerald-400">${creation.toFixed(2)}</span>
					<div class="rev-bar"><div class="rev-bar-fill bg-emerald-400" style="width: {(creation / revTotal) * 100}%"></div></div>
				</div>
				<div class="rev-row">
					<div class="rev-label">
						<span class="legend-dot bg-cyan-400"></span>
						<span>Launch Fees</span>
					</div>
					<span class="rev-amount text-cyan-400">${launch.toFixed(2)}</span>
					<div class="rev-bar"><div class="rev-bar-fill bg-cyan-400" style="width: {(launch / revTotal) * 100}%"></div></div>
				</div>
				<div class="rev-row">
					<div class="rev-label">
						<span class="legend-dot bg-purple-400"></span>
						<span>Tax Revenue</span>
					</div>
					<span class="rev-amount text-purple-400">${tax.toFixed(2)}</span>
					<div class="rev-bar"><div class="rev-bar-fill bg-purple-400" style="width: {(tax / revTotal) * 100}%"></div></div>
				</div>
				<div class="rev-row mt-3 pt-3" style="border-top: 1px solid rgba(255,255,255,0.06);">
					<div class="rev-label font-bold">
						<span>Total</span>
					</div>
					<span class="rev-amount text-white font-bold">${dashTotalRevenue.toFixed(2)}</span>
				</div>
				{/each}
			</div>
		</div>

		<!-- Recent Activity -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Recent Launches</h3>
			</div>
			<div class="p-4 max-h-[280px] overflow-y-auto" style="scrollbar-width: thin;">
				{#if recentLaunches.length === 0}
					<p class="text-gray-600 text-xs font-mono text-center py-6">No launches yet</p>
				{:else}
					{#each recentLaunches.slice(0, 8) as launch}
						<a href="/launchpad/{launch.address}" class="activity-row">
							<div class="activity-icon" style="background: {launch.state === 2 ? 'rgba(16,185,129,0.15)' : launch.state === 1 ? 'rgba(0,210,255,0.15)' : 'rgba(245,158,11,0.15)'}">
								{(launch.token_symbol || '?').charAt(0)}
							</div>
							<div class="flex-1 min-w-0">
								<div class="text-white text-xs font-mono truncate">{launch.token_name || 'Unknown'} <span class="text-gray-600">{launch.token_symbol}</span></div>
								<div class="text-gray-600 text-[10px] font-mono">
									{launch.state === 2 ? 'Graduated' : launch.state === 1 ? 'Active' : 'Pending'}
									{#if launch.is_partner}<span class="text-purple-400 ml-1">Partner</span>{/if}
								</div>
							</div>
							<div class="text-right">
								<div class="text-xs font-mono text-white">${(parseInt(launch.total_base_raised || '0') / 1e6).toFixed(0)}</div>
								<div class="text-[10px] text-gray-600 font-mono">raised</div>
							</div>
						</a>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.kpi-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	@media (min-width: 768px) {
		.kpi-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	@media (min-width: 1280px) {
		.kpi-grid {
			grid-template-columns: repeat(5, 1fr);
		}
	}
	.kpi-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 16px;
		transition: border-color 0.2s;
		min-width: 0;
	}
	.kpi-card:hover { border-color: rgba(255,255,255,0.12); }
	.kpi-value {
		font-family: 'Rajdhani', sans-serif;
		font-size: 28px;
		font-weight: 700;
		line-height: 1.1;
		margin-top: 4px;
		word-break: break-word;
	}
	.kpi-label {
		font-size: 12px;
		color: #64748b;
		font-family: 'Rajdhani', sans-serif;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.kpi-bar {
		height: 3px;
		border-radius: 2px;
		margin-top: 10px;
		overflow: hidden;
	}
	.kpi-bar-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.6s ease;
	}
	.kpi-sub {
		font-size: 9px;
		color: #64748b;
		font-family: 'Space Mono', monospace;
		margin-top: 8px;
		line-height: 1.6;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chart-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 14px;
		overflow: hidden;
	}
	.chart-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 14px 16px 0;
	}
	.chart-title {
		font-family: 'Rajdhani', sans-serif;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-heading);
		letter-spacing: 0.02em;
	}
	.chart-empty {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #374151;
		font-size: 11px;
		font-family: 'Space Mono', monospace;
	}
	.legend-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		margin-right: 4px;
		flex-shrink: 0;
	}

	.rev-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px;
		align-items: center;
		padding: 8px 0;
	}
	.rev-label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: #94a3b8;
		font-family: 'Space Mono', monospace;
	}
	.rev-amount {
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		font-weight: 600;
		text-align: right;
	}
	.rev-bar {
		grid-column: 1 / -1;
		height: 3px;
		background: rgba(255,255,255,0.04);
		border-radius: 2px;
		overflow: hidden;
	}
	.rev-bar-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.5s ease;
	}

	.activity-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border-subtle);
		text-decoration: none;
		transition: background 0.15s;
	}
	.activity-row:last-child { border-bottom: none; }
	.activity-row:hover { background: rgba(255,255,255,0.02); }
	.activity-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 700;
		color: white;
		font-family: 'Syne', sans-serif;
		flex-shrink: 0;
	}

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
