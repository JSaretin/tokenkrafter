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
	let activeTab = $state<'live' | 'upcoming' | 'graduated' | 'all'>('live');
	let sortBy = $state<'newest' | 'ending' | 'raised' | 'progress'>('newest');
	let showMyLaunches = $state(false);

	// Countdown ticker
	let tickNow = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		if (!tickInterval) {
			tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
		}
		return () => { if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } };
	});

	function countdownStr(deadline: bigint): string {
		const ms = Number(deadline) * 1000 - tickNow;
		if (ms <= 0) return 'Ended';
		const d = Math.floor(ms / 86400000);
		const h = Math.floor((ms % 86400000) / 3600000);
		const m = Math.floor((ms % 3600000) / 60000);
		const s = Math.floor((ms % 60000) / 1000);
		if (d > 0) return `${String(d).padStart(2, '0')}:${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	let filteredLaunches = $derived.by(() => {
		let result = launches;

		// Tab filter
		if (activeTab === 'live') result = result.filter(l => l.state === 1);
		else if (activeTab === 'upcoming') result = result.filter(l => l.state === 0);
		else if (activeTab === 'graduated') result = result.filter(l => l.state === 2 || l.state === 3);

		if (selectedNetwork !== 'all') {
			result = result.filter(l => l.network.chain_id === selectedNetwork);
		}
		if (showMyLaunches && userAddress) {
			const addr = userAddress.toLowerCase();
			result = result.filter(l => l.creator.toLowerCase() === addr);
		}

		// Sort
		result = [...result];
		if (sortBy === 'newest') {
			result.sort((a, b) => Number(b.deadline - a.deadline));
		} else if (sortBy === 'ending') {
			const now = BigInt(Math.floor(Date.now() / 1000));
			result.sort((a, b) => {
				const aLeft = a.deadline > now ? Number(a.deadline - now) : Infinity;
				const bLeft = b.deadline > now ? Number(b.deadline - now) : Infinity;
				return aLeft - bLeft;
			});
		} else if (sortBy === 'raised') {
			result.sort((a, b) => Number(b.totalBaseRaised - a.totalBaseRaised));
		} else if (sortBy === 'progress') {
			result.sort((a, b) => {
				const pA = a.hardCap > 0n ? Number((a.totalBaseRaised * 10000n) / a.hardCap) : 0;
				const pB = b.hardCap > 0n ? Number((b.totalBaseRaised * 10000n) / b.hardCap) : 0;
				return pB - pA;
			});
		}

		return result;
	});

	// Stats
	let liveCount = $derived(launches.filter(l => l.state === 1).length);
	let totalRaised = $derived(launches.reduce((sum, l) => sum + l.totalBaseRaised, 0n));

	// Database row mapper
	function dbRowToLaunch(row: any): (LaunchInfo & { network: SupportedNetwork }) | null {
		const net = supportedNetworks.find((n) => n.chain_id === row.chain_id);
		if (!net) return null;
		return {
			address: row.address,
			token: row.token_address,
			creator: row.creator,
			curveType: row.curve_type,
			state: row.state,
			softCap: BigInt(row.soft_cap || '0'),
			hardCap: BigInt(row.hard_cap || '0'),
			deadline: BigInt(row.deadline || 0),
			totalBaseRaised: BigInt(row.total_base_raised || '0'),
			tokensSold: BigInt(row.tokens_sold || '0'),
			tokensForCurve: BigInt(row.tokens_for_curve || '0'),
			tokensForLP: BigInt(row.tokens_for_lp || '0'),
			creatorAllocationBps: BigInt(row.creator_allocation_bps || 0),
			currentPrice: BigInt(row.current_price || '0'),
			usdtAddress: '',
			totalTokensRequired: BigInt(row.total_tokens_required || '0'),
			totalTokensDeposited: BigInt(row.total_tokens_deposited || '0'),
			tokenName: row.token_name,
			tokenSymbol: row.token_symbol,
			tokenDecimals: row.token_decimals ?? 18,
			usdtDecimals: row.usdt_decimals ?? 18,
			description: row.description,
			logoUrl: row.logo_url,
			website: row.website,
			twitter: row.twitter,
			telegram: row.telegram,
			discord: row.discord,
			badges: [] as string[],
			network: net
		} as any;
	}

	async function loadFromApi(): Promise<boolean> {
		try {
			const res = await fetch('/api/launches?limit=50');
			if (!res.ok) return false;
			const rows = await res.json();
			if (!rows || rows.length === 0) return false;
			const mapped = rows.map(dbRowToLaunch).filter(Boolean) as (LaunchInfo & { network: SupportedNetwork })[];
			mapped.sort((a, b) => Number(b.deadline - a.deadline));
			launches = mapped;
			return true;
		} catch { return false; }
	}

	async function loadFromChain() {
		const nets = supportedNetworks.filter(n => n.launchpad_address && n.launchpad_address !== '0x');
		const allLaunches: (LaunchInfo & { network: SupportedNetwork })[] = [];
		for (const net of nets) {
			const provider = networkProviders.get(net.chain_id);
			if (!provider) continue;
			try {
				const factory = new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
				const total = await factory.totalLaunches();
				const count = Number(total);
				const limit = Math.min(count, 50);
				const offset = Math.max(0, count - limit);
				for (let i = offset; i < count; i++) {
					try {
						const addr = await factory.launches(i);
						const info = await fetchLaunchInfo(addr, provider);
						const meta = await fetchTokenMeta(info.token, provider);
						allLaunches.push({ ...info, tokenName: meta.name, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals, network: net });
					} catch (e) { console.warn(`Failed to load launch ${i}:`, e); }
				}
			} catch (e) { console.warn(`Failed to load launches from ${net.name}:`, e); }
		}
		allLaunches.sort((a, b) => Number(b.deadline - a.deadline));
		launches = allLaunches;
	}

	async function loadBadges() {
		try {
			const res = await fetch('/api/badges');
			if (!res.ok) return;
			const rows: { launch_address: string; chain_id: number; badge_type: string }[] = await res.json();
			const badgeMap = new Map<string, string[]>();
			for (const r of rows) {
				const key = `${r.launch_address.toLowerCase()}-${r.chain_id}`;
				if (!badgeMap.has(key)) badgeMap.set(key, []);
				badgeMap.get(key)!.push(r.badge_type);
			}
			for (const l of launches) {
				const key = `${l.address.toLowerCase()}-${(l as any).network.chain_id}`;
				(l as any).badges = badgeMap.get(key) ?? [];
			}
			launches = [...launches];
		} catch {}
	}

	async function loadLaunches() {
		loading = true;
		launches = [];
		const fromApi = await loadFromApi();
		if (!fromApi) await loadFromChain();
		await loadBadges();
		loading = false;
	}

	$effect(() => {
		if (providersReady) loadLaunches();
	});

	const BADGE_META: Record<string, { label: string; cls: string }> = {
		audit: { label: 'AUDIT', cls: 'badge-list-cyan' },
		kyc: { label: 'KYC', cls: 'badge-list-emerald' },
		partner: { label: 'Partner', cls: 'badge-list-purple' },
		doxxed: { label: 'Doxxed', cls: 'badge-list-amber' },
		safu: { label: 'SAFU', cls: 'badge-list-blue' }
	};
</script>

<svelte:head>
	<title>Launchpad | TokenKrafter</title>
	<meta name="description" content="Discover and invest in new token launches on bonding curves. Buy early, earn from price discovery, and auto-graduate to DEX liquidity." />
</svelte:head>

<div class="page-wrap max-w-7xl mx-auto px-4 sm:px-6 py-8">
	<!-- Header row -->
	<div class="flex flex-wrap items-end justify-between gap-4 mb-6">
		<div>
			<h1 class="syne text-2xl sm:text-3xl font-bold text-white">Launchpad</h1>
			<p class="text-gray-500 font-mono text-xs mt-1">Bonding curve token launches</p>
		</div>
		<div class="flex gap-2">
			<a href="/launchpad/create" class="btn-primary text-xs px-4 py-2 no-underline">Create Launch</a>
			<a href="/create" class="btn-secondary text-xs px-4 py-2 no-underline">Create Token</a>
		</div>
	</div>

	<!-- Stats bar -->
	<div class="stats-bar mb-6">
		<div class="stat-item">
			<span class="stat-value">{liveCount}</span>
			<span class="stat-label">Live</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{launches.length}</span>
			<span class="stat-label">Total</span>
		</div>
		<div class="stat-item">
			<span class="stat-value">{formatUsdt(totalRaised)}</span>
			<span class="stat-label">Total Raised</span>
		</div>
	</div>

	<!-- Tabs + filters row -->
	<div class="flex flex-wrap items-center gap-3 mb-6">
		<!-- State tabs -->
		<div class="tab-row">
			<button class="tab-btn {activeTab === 'live' ? 'tab-active' : ''}" onclick={() => activeTab = 'live'}>Live</button>
			<button class="tab-btn {activeTab === 'upcoming' ? 'tab-active' : ''}" onclick={() => activeTab = 'upcoming'}>Upcoming</button>
			<button class="tab-btn {activeTab === 'graduated' ? 'tab-active' : ''}" onclick={() => activeTab = 'graduated'}>Graduated</button>
			<button class="tab-btn {activeTab === 'all' ? 'tab-active' : ''}" onclick={() => activeTab = 'all'}>All</button>
		</div>

		<div class="flex-1"></div>

		<!-- Sort -->
		<select class="filter-select" bind:value={sortBy}>
			<option value="newest">Newest</option>
			<option value="ending">Ending Soon</option>
			<option value="raised">Most Raised</option>
			<option value="progress">Most Progress</option>
		</select>

		<!-- Network -->
		<select class="filter-select" bind:value={selectedNetwork}>
			<option value="all">All Chains</option>
			{#each supportedNetworks.filter(n => n.launchpad_address && n.launchpad_address !== '0x') as net}
				<option value={net.chain_id}>{net.name}</option>
			{/each}
		</select>

		{#if userAddress}
			<button
				onclick={() => showMyLaunches = !showMyLaunches}
				class="filter-btn {showMyLaunches ? 'filter-btn-active' : ''}"
			>My Launches</button>
		{/if}
	</div>

	<!-- Results count -->
	<div class="text-gray-600 text-xs font-mono mb-4">
		{filteredLaunches.length} launch{filteredLaunches.length !== 1 ? 'es' : ''}
	</div>

	<!-- Grid -->
	{#if loading}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(6) as _}
				<div class="skeleton-card card p-5">
					<div class="flex items-start gap-3 mb-3">
						<div class="skeleton-line w-10 h-10 rounded-full"></div>
						<div class="flex-1">
							<div class="skeleton-line w-28 h-4 mb-2"></div>
							<div class="skeleton-line w-36 h-3"></div>
						</div>
					</div>
					<div class="skeleton-line w-full h-2.5 rounded-full mb-3"></div>
					<div class="skeleton-line w-full h-10 mb-3"></div>
					<div class="flex justify-between">
						<div class="skeleton-line w-20 h-3"></div>
						<div class="skeleton-line w-16 h-3"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else if filteredLaunches.length === 0}
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
				<p class="text-gray-500 font-mono text-sm max-w-sm mx-auto">You haven't created any launches.</p>
			{:else}
				<h3 class="syne text-lg font-bold text-white mb-2">No matching launches</h3>
				<p class="text-gray-500 font-mono text-sm max-w-sm mx-auto">Try adjusting your filters or be the first to launch.</p>
			{/if}
			<div class="flex gap-3 justify-center mt-6">
				<a href="/launchpad/create" class="btn-primary text-sm px-5 py-2.5 no-underline">Create Launch</a>
			</div>
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each filteredLaunches as launch}
				{@const progress = progressPercent(launch.totalBaseRaised, launch.hardCap)}
				{@const color = stateColor(launch.state)}
				{@const ud = (launch as any).usdtDecimals ?? 18}
				<a href="/launchpad/{launch.address}" class="launch-card card p-0 block no-underline group">
					<!-- Card header -->
					<div class="card-head p-4 pb-3">
						<div class="flex items-start gap-3">
							{#if (launch as any).logoUrl}
								<img src={(launch as any).logoUrl} alt="" class="card-logo" />
							{:else}
								<div class="card-logo card-logo-placeholder">
									{(launch.tokenSymbol || '?').charAt(0)}
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="syne font-bold text-white text-sm group-hover:text-cyan-300 transition truncate">{launch.tokenName || 'Unknown'}</span>
									<span class="text-gray-600 text-xs font-mono flex-shrink-0">{launch.tokenSymbol || '???'}</span>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="state-dot state-dot-{color}"></span>
									<span class="text-xs font-mono state-text-{color}">{stateLabel(launch.state)}</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Description preview -->
					{#if (launch as any).description}
						<div class="px-4 pb-2">
							<p class="text-gray-400 text-xs font-mono leading-relaxed line-clamp-2">{(launch as any).description}</p>
						</div>
					{/if}

					<!-- Raised + countdown row -->
					<div class="px-4 pb-2">
						<div class="flex justify-between items-baseline mb-1.5">
							<span class="text-white text-xs font-mono font-semibold">Raised {progress}%</span>
							{#if launch.state <= 1}
								<span class="countdown-text">{countdownStr(launch.deadline)}</span>
							{/if}
						</div>
						<div class="progress-track">
							<div class="progress-fill progress-{color}" style="width: {progress}%"></div>
						</div>
						<div class="flex justify-between mt-1">
							<span class="text-gray-500 text-[10px] font-mono">{formatUsdt(launch.totalBaseRaised, ud)}</span>
							<span class="text-gray-500 text-[10px] font-mono">{formatUsdt(launch.hardCap, ud)}</span>
						</div>
					</div>

					<!-- Card footer: badges + type -->
					<div class="card-foot px-4 py-2.5">
						<div class="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
							{#each ((launch as any).badges ?? []) as badge}
								{#if BADGE_META[badge]}
									<span class="badge-pill {BADGE_META[badge].cls}">{BADGE_META[badge].label}</span>
								{/if}
							{/each}
							<span class="badge-pill badge-pill-lp">LP Burned</span>
						</div>
						<span class="text-gray-600 text-[10px] font-mono flex-shrink-0">{CURVE_TYPES[launch.curveType]}</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page-wrap { padding-bottom: 40px; }
	.no-underline { text-decoration: none; }

	/* Stats bar */
	.stats-bar {
		display: flex;
		gap: 1px;
		background: var(--bg-surface-hover);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 10px;
		overflow: hidden;
	}
	.stat-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 12px 8px;
		background: var(--bg-surface);
	}
	.stat-value {
		font-size: 16px;
		font-weight: 700;
		color: #fff;
		font-family: 'Space Mono', monospace;
	}
	.stat-label {
		font-size: 10px;
		color: #6b7280;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-family: 'Space Mono', monospace;
	}

	/* Tabs */
	.tab-row {
		display: flex;
		gap: 2px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 10px;
		padding: 3px;
	}
	.tab-btn {
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		padding: 6px 14px;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: #6b7280;
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
	}
	.tab-btn:hover { color: #d1d5db; }
	.tab-active {
		background: rgba(0, 210, 255, 0.1);
		color: #00d2ff;
		font-weight: 600;
	}

	/* Filter controls */
	.filter-select {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		padding: 6px 12px;
		border-radius: 8px;
		border: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
		color: #9ca3af;
		cursor: pointer;
		min-width: 120px;
	}
	.filter-select:focus { border-color: rgba(0, 210, 255, 0.3); outline: none; }
	.filter-select option { background: var(--select-bg); }
	.filter-btn {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		padding: 6px 14px;
		border-radius: 8px;
		border: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
		color: #6b7280;
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.filter-btn:hover { color: #d1d5db; border-color: rgba(255,255,255,0.15); }
	.filter-btn-active {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
	}

	/* Launch card */
	.launch-card {
		overflow: hidden;
		transition: all 0.2s ease;
	}
	.launch-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.card-logo {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid var(--bg-surface-hover);
	}
	.card-logo-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
		font-size: 15px;
		font-weight: 700;
		font-family: 'Syne', sans-serif;
		border: 1px solid rgba(0, 210, 255, 0.15);
	}

	/* State dot */
	.state-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.state-dot-cyan { background: #00d2ff; box-shadow: 0 0 6px rgba(0,210,255,0.5); }
	.state-dot-amber { background: #f59e0b; }
	.state-dot-purple { background: #a78bfa; }
	.state-dot-red { background: #f87171; }
	.state-text-cyan { color: #00d2ff; }
	.state-text-amber { color: #f59e0b; }
	.state-text-purple { color: #a78bfa; }
	.state-text-red { color: #f87171; }

	/* Description clamp */
	.line-clamp-2 {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Countdown */
	.countdown-text {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: #f87171;
		font-weight: 600;
	}

	/* Progress */
	.progress-track {
		width: 100%;
		height: 6px;
		background: var(--bg-surface-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}
	.progress-cyan { background: linear-gradient(90deg, #00d2ff, #3a7bd5); }
	.progress-amber { background: linear-gradient(90deg, #f59e0b, #d97706); }
	.progress-purple { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }
	.progress-red { background: linear-gradient(90deg, #ef4444, #f87171); }

	/* Card footer */
	.card-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		border-top: 1px solid var(--bg-surface-hover);
	}

	/* Badge pills */
	.badge-pill {
		font-size: 9px;
		font-weight: 600;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 2px 6px;
		border-radius: 3px;
		border: 1px solid;
		white-space: nowrap;
	}
	.badge-list-cyan { background: rgba(0, 210, 255, 0.08); color: #00d2ff; border-color: rgba(0, 210, 255, 0.2); }
	.badge-list-emerald { background: rgba(16, 185, 129, 0.08); color: #34d399; border-color: rgba(16, 185, 129, 0.2); }
	.badge-list-purple { background: rgba(139, 92, 246, 0.08); color: #a78bfa; border-color: rgba(139, 92, 246, 0.2); }
	.badge-list-amber { background: rgba(245, 158, 11, 0.08); color: #fbbf24; border-color: rgba(245, 158, 11, 0.2); }
	.badge-list-blue { background: rgba(59, 130, 246, 0.08); color: #60a5fa; border-color: rgba(59, 130, 246, 0.2); }
	.badge-pill-lp { background: rgba(16, 185, 129, 0.08); color: #34d399; border-color: rgba(16, 185, 129, 0.2); }

	/* Skeleton */
	.skeleton-card { animation: skeletonPulse 1.5s ease-in-out infinite; }
	.skeleton-line {
		background: var(--bg-surface-hover);
		border-radius: 4px;
		animation: skeletonShimmer 1.5s ease-in-out infinite;
	}
	@keyframes skeletonPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
	@keyframes skeletonShimmer { 0%, 100% { background: var(--bg-surface-hover); } 50% { background: var(--border-input); } }

	.empty-state {
		min-height: 300px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	.syne { font-family: 'Syne', sans-serif; }
</style>
