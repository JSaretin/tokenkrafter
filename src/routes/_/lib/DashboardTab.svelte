<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { chainSlug } from '$lib/structure';
	import { supabase } from '$lib/supabaseClient';
	import { ethers } from 'ethers';
	import { TokenFactory, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks } from '$lib/structure';
	import Chart from '$lib/Chart.svelte';
	import ChartTypeToggle from '$lib/ChartTypeToggle.svelte';
	import {
		loadAdminLens,
		loadRecentTokens as fetchRecentTokens,
		type ChainData,
		type AdminLensResult,
		type LaunchInfo,
	} from './dashboardData';

	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getUserAddress: () => string | null = getContext('userAddress');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');

	let userAddress = $derived(getUserAddress());
	let providersReady = $derived(getProvidersReady());

	let recentTokens: any[] = $state([]);
	let allChainData: ChainData[] = $state([]);
	let lensResults = $state<Map<number, AdminLensResult>>(new Map());
	let chainsLoading = $state(false);

	// ── All data is on-chain via AdminLens (single eth_call per chain) ──

	let onChainTokens = $derived(allChainData.reduce((s, c) => s + Number(c.totalTokens), 0));
	let onChainLaunches = $derived(allChainData.reduce((s, c) => s + Number(c.totalLaunches), 0));

	// Merge recent launches from all chains (on-chain via AdminLens)
	let recentLaunches = $derived.by<(LaunchInfo & { chain_id: number })[]>(() => {
		const all: (LaunchInfo & { chain_id: number })[] = [];
		for (const [chainId, result] of lensResults) {
			for (const l of result.recentLaunches) {
				all.push({ ...l, chain_id: chainId });
			}
		}
		return all.sort((a, b) => b.startTimestamp - a.startTimestamp);
	});

	async function loadAllChains() {
		chainsLoading = true;
		let needsFallback = false;
		try {
			const { chains, lensResults: lr } = await loadAdminLens(
				supportedNetworks, getNetworkProviders(), userAddress, 10, 10
			);
			if (chains.length > 0) {
				allChainData = chains;
				lensResults = lr;
			} else {
				// AdminLens returned successfully but with no data — per-chain errors were swallowed
				needsFallback = true;
			}
		} catch (e) {
			console.warn('AdminLens load failed, falling back to individual calls:', e);
			needsFallback = true;
		}
		if (needsFallback) {
			try {
				const { loadAllChains: fallback } = await import('./dashboardData');
				allChainData = await fallback(supportedNetworks, getNetworkProviders(), userAddress);
			} catch (e2) {
				console.warn('Fallback loadAllChains also failed:', e2);
			}
		}
		chainsLoading = false;
	}

	// On-chain fee totals (source of truth)
	let onChainTokenFees = $derived(allChainData.reduce((s, c) => s + parseFloat(ethers.formatUnits(c.tokenFeeUsdt, c.usdtDecimals)), 0));
	let onChainLaunchFees = $derived(allChainData.reduce((s, c) => s + parseFloat(ethers.formatUnits(c.launchFeeUsdt, c.usdtDecimals)), 0));
	let onChainTotalRevenue = $derived(onChainTokenFees + onChainLaunchFees);

	// Token type distribution — from on-chain countPerType[8]
	// Type keys: 0=basic, 1=mintable, 2=taxable, 3=tax+mint, 4=partner, 5=partner+mint, 6=partner+tax, 7=partner+tax+mint
	let dashTokenTypeDistribution = $derived.by(() => {
		const types = [
			{ label: 'Basic', count: 0, color: '#00d2ff' },
			{ label: 'Mintable', count: 0, color: '#f59e0b' },
			{ label: 'Taxable', count: 0, color: '#ef4444' },
			{ label: 'Partner', count: 0, color: '#a78bfa' }
		];
		for (const c of allChainData) {
			const cpt = c.countPerType || [];
			types[0].count += (cpt[0] || 0);                         // basic
			types[1].count += (cpt[1] || 0);                         // mintable
			types[2].count += (cpt[2] || 0) + (cpt[3] || 0);        // taxable + tax+mint
			types[3].count += (cpt[4] || 0) + (cpt[5] || 0) + (cpt[6] || 0) + (cpt[7] || 0); // all partner variants
		}
		return types;
	});

	async function loadRecentTokens() {
		try {
			recentTokens = await fetchRecentTokens();
		} catch {}
	}

	let channels: any[] = [];

	let hasLoaded = false;
	$effect(() => {
		if (providersReady && !hasLoaded) {
			hasLoaded = true;
			loadAllChains();
			loadRecentTokens();

			const launchesChannel = supabase
				.channel('admin-dashboard-launches')
				.on('postgres_changes', { event: '*', schema: 'public', table: 'launches' }, () => {
					loadAllChains();
				})
				.subscribe();
			channels.push(launchesChannel);

			const tokensChannel = supabase
				.channel('admin-dashboard-tokens')
				.on('postgres_changes', { event: '*', schema: 'public', table: 'created_tokens' }, () => {
					loadAllChains();
					loadRecentTokens();
				})
				.subscribe();
			channels.push(tokensChannel);
		}
	});

	onDestroy(() => {
		channels.forEach(c => supabase.removeChannel(c));
	});
