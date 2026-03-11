<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';
	import type { SupportedNetwork } from '$lib/structure';
	import {
		LAUNCHPAD_FACTORY_ABI,
		LAUNCH_INSTANCE_ABI,
		type LaunchInfo,
		type LaunchState,
		fetchLaunchInfo,
		fetchTokenMeta,
		stateColor,
		stateLabel,
		formatUsdt,
		formatTokens,
		progressPercent,
		timeRemaining,
		CURVE_TYPES
	} from '$lib/launchpad';

	let getUserAddress: () => string | null = getContext('userAddress');
	const supportedNetworks: SupportedNetwork[] = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	let launches: (LaunchInfo & { network: SupportedNetwork })[] = $state([]);
	let loading = $state(true);
	let selectedNetwork = $state<'all' | number>('all');
	let selectedState = $state<'all' | LaunchState>('all');
	let showMyLaunches = $state(false);

	let filteredLaunches = $derived(() => {
		let result = launches;
		if (selectedNetwork !== 'all') {
			result = result.filter((l) => l.network.chain_id === selectedNetwork);
		}
		if (selectedState !== 'all') {
			result = result.filter((l) => l.state === selectedState);
		}
		if (showMyLaunches && userAddress) {
			const addr = userAddress.toLowerCase();
			result = result.filter(
				(l) => l.creator.toLowerCase() === addr
			);
		}
		return result;
	});

	async function loadLaunches() {
		loading = true;
		launches = [];

		const nets = supportedNetworks.filter(
			(n) => n.launchpad_address && n.launchpad_address !== '0x'
		);

		const allLaunches: (LaunchInfo & { network: SupportedNetwork })[] = [];

		for (const net of nets) {
			const provider = networkProviders.get(net.chain_id);
			if (!provider) continue;

			try {
				const factory = new ethers.Contract(
					net.launchpad_address,
					LAUNCHPAD_FACTORY_ABI,
					provider
				);
				const total = await factory.totalLaunches();
				const count = Number(total);

				// Load last 50 launches (paginated)
				const limit = Math.min(count, 50);
				const offset = Math.max(0, count - limit);

				for (let i = offset; i < count; i++) {
					try {
						const addr = await factory.launches(i);
						const info = await fetchLaunchInfo(addr, provider);
						const meta = await fetchTokenMeta(info.token, provider);
						allLaunches.push({
							...info,
							tokenName: meta.name,
							tokenSymbol: meta.symbol,
							tokenDecimals: meta.decimals,
							network: net
						});
					} catch (e) {
						console.warn(`Failed to load launch ${i}:`, e);
					}
				}
			} catch (e) {
				console.warn(`Failed to load launches from ${net.name}:`, e);
			}
		}

		// Sort by most recent (highest deadline = newest)
		allLaunches.sort((a, b) => Number(b.deadline - a.deadline));
		launches = allLaunches;
		loading = false;
	}

	$effect(() => {
		if (providersReady) {
			loadLaunches();
		}
	});
</script>

<svelte:head>
	<title>Launchpad | TokenKrafter</title>
	<meta
		name="description"
		content="Discover and invest in new token launches on bonding curves. Buy early, earn from price discovery, and auto-graduate to DEX liquidity."
	/>
</svelte:head>

