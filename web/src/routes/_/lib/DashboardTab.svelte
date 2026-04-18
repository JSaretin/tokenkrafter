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
		<div class="spinner w-10 h-10 rounded-full border-2 border-line-input border-t-brand-cyan"></div>
	</div>
{:else}
	<!-- KPI Strip — all data from on-chain getState() -->
	<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-6">
		<div class="bg-surface border border-line rounded-xl p-4 transition-colors hover:border-placeholder min-w-0">
			<div class="text-xs text-dim font-numeric font-medium uppercase tracking-[0.08em]">Total Revenue</div>
			<div class="font-numeric text-[28px] font-bold leading-[1.1] mt-1 break-words text-emerald-400">${onChainTotalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="h-[3px] rounded-sm mt-2.5 overflow-hidden bg-emerald-400/20"><div class="h-full rounded-sm transition-[width] duration-500 bg-emerald-400" style="width: 100%"></div></div>
		</div>
		<div class="bg-surface border border-line rounded-xl p-4 transition-colors hover:border-placeholder min-w-0">
			<div class="text-xs text-dim font-numeric font-medium uppercase tracking-[0.08em]">Creation Fees</div>
			<div class="font-numeric text-[28px] font-bold leading-[1.1] mt-1 break-words text-amber-400">${onChainTokenFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="h-[3px] rounded-sm mt-2.5 overflow-hidden bg-amber-400/20"><div class="h-full rounded-sm transition-[width] duration-500 bg-amber-400" style="width: {onChainTotalRevenue > 0 ? (onChainTokenFees / onChainTotalRevenue * 100) : 0}%"></div></div>
		</div>
		<div class="bg-surface border border-line rounded-xl p-4 transition-colors hover:border-placeholder min-w-0">
			<div class="text-xs text-dim font-numeric font-medium uppercase tracking-[0.08em]">Tokens Created</div>
			<div class="font-numeric text-[28px] font-bold leading-[1.1] mt-1 break-words text-cyan-400">{onChainTokens}</div>
			<div class="h-[3px] rounded-sm mt-2.5 overflow-hidden bg-cyan-400/20"><div class="h-full rounded-sm transition-[width] duration-500 bg-cyan-400" style="width: {Math.min(100, onChainTokens * 2)}%"></div></div>
		</div>
		<div class="bg-surface border border-line rounded-xl p-4 transition-colors hover:border-placeholder min-w-0">
			<div class="text-xs text-dim font-numeric font-medium uppercase tracking-[0.08em]">Launches</div>
			<div class="font-numeric text-[28px] font-bold leading-[1.1] mt-1 break-words text-blue-400">{onChainLaunches}</div>
			<div class="h-[3px] rounded-sm mt-2.5 overflow-hidden bg-blue-400/20"><div class="h-full rounded-sm transition-[width] duration-500 bg-blue-400" style="width: {Math.min(100, onChainLaunches * 5)}%"></div></div>
		</div>
		<div class="bg-surface border border-line rounded-xl p-4 transition-colors hover:border-placeholder min-w-0">
			<div class="text-xs text-dim font-numeric font-medium uppercase tracking-[0.08em]">Launch Fees</div>
			<div class="font-numeric text-[28px] font-bold leading-[1.1] mt-1 break-words text-purple-400">${onChainLaunchFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
			<div class="h-[3px] rounded-sm mt-2.5 overflow-hidden bg-purple-400/20"><div class="h-full rounded-sm transition-[width] duration-500 bg-purple-400" style="width: {onChainTotalRevenue > 0 ? (onChainLaunchFees / onChainTotalRevenue * 100) : 0}%"></div></div>
		</div>
	</div>

	<!-- Chain Overview -->
	{#if allChainData.length > 0}
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative mb-4">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Chain Overview</h3>
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
		<span class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Charts</span>
		<ChartTypeToggle />
	</div>
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
		<!-- Revenue Breakdown (bar) -->
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Revenue Breakdown</h3>
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
				<div class="absolute inset-0 flex items-center justify-center text-dim text-[11px] font-mono">No revenue yet</div>
			{/if}
		</div>

		<!-- Token Types (donut) — from on-chain countPerType[8] -->
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Token Types</h3>
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
					<div class="absolute inset-0 flex items-center justify-center text-dim text-[11px] font-mono">No tokens created yet</div>
				{/if}
			{/each}
		</div>
	</div>

	<!-- Revenue Summary + Per-chain Breakdown -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
		<!-- Revenue summary card -->
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Revenue Summary</h3>
			</div>
			<div class="p-4">
				{#each [onChainTotalRevenue || 1] as revTotal}
				<div class="grid grid-cols-[1fr_auto] gap-2 items-center py-2">
					<div class="flex items-center gap-2 text-[11px] text-muted font-mono">
						<span class="inline-block w-[7px] h-[7px] rounded-full mr-1 shrink-0 bg-emerald-400"></span>
						<span>Creation Fees</span>
					</div>
					<span class="text-xs font-mono font-semibold text-right text-emerald-400">${onChainTokenFees.toFixed(2)}</span>
					<div class="col-span-2 h-[3px] bg-surface-input rounded-sm overflow-hidden"><div class="h-full rounded-sm transition-[width] duration-500 bg-emerald-400" style="width: {(onChainTokenFees / revTotal) * 100}%"></div></div>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-2 items-center py-2">
					<div class="flex items-center gap-2 text-[11px] text-muted font-mono">
						<span class="inline-block w-[7px] h-[7px] rounded-full mr-1 shrink-0 bg-cyan-400"></span>
						<span>Launch Fees</span>
					</div>
					<span class="text-xs font-mono font-semibold text-right text-cyan-400">${onChainLaunchFees.toFixed(2)}</span>
					<div class="col-span-2 h-[3px] bg-surface-input rounded-sm overflow-hidden"><div class="h-full rounded-sm transition-[width] duration-500 bg-cyan-400" style="width: {(onChainLaunchFees / revTotal) * 100}%"></div></div>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-2 items-center py-2 mt-3 pt-3 border-t border-line">
					<div class="flex items-center gap-2 text-[11px] text-muted font-mono font-bold">
						<span>Total</span>
					</div>
					<span class="text-xs font-mono font-semibold text-right text-white font-bold">${onChainTotalRevenue.toFixed(2)}</span>
				</div>
				{/each}
			</div>
		</div>

		<!-- Recent Tokens -->
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Recent Tokens</h3>
				<span class="text-[10px] text-gray-600 font-mono">{recentTokens.length} token{recentTokens.length !== 1 ? 's' : ''}</span>
			</div>
			<div class="p-4 max-h-[280px] overflow-y-auto" style="scrollbar-width: thin;">
				{#if recentTokens.length === 0}
					<p class="text-gray-600 text-xs font-mono text-center py-6">No tokens created yet</p>
				{:else}
					{#each recentTokens.slice(0, 10) as token}
						<a href="/explore/{chainSlug(token.chain_id ?? 56)}/{token.address}" class="flex items-center gap-2.5 py-2 border-b border-line-subtle last:border-b-0 no-underline transition-colors hover:bg-surface">
							{#if token.logo_url}
								<img src={token.logo_url} alt="" class="w-7 h-7 rounded-full object-cover shrink-0 border border-line" />
							{:else}
								<div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white font-display shrink-0" style="background: {token.is_partner ? 'rgba(167,139,250,0.15)' : token.is_taxable ? 'rgba(239,68,68,0.15)' : 'rgba(0,210,255,0.15)'}">
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
		<div class="bg-surface border border-line rounded-[14px] overflow-hidden relative mt-4">
			<div class="flex justify-between items-center pt-3.5 px-4">
				<h3 class="font-numeric text-[15px] font-semibold text-heading tracking-[0.02em]">Recent Launches</h3>
				<span class="text-[10px] text-gray-600 font-mono">{recentLaunches.length} launch{recentLaunches.length !== 1 ? 'es' : ''}</span>
			</div>
			<div class="p-4 max-h-70 overflow-y-auto" style="scrollbar-width: thin;">
				{#each recentLaunches.slice(0, 10) as launch}
					{@const raised = parseFloat(ethers.formatUnits(launch.totalBaseRaised, usdtDec))}
					{@const sc = parseFloat(ethers.formatUnits(launch.softCap, usdtDec))}
					{@const hc = parseFloat(ethers.formatUnits(launch.hardCap, usdtDec))}
					{@const pct = hc > 0 ? Math.min(100, (raised / hc) * 100) : 0}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.launch}" class="flex items-center gap-2.5 py-2 border-b border-line-subtle last:border-b-0 no-underline transition-colors hover:bg-surface">
						<div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white font-display shrink-0" style="background: {launch.state === 2 ? 'rgba(16,185,129,0.15)' : launch.state === 1 ? 'rgba(0,210,255,0.15)' : 'rgba(245,158,11,0.15)'}">
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
							<div class="h-[3px] bg-surface-hover rounded-full overflow-hidden mt-1">
								<div class="h-full rounded-full transition-[width] duration-300" style="width: {pct}%; background: {launch.state === 2 ? '#10b981' : '#00d2ff'};"></div>
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