</script>

{#if chainsLoading}
	<div class="flex items-center justify-center py-20">
		<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
	</div>
{:else}
	<!-- KPI Strip — all data from on-chain getState() -->
	<div class="kpi-grid mb-6">
		<div class="kpi-card">
			<div class="kpi-label">Total Revenue</div>
			<div class="kpi-value text-emerald-400">${onChainTotalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="kpi-bar bg-emerald-400/20"><div class="kpi-bar-fill bg-emerald-400" style="width: 100%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Creation Fees</div>
			<div class="kpi-value text-amber-400">${onChainTokenFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="kpi-bar bg-amber-400/20"><div class="kpi-bar-fill bg-amber-400" style="width: {onChainTotalRevenue > 0 ? (onChainTokenFees / onChainTotalRevenue * 100) : 0}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Tokens Created</div>
			<div class="kpi-value text-cyan-400">{onChainTokens}</div>
			<div class="kpi-bar bg-cyan-400/20"><div class="kpi-bar-fill bg-cyan-400" style="width: {Math.min(100, onChainTokens * 2)}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Launches</div>
			<div class="kpi-value text-blue-400">{onChainLaunches}</div>
			<div class="kpi-bar bg-blue-400/20"><div class="kpi-bar-fill bg-blue-400" style="width: {Math.min(100, onChainLaunches * 5)}%"></div></div>
		</div>
		<div class="kpi-card">
			<div class="kpi-label">Launch Fees</div>
			<div class="kpi-value text-purple-400">${onChainLaunchFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="kpi-bar bg-purple-400/20"><div class="kpi-bar-fill bg-purple-400" style="width: {onChainTotalRevenue > 0 ? (onChainLaunchFees / onChainTotalRevenue * 100) : 0}%"></div></div>
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

	<!-- Charts — all data from on-chain getState() -->
	<div class="flex items-center justify-between mb-3">
		<span class="chart-title" style="margin: 0;">Charts</span>
		<ChartTypeToggle />
	</div>
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
		<!-- Revenue Breakdown (bar) -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Revenue Breakdown</h3>
			</div>
			{#if onChainTotalRevenue > 0}
				<Chart option={{
					tooltip: { trigger: 'axis', formatter: (p: any) => p.map((s: any) => `${s.marker} ${s.seriesName}: $${s.value.toFixed(2)}`).join('<br/>') },
					xAxis: { type: 'category', data: allChainData.map(c => c.network.symbol), axisLabel: { color: '#64748b' } },
					yAxis: { type: 'value', axisLabel: { formatter: '${value}', color: '#64748b' } },
					series: [
						{ name: 'Creation', type: 'bar', stack: 'rev', data: allChainData.map(c => parseFloat(ethers.formatUnits(c.tokenFeeUsdt, c.usdtDecimals))), itemStyle: { color: '#10b981', borderRadius: [0, 0, 0, 0] }, barMaxWidth: 40 },
						{ name: 'Launch', type: 'bar', stack: 'rev', data: allChainData.map(c => parseFloat(ethers.formatUnits(c.launchFeeUsdt, c.usdtDecimals))), itemStyle: { color: '#00d2ff', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 40 }
					],
					legend: { data: ['Creation', 'Launch'], top: 4, right: 12, textStyle: { color: '#64748b', fontSize: 10 } }
				}} />
			{:else}
				<div class="chart-empty">No revenue yet</div>
			{/if}
		</div>

		<!-- Token Types (donut) — from on-chain countPerType[8] -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Token Types</h3>
			</div>
			{#each [dashTokenTypeDistribution.filter(tp => tp.count > 0)] as pieData}
				{#if pieData.length > 0}
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
				{:else}
					<div class="chart-empty">No tokens created yet</div>
				{/if}
			{/each}
		</div>
	</div>

	<!-- Revenue Summary + Per-chain Breakdown -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
		<!-- Revenue summary card -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Revenue Summary</h3>
			</div>
			<div class="p-4">
				{#each [onChainTotalRevenue || 1] as revTotal}
				<div class="rev-row">
					<div class="rev-label">
						<span class="legend-dot bg-emerald-400"></span>
						<span>Creation Fees</span>
					</div>
					<span class="rev-amount text-emerald-400">${onChainTokenFees.toFixed(2)}</span>
					<div class="rev-bar"><div class="rev-bar-fill bg-emerald-400" style="width: {(onChainTokenFees / revTotal) * 100}%"></div></div>
				</div>
				<div class="rev-row">
					<div class="rev-label">
						<span class="legend-dot bg-cyan-400"></span>
						<span>Launch Fees</span>
					</div>
					<span class="rev-amount text-cyan-400">${onChainLaunchFees.toFixed(2)}</span>
					<div class="rev-bar"><div class="rev-bar-fill bg-cyan-400" style="width: {(onChainLaunchFees / revTotal) * 100}%"></div></div>
				</div>
				<div class="rev-row mt-3 pt-3" style="border-top: 1px solid var(--border);">
					<div class="rev-label font-bold">
						<span>Total</span>
					</div>
					<span class="rev-amount text-white font-bold">${onChainTotalRevenue.toFixed(2)}</span>
				</div>
				{/each}
			</div>
		</div>

		<!-- Recent Tokens -->
		<div class="chart-card">
			<div class="chart-header">
				<h3 class="chart-title">Recent Tokens</h3>
				<span class="text-[10px] text-gray-600 font-mono">{recentTokens.length} token{recentTokens.length !== 1 ? 's' : ''}</span>
			</div>
			<div class="p-4 max-h-[280px] overflow-y-auto" style="scrollbar-width: thin;">
				{#if recentTokens.length === 0}
					<p class="text-gray-600 text-xs font-mono text-center py-6">No tokens created yet</p>
				{:else}
					{#each recentTokens.slice(0, 10) as token}
						<a href="/manage-tokens/{chainSlug(token.chain_id ?? 56)}/{token.address}" class="activity-row">
							{#if token.logo_url}
								<img src={token.logo_url} alt="" class="activity-logo" />
							{:else}
								<div class="activity-icon" style="background: {token.is_partner ? 'rgba(167,139,250,0.15)' : token.is_taxable ? 'rgba(239,68,68,0.15)' : 'rgba(0,210,255,0.15)'}">
									{(token.symbol || '?').charAt(0)}
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<div class="text-white text-xs font-mono truncate">{token.name} <span class="text-gray-600">{token.symbol}</span></div>
								<div class="text-gray-600 text-[10px] font-mono">
									{token.is_partner ? 'Partner' : token.is_taxable ? 'Taxable' : token.is_mintable ? 'Mintable' : 'Basic'}
									<span class="text-gray-700 ml-1">{token.creator?.slice(0, 6)}...{token.creator?.slice(-4)}</span>
								</div>
							</div>
							<div class="text-right">
								<div class="text-[10px] text-gray-600 font-mono">{new Date(token.created_at).toLocaleDateString()}</div>
							</div>
						</a>
					{/each}
				{/if}
			</div>
		</div>
	</div>

	<!-- Recent Launches (on-chain via AdminLens) -->
	{#if recentLaunches.length > 0}
		{@const usdtDec = allChainData[0]?.usdtDecimals || 18}
		<div class="chart-card mt-4">
			<div class="chart-header">
				<h3 class="chart-title">Recent Launches</h3>
				<span class="text-[10px] text-gray-600 font-mono">{recentLaunches.length} launch{recentLaunches.length !== 1 ? 'es' : ''}</span>
			</div>
			<div class="p-4 max-h-70 overflow-y-auto" style="scrollbar-width: thin;">
				{#each recentLaunches.slice(0, 10) as launch}
					{@const raised = parseFloat(ethers.formatUnits(launch.totalBaseRaised, usdtDec))}
					{@const sc = parseFloat(ethers.formatUnits(launch.softCap, usdtDec))}
					{@const hc = parseFloat(ethers.formatUnits(launch.hardCap, usdtDec))}
					{@const pct = hc > 0 ? Math.min(100, (raised / hc) * 100) : 0}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.launch}" class="activity-row">
						<div class="activity-icon" style="background: {launch.state === 2 ? 'rgba(16,185,129,0.15)' : launch.state === 1 ? 'rgba(0,210,255,0.15)' : 'rgba(245,158,11,0.15)'}">
							{(launch.tokenSymbol || '?').charAt(0)}
						</div>
						<div class="flex-1 min-w-0">
							<div class="text-white text-xs font-mono truncate">{launch.tokenName || 'Unknown'} <span class="text-gray-600">{launch.tokenSymbol}</span></div>
							<div class="text-gray-600 text-[10px] font-mono">
								{launch.state === 2 ? 'Graduated' : launch.state === 1 ? 'Active' : 'Pending'}
								· SC ${sc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
								· HC ${hc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
								· {launch.totalBuyers} buyer{launch.totalBuyers !== 1 ? 's' : ''}
							</div>
							<div class="launch-progress-bar">
								<div class="launch-progress-fill" style="width: {pct}%; background: {launch.state === 2 ? '#10b981' : '#00d2ff'};"></div>
							</div>
						</div>
						<div class="text-right">
							<div class="text-xs font-mono text-emerald-400">${raised.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
							<div class="text-[10px] text-gray-600 font-mono">/ ${hc.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}
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
	.kpi-card:hover { border-color: var(--placeholder); }
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
		color: var(--text-dim);
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

	.chart-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 14px;
		overflow: hidden;
		position: relative;
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
		color: var(--text-dim);
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
		color: var(--text-muted);
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
		background: var(--bg-surface-input);
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
	.activity-row:hover { background: var(--bg-surface); }
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
	.activity-logo {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid var(--border);
	}
	.launch-progress-bar {
		height: 3px;
		background: var(--bg-surface-hover);
		border-radius: 999px;
		overflow: hidden;
		margin-top: 4px;
	}
	.launch-progress-fill {
		height: 100%;
		border-radius: 999px;
		transition: width 0.3s;
	}

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