<div class="page-wrap max-w-7xl mx-auto px-4 sm:px-6 py-12">
	<!-- Hero -->
	<div class="text-center mb-12">
		<div
			class="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-cyan-500/25 bg-cyan-500/8 mb-6"
		>
			<div class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></div>
			<span class="text-cyan-400 text-xs font-mono uppercase tracking-widest">Bonding Curve Launches</span>
		</div>
		<h1 class="syne text-3xl sm:text-4xl font-bold text-white mb-3">Token Launchpad</h1>
		<p class="text-gray-400 font-mono text-sm max-w-lg mx-auto">
			Discover new token launches on bonding curves. Buy early at low prices, and tokens
			auto-graduate to DEX with permanent liquidity.
		</p>

		<div class="flex flex-wrap gap-3 justify-center mt-8">
			<a href="/launchpad/create" class="btn-primary text-sm px-5 py-2.5 no-underline">
				Create Launch
			</a>
			<a href="/create" class="btn-secondary text-sm px-5 py-2.5 no-underline">
				Create Token + Launch
			</a>
		</div>
	</div>

	<!-- Filters -->
	<div class="filters card p-4 mb-8 flex flex-wrap gap-3 items-center">
		<select class="input-field w-auto" bind:value={selectedNetwork}>
			<option value="all">All Networks</option>
			{#each supportedNetworks.filter((n) => n.launchpad_address && n.launchpad_address !== '0x') as net}
				<option value={net.chain_id}>{net.name}</option>
			{/each}
		</select>

		<select class="input-field w-auto" bind:value={selectedState}>
			<option value="all">All States</option>
			<option value={1}>Active</option>
			<option value={0}>Pending</option>
			<option value={2}>Graduated</option>
			<option value={3}>Refunding</option>
		</select>

		{#if userAddress}
			<button
				onclick={() => (showMyLaunches = !showMyLaunches)}
				class="text-sm font-mono px-4 py-2.5 rounded-lg border transition cursor-pointer
					{showMyLaunches
					? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400'
					: 'border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/20'}"
			>
				My Launches
			</button>
		{/if}

		<div class="ml-auto text-gray-500 text-xs font-mono">
			{filteredLaunches().length} launch{filteredLaunches().length !== 1 ? 'es' : ''}
		</div>
	</div>

	<!-- Launch Grid -->
	{#if loading}
		<!-- Skeleton loading grid -->
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(6) as _}
				<div class="skeleton-card card p-5">
					<div class="flex items-start justify-between mb-3">
						<div>
							<div class="skeleton-line w-28 h-4 mb-2"></div>
							<div class="skeleton-line w-36 h-3"></div>
						</div>
						<div class="skeleton-line w-16 h-5 rounded-full"></div>
					</div>
					<div class="mb-3">
						<div class="skeleton-line w-full h-1.5 rounded-full mb-2"></div>
						<div class="flex justify-between">
							<div class="skeleton-line w-8 h-3"></div>
							<div class="skeleton-line w-24 h-3"></div>
						</div>
					</div>
					<div class="flex justify-between">
						<div class="skeleton-line w-20 h-3"></div>
						<div class="skeleton-line w-16 h-3"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else if filteredLaunches().length === 0}
		<div class="empty-state text-center py-16">
			<div class="empty-icon mx-auto mb-6">
				<svg width="64" height="64" viewBox="0 0 64 64" fill="none">
					<circle cx="32" cy="32" r="30" stroke="rgba(0,210,255,0.15)" stroke-width="2" stroke-dasharray="6 4" />
					<path d="M24 38 L32 22 L40 38" stroke="rgba(0,210,255,0.4)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
					<circle cx="32" cy="42" r="1.5" fill="rgba(0,210,255,0.4)" />
				</svg>
			</div>
			{#if showMyLaunches}
				<h3 class="syne text-lg font-bold text-white mb-2">No launches yet</h3>
				<p class="text-gray-500 font-mono text-sm mb-2 max-w-sm mx-auto">
					You haven't created any launches. Create a token with a bonding curve to get started.
				</p>
			{:else if selectedState !== 'all'}
				<h3 class="syne text-lg font-bold text-white mb-2">No matching launches</h3>
				<p class="text-gray-500 font-mono text-sm mb-2 max-w-sm mx-auto">
					No launches match your current filters. Try adjusting the network or state filter.
				</p>
			{:else}
				<h3 class="syne text-lg font-bold text-white mb-2">No launches yet</h3>
				<p class="text-gray-500 font-mono text-sm mb-2 max-w-sm mx-auto">
					Be the first to launch a token with a bonding curve. Early buyers get the best price — auto-graduates to DEX when the cap is hit.
				</p>
			{/if}
			<div class="flex gap-3 justify-center mt-6">
				<a href="/launchpad/create" class="btn-primary text-sm px-5 py-2.5 no-underline">
					Create Launch
				</a>
				<a href="/create" class="btn-secondary text-sm px-5 py-2.5 no-underline">
					Create Token
				</a>
			</div>
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each filteredLaunches() as launch}
				{@const progress = progressPercent(launch.totalBaseRaised, launch.hardCap)}
				{@const color = stateColor(launch.state)}
				<a
					href="/launchpad/{launch.address}"
					class="launch-card card card-hover p-5 block no-underline group"
				>
					<!-- Header -->
					<div class="flex items-start justify-between mb-3">
						<div>
							<div class="syne font-bold text-white group-hover:text-cyan-300 transition">
								{launch.tokenName || 'Unknown Token'}
							</div>
							<div class="text-xs text-gray-500 font-mono">
								{launch.tokenSymbol || '???'} · {launch.network.symbol} · {CURVE_TYPES[launch.curveType]}
							</div>
						</div>
						<span class="badge badge-{color}">
							{stateLabel(launch.state)}
						</span>
					</div>

					<!-- Progress Bar -->
					<div class="mb-3">
						<div class="progress-track">
							<div
								class="progress-fill progress-{color}"
								style="width: {progress}%"
							></div>
						</div>
						<div class="flex justify-between mt-1.5">
							<span class="text-xs text-gray-500 font-mono">{progress}%</span>
							<span class="text-xs text-gray-400 font-mono">
								{formatUsdt(launch.totalBaseRaised)} / {formatUsdt(launch.hardCap)}
							</span>
						</div>
					</div>

					<!-- Details -->
					<div class="flex justify-between text-xs font-mono">
						<div>
							{#if launch.state === 1}
								<span class="text-gray-500">Price:</span>
								<span class="text-white ml-1">{formatUsdt(launch.currentPrice)}</span>
							{:else if launch.state === 2}
								<span class="text-purple-400">Graduated</span>
							{:else if launch.state === 3}
								<span class="text-red-400">Refunds available</span>
							{:else}
								<span class="text-amber-400">Awaiting deposit</span>
							{/if}
						</div>
						<div>
							{#if launch.state <= 1}
								<span class="text-gray-500">{timeRemaining(launch.deadline)}</span>
							{/if}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page-wrap {
		padding-bottom: 40px;
	}

	.no-underline {
		text-decoration: none;
	}

	.launch-card {
		transition: all 0.2s;
	}
	.launch-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.progress-track {
		width: 100%;
		height: 6px;
		background: rgba(255, 255, 255, 0.06);
		border-radius: 3px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}
	.progress-cyan {
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
	}
	.progress-amber {
		background: linear-gradient(90deg, #f59e0b, #d97706);
	}
	.progress-purple {
		background: linear-gradient(90deg, #8b5cf6, #a78bfa);
	}
	.progress-red {
		background: linear-gradient(90deg, #ef4444, #f87171);
	}

	.filters select {
		min-width: 140px;
	}

	/* Skeleton loading */
	.skeleton-card {
		animation: skeletonPulse 1.5s ease-in-out infinite;
	}
	.skeleton-line {
		background: rgba(255, 255, 255, 0.06);
		border-radius: 4px;
		animation: skeletonShimmer 1.5s ease-in-out infinite;
	}
	@keyframes skeletonPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}
	@keyframes skeletonShimmer {
		0%, 100% { background: rgba(255, 255, 255, 0.06); }
		50% { background: rgba(255, 255, 255, 0.1); }
	}

	.empty-state {
		min-height: 300px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	.syne {
		font-family: 'Syne', sans-serif;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 10px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.badge-cyan {
		background: rgba(0, 210, 255, 0.1);
		color: #00d2ff;
		border: 1px solid rgba(0, 210, 255, 0.2);
	}
	.badge-amber {
		background: rgba(245, 158, 11, 0.1);
		color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.2);
	}
	.badge-purple {
		background: rgba(139, 92, 246, 0.1);
		color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.2);
	}
	.badge-red {
		background: rgba(239, 68, 68, 0.1);
		color: #f87171;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}
</style>
