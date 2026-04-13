<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import { t } from '$lib/i18n';
	import { favorites, toggleFavorite } from '$lib/favorites';
	import MarketFlow from '$lib/MarketFlow.svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
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
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
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
	let sortBy = $state<'newest' | 'ending' | 'raised' | 'progress' | 'trending'>('newest');
	let showMyLaunches = $state(false);
	let showFavorites = $state(false);
	let searchQuery = $state('');

	// Pagination
	const PAGE_SIZE = 12;
	let currentPage = $state(1);

	// Reset page when filters change
	$effect(() => {
		activeTab; selectedNetwork; showMyLaunches; showFavorites; sortBy; searchQuery;
		currentPage = 1;
	});

	// Hover tooltip
	let hoveredLaunch = $state<string | null>(null);
	let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

	function onCardMouseEnter(address: string) {
		hoverTimeout = setTimeout(() => { hoveredLaunch = address; }, 500);
	}
	function onCardMouseLeave() {
		if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
		hoveredLaunch = null;
	}

	// Countdown ticker
	let tickNow = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		if (!tickInterval) {
			tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
		}
		return () => { if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } };
	});

	function countdownMs(deadline: bigint): number {
		return Number(deadline) * 1000 - tickNow;
	}

	function countdownColor(deadline: bigint): string {
		const ms = countdownMs(deadline);
		if (ms <= 0) return 'text-gray-500';
		if (ms < 15 * 60 * 1000) return 'countdown-urgent';
		if (ms < 60 * 60 * 1000) return 'countdown-warning';
		return 'countdown-normal';
	}

	function isHot(launch: LaunchInfo): boolean {
		if (launch.state !== 1) return false;
		if (launch.hardCap === 0n) return false;
		return launch.totalBaseRaised * 100n / launch.hardCap > 50n;
	}

	function softCapPercent(launch: LaunchInfo): number {
		if (launch.hardCap === 0n) return 0;
		return Math.min(100, Number((launch.softCap * 100n) / launch.hardCap));
	}

	function truncateAddr(addr: string): string {
		if (!addr || addr.length < 10) return addr;
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function lpPercent(launch: LaunchInfo): string {
		const total = launch.tokensForCurve + launch.tokensForLP;
		if (total === 0n) return '0';
		return Number((launch.tokensForLP * 100n) / total).toFixed(0);
	}

	/** Token distribution breakdown: curve% / lp% / creator%. The contract
	 *  hardcodes 70% for curve; LP and creator share the remaining 30%. */
	function distroLabel(launch: LaunchInfo): string {
		const total = (launch as any).totalTokensRequired || (launch.tokensForCurve + launch.tokensForLP);
		if (total === 0n) return '';
		const curvePct = total > 0n ? Number((launch.tokensForCurve * 100n) / total) : 70;
		const creatorPct = Number(launch.creatorAllocationBps) / 100;
		const lpPct = Math.max(0, 100 - curvePct - creatorPct);
		const parts = [`${curvePct}% curve`, `${lpPct.toFixed(0)}% LP`];
		if (creatorPct > 0) parts.push(`${creatorPct.toFixed(0)}% creator`);
		return parts.join(' · ');
	}

	function vestingLabel(launch: LaunchInfo): string {
		const days = Number((launch as any).vestingDuration || 0n) / 86400;
		if (days <= 0) return '';
		return `${days}d vest`;
	}

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

		// Search filter
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(l =>
				(l.tokenName || '').toLowerCase().includes(q) ||
				(l.tokenSymbol || '').toLowerCase().includes(q)
			);
		}

		// Tab filter
		const nowSec = BigInt(Math.floor(Date.now() / 1000));
		if (activeTab === 'live') {
			result = result.filter(l => l.state === 1 && (l.startTimestamp === 0n || l.startTimestamp <= nowSec));
		} else if (activeTab === 'upcoming') {
			result = result.filter(l =>
				l.state === 0 || // pending deposit
				(l.state === 1 && l.startTimestamp > 0n && l.startTimestamp > nowSec) // scheduled
			);
		} else if (activeTab === 'graduated') {
			result = result.filter(l => l.state === 2 || l.state === 3);
		}

		if (selectedNetwork !== 'all') {
			result = result.filter(l => l.network.chain_id === selectedNetwork);
		}
		if (showMyLaunches && userAddress) {
			const addr = userAddress.toLowerCase();
			result = result.filter(l => l.creator.toLowerCase() === addr);
		}
		if (showFavorites) {
			const favs = $favorites;
			result = result.filter(l => favs.includes(l.address.toLowerCase()));
		}

		// Sort
		result = [...result];
		if (activeTab === 'upcoming') {
			// For upcoming: sort by start time (soonest first), then by deadline
			result.sort((a, b) => {
				const aStart = a.startTimestamp > 0n ? Number(a.startTimestamp) : Number(a.deadline);
				const bStart = b.startTimestamp > 0n ? Number(b.startTimestamp) : Number(b.deadline);
				return aStart - bStart;
			});
		} else if (sortBy === 'newest') {
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
		} else if (sortBy === 'progress' || sortBy === 'trending') {
			result.sort((a, b) => {
				if (sortBy === 'trending') {
					const aActive = a.state === 1 ? 1 : 0;
					const bActive = b.state === 1 ? 1 : 0;
					if (aActive !== bActive) return bActive - aActive;
				}
				const pA = a.hardCap > 0n ? Number((a.totalBaseRaised * 10000n) / a.hardCap) : 0;
				const pB = b.hardCap > 0n ? Number((b.totalBaseRaised * 10000n) / b.hardCap) : 0;
				return pB - pA;
			});
		}

		return result;
	});

	// Pagination derived values
	let totalPages = $derived(Math.max(1, Math.ceil(filteredLaunches.length / PAGE_SIZE)));
	let paginatedLaunches = $derived(filteredLaunches.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

	function pageLabel(): string {
		return $t('lp.pageOf').replace('{page}', String(currentPage)).replace('{total}', String(totalPages));
	}

	// Stats
	let nowBigInt = $derived(BigInt(Math.floor(tickNow / 1000)));
	let liveCount = $derived(launches.filter(l => l.state === 1 && (l.startTimestamp === 0n || l.startTimestamp <= nowBigInt)).length);
	let upcomingCount = $derived(launches.filter(l => l.state === 0 || (l.state === 1 && l.startTimestamp > 0n && l.startTimestamp > nowBigInt)).length);
	let graduatedCount = $derived(launches.filter(l => l.state === 2).length);
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
			startTimestamp: BigInt(row.start_timestamp || 0),
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

	async function loadFromDb(): Promise<boolean> {
		try {
			const { data: rows } = await supabase
				.from('launches')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(100);
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
			const { data: rows } = await supabase
				.from('badges')
				.select('launch_address, chain_id, badge_type');
			if (!rows) return;
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
		await loadFromDb();
		await loadBadges();
		loading = false;
	}

	// Realtime subscription for live updates
	let launchChannel: any;

	$effect(() => {
		if (providersReady) loadLaunches();
	});

	onMount(() => {
		launchChannel = supabase
			.channel('launchpad-explorer')
			.on('postgres_changes', { event: '*', schema: 'public', table: 'launches' }, () => {
				// Re-fetch on any change
				loadFromDb().then(() => loadBadges());
			})
			.subscribe();

		return () => {
			if (launchChannel) supabase.removeChannel(launchChannel);
		};
	});

	const BADGE_META: Record<string, { label: string; cls: string }> = {
		audit: { label: 'Audit', cls: 'badge-list-cyan' },
		kyc: { label: 'KYC', cls: 'badge-list-emerald' },
		partner: { label: 'Partner', cls: 'badge-list-purple' },
		doxxed: { label: 'Doxxed', cls: 'badge-list-amber' },
		safu: { label: 'SAFU', cls: 'badge-list-blue' },
		mintable: { label: 'Mintable', cls: 'badge-list-orange' },
		taxable: { label: 'Taxable', cls: 'badge-list-amber' },
		renounced: { label: 'No Owner', cls: 'badge-list-emerald' }
	};
</script>

<svelte:head>
	<title>{$t('lp.title')} | TokenKrafter</title>
	<meta name="description" content={$t('lp.metaDesc')} />
</svelte:head>

<div class="page-wrap max-w-[1400px] mx-auto px-4 sm:px-6 py-8 xl:grid xl:grid-cols-[1fr_320px] xl:gap-6">
	<div class="min-w-0">
	<!-- Header row -->
	<div class="flex flex-wrap items-end justify-between gap-4 mb-6">
		<div>
			<h1 class="syne text-2xl sm:text-3xl font-bold text-white">{$t('lp.title')}</h1>
			<p class="text-gray-500 font-mono text-xs mt-1">{$t('lp.subtitle')}</p>
		</div>
		<div class="flex gap-2">
			<a href="/create?launch=true" class="btn-primary text-xs px-4 py-2 no-underline">{$t('lp.createLaunch')}</a>
			<a href="/create" class="btn-secondary text-xs px-4 py-2 no-underline">{$t('lp.createToken')}</a>
		</div>
	</div>

	<!-- Stats bar (hide when all zeros) -->
	{#if launches.length > 0}
		<div class="stats-bar mb-5">
			<div class="stat-item">
				<span class="stat-value">{liveCount}</span>
				<span class="stat-label">{$t('lp.live')}</span>
			</div>
			{#if upcomingCount > 0}
				<div class="stat-item">
					<span class="stat-value">{upcomingCount}</span>
					<span class="stat-label">Upcoming</span>
				</div>
			{/if}
			<div class="stat-item">
				<span class="stat-value">{graduatedCount}</span>
				<span class="stat-label">{$t('lp.graduated')}</span>
			</div>
			<div class="stat-item">
				<span class="stat-value">{formatUsdt(totalRaised)}</span>
				<span class="stat-label">{$t('lp.totalRaised')}</span>
			</div>
		</div>
	{/if}

	<!-- Platform trust banner — contract-enforced guarantees -->
	<div class="trust-banner mb-5">
		<div class="trust-banner-inner">
			<svg class="trust-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
			<div class="trust-items">
				<span class="trust-item">
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
					LP permanently burned
				</span>
				<span class="trust-sep">·</span>
				<span class="trust-item">
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
					Instant token delivery
				</span>
				<span class="trust-sep">·</span>
				<span class="trust-item">
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
					Refundable if soft cap not met
				</span>
				<span class="trust-sep">·</span>
				<span class="trust-item">
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
					Unsold tokens burned
				</span>
			</div>
		</div>
	</div>

	<!-- Filters: tabs + search + sort on one row -->
	<div class="lp-controls">
		<div class="lp-controls-left">
			<div class="tab-row">
				<button class="tab-btn {activeTab === 'live' ? 'tab-active' : ''}" onclick={() => activeTab = 'live'}>{$t('lp.live')}{#if liveCount > 0} <span class="tab-count">{liveCount}</span>{/if}</button>
				<button class="tab-btn {activeTab === 'upcoming' ? 'tab-active' : ''}" onclick={() => activeTab = 'upcoming'}>{$t('lp.upcoming')}{#if upcomingCount > 0} <span class="tab-count">{upcomingCount}</span>{/if}</button>
				<button class="tab-btn {activeTab === 'graduated' ? 'tab-active' : ''}" onclick={() => activeTab = 'graduated'}>{$t('lp.graduated')}{#if graduatedCount > 0} <span class="tab-count">{graduatedCount}</span>{/if}</button>
				<button class="tab-btn {activeTab === 'all' ? 'tab-active' : ''}" onclick={() => activeTab = 'all'}>{$t('lp.all')}{#if launches.length > 0} <span class="tab-count">{launches.length}</span>{/if}</button>
			</div>
			<button
				onclick={() => { showFavorites = !showFavorites; if (showFavorites) showMyLaunches = false; }}
				class="tab-btn {showFavorites ? 'tab-active' : ''}"
			>
				<svg width="11" height="11" viewBox="0 0 24 24" fill={showFavorites ? '#00d2ff' : 'none'} stroke={showFavorites ? '#00d2ff' : 'currentColor'} stroke-width="2.5" style="display:inline;vertical-align:-1px;"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
			</button>
			{#if userAddress}
				<button
					onclick={() => { showMyLaunches = !showMyLaunches; if (showMyLaunches) showFavorites = false; }}
					class="tab-btn {showMyLaunches ? 'tab-active' : ''}"
				>Mine</button>
			{/if}
		</div>
		<div class="lp-controls-right">
			<div class="search-wrap">
				<svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<input type="text" class="input-field search-input" placeholder="Search..." bind:value={searchQuery} />
			</div>
			<select class="filter-select" bind:value={sortBy}>
				<option value="newest">{$t('lp.newest')}</option>
				<option value="ending">{$t('lp.endingSoon')}</option>
				<option value="raised">{$t('lp.mostRaised')}</option>
				<option value="trending">{$t('lp.trending')}</option>
			</select>
		</div>
	</div>

	<!-- Grid -->
	{#if loading}
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			{#each Array(4) as _}
				<div class="skeleton-card card p-0">
					<!-- Badges bar -->
					<div class="flex gap-2 px-4 pt-3 pb-1">
						<div class="skeleton-line" style="width:60px;height:18px;border-radius:99px;"></div>
					</div>
					<!-- Logo + name + state -->
					<div class="flex items-start gap-3 px-4 pb-3">
						<div class="skeleton-line" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;"></div>
						<div class="flex-1">
							<div class="skeleton-line" style="width:120px;height:14px;margin-bottom:6px;"></div>
							<div class="skeleton-line" style="width:80px;height:10px;"></div>
						</div>
					</div>
					<!-- Progress -->
					<div class="px-4 pb-4">
						<div class="flex justify-between mb-1.5">
							<div class="skeleton-line" style="width:70px;height:10px;"></div>
							<div class="skeleton-line" style="width:60px;height:10px;"></div>
						</div>
						<div class="skeleton-line" style="width:100%;height:6px;border-radius:99px;"></div>
						<div class="flex justify-between mt-1.5">
							<div class="skeleton-line" style="width:90px;height:9px;"></div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else if filteredLaunches.length === 0}
		<div class="lp-empty">
			{#if showFavorites}
				<svg class="lp-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
				<h3 class="lp-empty-title">No favorites yet</h3>
				<p class="lp-empty-sub">Tap the heart on any launch to save it here</p>
			{:else if showMyLaunches}
				<svg class="lp-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg>
				<h3 class="lp-empty-title">No launches yet</h3>
				<p class="lp-empty-sub">Create your first bonding curve launch</p>
			{:else if launches.length === 0}
				<svg class="lp-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
				<h3 class="lp-empty-title">No launches on the platform yet</h3>
				<p class="lp-empty-sub">Be the first to launch a token with bonding curve pricing</p>
			{:else}
				<svg class="lp-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<h3 class="lp-empty-title">No matching launches</h3>
				<p class="lp-empty-sub">Try adjusting your filters</p>
			{/if}
			<a href="/create?launch=true" class="lp-empty-cta">Create Launch</a>
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each paginatedLaunches as launch}
				{@const progress = progressPercent(launch.totalBaseRaised, launch.hardCap)}
				{@const color = stateColor(launch.state)}
				{@const ud = (launch as any).usdtDecimals ?? 18}
				{@const scPct = softCapPercent(launch)}
				<!-- svelte-ignore a11y_mouse_events_have_key_events -->
				<a
					href="/launchpad/{chainSlug((launch as any).network?.chain_id ?? 56)}/{launch.address}"
					class="launch-card card p-0 block no-underline group"
					style="position:relative"
					onmouseenter={() => onCardMouseEnter(launch.address)}
					onmouseleave={onCardMouseLeave}
				>
					<!-- Favorite button -->
					<button
						class="fav-btn {$favorites.includes(launch.address.toLowerCase()) ? 'fav-btn-active' : ''}"
						onclick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(launch.address); }}
						title={$favorites.includes(launch.address.toLowerCase()) ? 'Remove from favorites' : 'Add to favorites'}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill={$favorites.includes(launch.address.toLowerCase()) ? '#00d2ff' : 'none'} stroke={$favorites.includes(launch.address.toLowerCase()) ? '#00d2ff' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
					</button>

					<!-- 1. Badges banner (top) — per-launch attributes only.
					     Platform-wide guarantees (LP burned, refundable, unsold burn)
					     are in the trust banner above the grid, not per-card. -->
					<div class="card-badges-bar">
						{#each ((launch as any).badges ?? []) as badge}
							{#if BADGE_META[badge]}
								<span class="badge-pill {BADGE_META[badge].cls}">{BADGE_META[badge].label}</span>
							{/if}
						{/each}
						{#if launch.state === 1}
							<span class="badge-pill badge-pill-refundable">Refundable</span>
						{/if}
						{#if isHot(launch)}
							<span class="badge-pill badge-list-hot">HOT</span>
						{/if}
					</div>

					<!-- 2. Identity -->
					<div class="p-4 pb-3">
						<div class="flex items-start gap-3">
							{#if (launch as any).logoUrl}
								<img src={(launch as any).logoUrl} alt="" class="card-logo card-logo-adapt" />
							{:else}
								<div class="card-logo card-logo-placeholder">
									{(launch.tokenSymbol || '?').charAt(0)}
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="syne font-bold text-white text-sm group-hover:text-cyan-300 transition truncate">{launch.tokenName || 'Unknown'}</span>
									<span class="text-gray-600 text-xs font-mono shrink-0">{launch.tokenSymbol || '???'}</span>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="state-dot state-dot-{color}"></span>
									{#if launch.state === 1 && launch.startTimestamp > 0n && launch.startTimestamp > BigInt(Math.floor(Date.now() / 1000))}
										<span class="text-xs font-mono text-amber-400">Scheduled</span>
									{:else}
										<span class="text-xs font-mono state-text-{color}">{stateLabel(launch.state)}</span>
									{/if}
									<span class="text-gray-700 text-[10px] font-mono ml-auto">{CURVE_TYPES[launch.curveType]}</span>
								</div>
							</div>
						</div>
					</div>

					<!-- 3. Description preview -->
					{#if (launch as any).description}
						<div class="px-4 pb-2">
							<p class="text-gray-400 text-xs font-mono leading-relaxed line-clamp-2">{(launch as any).description}</p>
						</div>
					{/if}

					<!-- 3b. Token distribution — the trust row -->
					{#if distroLabel(launch)}
						<div class="card-distro">
							<span class="distro-text">{distroLabel(launch)}</span>
							{#if vestingLabel(launch)}
								<span class="distro-vest">{vestingLabel(launch)}</span>
							{/if}
						</div>
					{/if}

					<!-- 4. Progress + Timer (bottom) -->
					<div class="px-4 pb-4">
						<div class="flex justify-between items-baseline mb-1.5">
							<span class="text-white text-xs font-mono font-semibold">Raised {progress}%</span>
							<!-- Timer inline with progress -->
							{#if launch.state <= 1}
								{@const isScheduled = launch.startTimestamp > 0n && launch.startTimestamp > BigInt(Math.floor(tickNow / 1000))}
								{@const targetTs = isScheduled ? launch.startTimestamp : launch.deadline}
								{@const cdMs = countdownMs(targetTs)}
								{@const cdStr = countdownStr(targetTs)}
								{#if cdMs > 0}
									<span class="card-timer {isScheduled ? 'countdown-scheduled' : countdownColor(launch.deadline)}">
										{isScheduled ? 'Starts in ' : ''}{cdStr}
									</span>
								{:else}
									<span class="card-timer text-gray-600">Ended</span>
								{/if}
							{/if}
						</div>
						<div class="progress-track-wrap">
							<div class="progress-track">
								<div class="progress-fill progress-{color}" style="width: {progress}%"></div>
							</div>
							{#if scPct > 0 && scPct < 100}
								<div class="softcap-marker" style="left: {scPct}%">
									<div class="softcap-tick"></div>
									<div class="softcap-label">SC</div>
								</div>
							{/if}
						</div>
						<div class="flex justify-between mt-1">
							<span class="text-gray-600 text-[10px] font-mono">{formatUsdt(launch.totalBaseRaised, ud)} / {formatUsdt(launch.hardCap, ud)}</span>
						</div>
					</div>

					<!-- Hover tooltip -->
					{#if hoveredLaunch === launch.address}
						<div class="card-tooltip">
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.softCapLabel')}</span>
								<span class="tooltip-value">{formatUsdt(launch.softCap, ud)}</span>
							</div>
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.hardCapLabel')}</span>
								<span class="tooltip-value">{formatUsdt(launch.hardCap, ud)}</span>
							</div>
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.curveLabel')}</span>
								<span class="tooltip-value">{CURVE_TYPES[launch.curveType]}</span>
							</div>
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.creatorLabel')}</span>
								<span class="tooltip-value">{truncateAddr(launch.creator)}</span>
							</div>
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.tokensForLpLabel')}</span>
								<span class="tooltip-value">{lpPercent(launch)}%</span>
							</div>
							<div class="tooltip-row">
								<span class="tooltip-label">{$t('lp.creatorAllocLabel')}</span>
								<span class="tooltip-value">{(Number(launch.creatorAllocationBps) / 100).toFixed(1)}%</span>
							</div>
						</div>
					{/if}
				</a>
			{/each}
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="pagination-bar">
				<button
					class="pagination-btn"
					disabled={currentPage <= 1}
					onclick={() => currentPage = Math.max(1, currentPage - 1)}
				>{$t('lp.previous')}</button>
				<span class="pagination-info">{pageLabel()}</span>
				<button
					class="pagination-btn"
					disabled={currentPage >= totalPages}
					onclick={() => currentPage = Math.min(totalPages, currentPage + 1)}
				>{$t('lp.next')}</button>
			</div>
		{/if}
	{/if}
	</div>
	<!-- Market Flow sidebar — always present on desktop so skeleton matches loaded layout -->
	<div class="lp-sidebar hidden xl:block">
		<MarketFlow />
	</div>
</div>

<style>
	.lp-sidebar {
		position: sticky;
		top: 0;
		height: calc(100vh - 56px);
		overflow: hidden;
	}
	/* Controls row */
	.lp-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
	.lp-controls-left { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
	.lp-controls-right { display: flex; align-items: center; gap: 8px; }
	.tab-count { font-size: 9px; opacity: 0.5; margin-left: 2px; }

	/* Empty state */
	.lp-empty {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		padding: 48px 20px; text-align: center;
	}
	.lp-empty-icon { margin-bottom: 4px; }
	.lp-empty-title { font-family: 'Syne', sans-serif; font-size: 17px; font-weight: 700; color: var(--text-heading); margin: 0; }
	.lp-empty-sub { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text-dim); margin: 0; max-width: 300px; }
	.lp-empty-cta {
		margin-top: 10px; padding: 10px 22px; border-radius: 10px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
		text-decoration: none; transition: all 0.2s;
	}
	.lp-empty-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,210,255,0.3); }

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
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
	}
	.stat-label {
		font-size: 10px;
		color: var(--text-dim);
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
		color: var(--text-dim);
		cursor: pointer;
		transition: all var(--transition-fast);
		white-space: nowrap;
	}
	.tab-btn:hover { color: var(--text); }
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
		color: var(--text-muted);
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
		color: var(--text-dim);
		cursor: pointer;
		transition: all var(--transition-fast);
	}
	.filter-btn:hover { color: var(--text); border-color: var(--text-dim); }
	.filter-btn-active {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
	}

	/* Search bar */
	.search-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}
	.search-icon {
		position: absolute;
		left: 10px;
		color: var(--text-dim);
		pointer-events: none;
	}
	.search-input {
		padding-left: 30px !important;
		min-width: 180px;
		max-width: 260px;
		font-size: 11px;
		height: 32px;
	}
	@media (max-width: 640px) {
		.search-wrap {
			width: 100%;
			order: 10;
		}
		.search-input {
			width: 100%;
			max-width: none;
		}
	}

	/* Launch card */
	.launch-card {
		overflow: visible;
		transition: all var(--transition-base);
	}
	.launch-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	/* Hot badge */
	.hot-badge {
		position: absolute;
		top: 8px;
		right: 36px;
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 9px;
		font-weight: 700;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		padding: 2px 7px;
		border-radius: 4px;
		background: rgba(245, 158, 11, 0.15);
		color: #fbbf24;
		border: 1px solid rgba(245, 158, 11, 0.3);
		z-index: 2;
		letter-spacing: 0.03em;
	}
	.hot-flame {
		color: #f59e0b;
	}

	/* Prominent countdown banner */
	/* Badge banner at top of card */
	.card-badges-bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 12px;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--border-subtle);
		min-height: 32px;
	}

	/* Timer next to progress (bottom of card) */
	.card-timer {
		font-size: 11px;
		font-weight: 600;
		font-family: 'Space Mono', monospace;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.countdown-normal { color: #00d2ff; }
	.countdown-warning { color: #fbbf24; }
	.countdown-urgent { color: #f87171; animation: urgentPulse 1.5s ease-in-out infinite; }
	.countdown-scheduled { color: #f59e0b; }

	.badge-list-hot {
		background: rgba(239, 68, 68, 0.1);
		color: #f87171;
		border-color: rgba(239, 68, 68, 0.2);
	}
	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.7; }
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

	/* Progress bar with soft cap marker */
	.progress-track-wrap {
		position: relative;
		height: 16px;
	}
	.progress-track-wrap .progress-track {
		height: 6px;
		margin-top: 2px;
	}
	.softcap-marker {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		pointer-events: none;
	}
	.softcap-tick {
		width: 2px;
		height: 10px;
		background: rgba(255, 255, 255, 0.4);
		border-radius: 1px;
	}
	.softcap-label {
		font-size: 7px;
		font-family: 'Space Mono', monospace;
		color: rgba(255, 255, 255, 0.35);
		margin-top: 1px;
		letter-spacing: 0.03em;
	}

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
	.badge-list-orange { background: rgba(249, 115, 22, 0.08); color: #fb923c; border-color: rgba(249, 115, 22, 0.2); }
	.badge-pill-lp { background: rgba(16, 185, 129, 0.08); color: #34d399; border-color: rgba(16, 185, 129, 0.2); }
	.badge-pill-refundable { background: rgba(0,210,255,0.08); color: #22d3ee; border-color: rgba(0,210,255,0.2); }

	/* ── Platform trust banner ── */
	.trust-banner {
		background: rgba(16,185,129,0.04);
		border: 1px solid rgba(16,185,129,0.15);
		border-radius: 10px; overflow: hidden;
	}
	.trust-banner-inner {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 16px;
	}
	.trust-icon { color: #10b981; flex-shrink: 0; }
	.trust-items {
		display: flex; align-items: center; gap: 6px;
		flex-wrap: wrap;
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-muted);
	}
	.trust-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
	.trust-sep { color: var(--text-dim); opacity: 0.3; }
	@media (max-width: 640px) {
		.trust-banner-inner { flex-direction: column; align-items: flex-start; gap: 6px; }
		.trust-items { gap: 4px; }
		.trust-sep { display: none; }
		.trust-item { font-size: 10px; }
	}

	/* ── Token distribution row on card ── */
	.card-distro {
		display: flex; align-items: center; justify-content: space-between; gap: 6px;
		padding: 0 16px 6px;
		font-family: 'Space Mono', monospace; font-size: 9px;
	}
	.distro-text { color: var(--text-dim); }
	.distro-vest {
		color: #10b981; font-weight: 600;
		padding: 1px 6px; border-radius: 4px;
		background: rgba(16,185,129,0.08);
	}

	/* Skeleton card pulse */
	.skeleton-card { animation: skeletonPulse 1.5s ease-in-out infinite; }
	@keyframes skeletonPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

	.empty-state {
		min-height: 300px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	/* Favorite button on cards */
	.fav-btn {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 2;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 50%;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all var(--transition-fast);
		color: var(--text-dim);
		opacity: 0;
	}
	.launch-card:hover .fav-btn,
	.fav-btn:focus-visible,
	.fav-btn-active {
		opacity: 1;
	}
	.fav-btn:hover {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
	}

	/* Hover tooltip */
	.card-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
		padding: 10px 14px;
		min-width: 220px;
		z-index: 50;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
		pointer-events: none;
	}
	.card-tooltip::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		border: 6px solid transparent;
		border-top-color: var(--bg-surface-hover);
	}
	.tooltip-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 2px 0;
	}
	.tooltip-row + .tooltip-row {
		border-top: 1px solid rgba(255, 255, 255, 0.04);
	}
	.tooltip-label {
		font-size: 10px;
		color: var(--text-dim);
		font-family: 'Space Mono', monospace;
	}
	.tooltip-value {
		font-size: 10px;
		color: var(--text);
		font-family: 'Space Mono', monospace;
		font-weight: 600;
	}

	/* Pagination */
	.pagination-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		margin-top: 24px;
		padding: 12px 0;
	}
	.pagination-btn {
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		padding: 6px 16px;
		border-radius: 8px;
		border: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
		color: var(--text-muted);
		cursor: pointer;
		transition: all var(--transition-fast);
	}
	.pagination-btn:hover:not(:disabled) {
		color: #00d2ff;
		border-color: rgba(0, 210, 255, 0.3);
		background: rgba(0, 210, 255, 0.05);
	}
	.pagination-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.pagination-info {
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		color: var(--text-dim);
	}
</style>
