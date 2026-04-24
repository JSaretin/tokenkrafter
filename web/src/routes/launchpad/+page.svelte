<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount, untrack } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import { t } from '$lib/i18n';
	import { favorites, toggleFavorite } from '$lib/favorites';
	import MarketFlow from '$lib/MarketFlow.svelte';
	import LaunchCountdown from '$lib/LaunchCountdown.svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import {
		type LaunchInfo,
		type LaunchState,
		fetchTokenMeta,
		stateColor,
		stateLabel,
		formatUsdt,
		formatTokens,
		progressPercent,
		timeRemaining,
		CURVE_TYPES
	} from '$lib/launchpad';
	import { LaunchpadFactoryClient } from '$lib/contracts/launchpadFactory';
	import { LaunchInstanceClient } from '$lib/contracts/launchInstance';

	let getUserAddress: () => string | null = getContext('userAddress');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	let { data: pageData }: { data: any } = $props();

	// Fallback network stubs for SSR pre-render (before real networks load)
	const CHAIN_STUBS: Record<number, Partial<SupportedNetwork>> = {
		56: { chain_id: 56, name: 'BNB Smart Chain', symbol: 'bsc', native_coin: 'BNB' },
		1: { chain_id: 1, name: 'Ethereum', symbol: 'eth', native_coin: 'ETH' },
	};

	function ssrRowToLaunch(row: any): (LaunchInfo & { network: SupportedNetwork }) | null {
		const net = supportedNetworks.find((n) => n.chain_id === row.chain_id)
			|| CHAIN_STUBS[row.chain_id] as SupportedNetwork;
		if (!net) return null;
		return {
			address: row.address, token: row.token_address, creator: row.creator,
			curveType: row.curve_type, state: row.state,
			softCap: BigInt(row.soft_cap || '0'), hardCap: BigInt(row.hard_cap || '0'),
			deadline: BigInt(row.deadline || 0), startTimestamp: BigInt(row.start_timestamp || 0),
			totalBaseRaised: BigInt(row.total_base_raised || '0'),
			tokensSold: BigInt(row.tokens_sold || '0'),
			tokensForCurve: BigInt(row.tokens_for_curve || '0'),
			tokensForLP: BigInt(row.tokens_for_lp || '0'),
			creatorAllocationBps: BigInt(row.creator_allocation_bps || 0),
			currentPrice: BigInt(row.current_price || '0'), usdtAddress: '',
			totalTokensRequired: BigInt(row.total_tokens_required || '0'),
			totalTokensDeposited: BigInt(row.total_tokens_deposited || '0'),
			tokenName: row.token_name, tokenSymbol: row.token_symbol,
			tokenDecimals: row.token_decimals ?? 18, usdtDecimals: row.usdt_decimals ?? 18,
			totalBuyers: row.total_buyers ?? 0, totalPurchases: row.total_purchases ?? 0,
			description: row.description, logoUrl: row.logo_url,
			badges: row.badges || [], tokenTrust: row.tokenTrust || null,
			network: net,
		} as any;
	}

	// Pre-populate from SSR for instant render
	let launches: (LaunchInfo & { network: SupportedNetwork })[] = $state(
		(pageData?.launches || []).map(ssrRowToLaunch).filter(Boolean)
	);
	let loading = $state(!pageData?.launches?.length);
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

	// Countdown ticker — only runs when at least one launch has a time-sensitive
	// state (live or scheduled). Idle pages with no launches would otherwise
	// recompute nowBigInt/liveCount/upcomingCount every second for nothing.
	let tickNow = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	let needsTick = $derived(
		launches.some((l) => l.state === 1 || (l.state === 0 && l.startTimestamp > 0n))
	);

	$effect(() => {
		if (needsTick && !tickInterval) {
			tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
		} else if (!needsTick && tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
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
		if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
		if (h > 0) return `${h}h ${m}m ${s}s`;
		return `${m}m ${s}s`;
	}

	function countdownParts(deadline: bigint): { d: number; h: number; m: number; s: number; ended: boolean } {
		const ms = Number(deadline) * 1000 - tickNow;
		if (ms <= 0) return { d: 0, h: 0, m: 0, s: 0, ended: true };
		return {
			d: Math.floor(ms / 86400000),
			h: Math.floor((ms % 86400000) / 3600000),
			m: Math.floor((ms % 3600000) / 60000),
			s: Math.floor((ms % 60000) / 1000),
			ended: false,
		};
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

	// Smart default tab: don't strand the user on an empty "Live" view
	// when the platform has only graduated launches. Runs once data has
	// loaded, and only if the user hasn't already changed tab.
	let _tabAutoSwitched = false;
	$effect(() => {
		if (loading || _tabAutoSwitched || activeTab !== 'live' || launches.length === 0) return;
		if (liveCount > 0) { _tabAutoSwitched = true; return; }
		if (graduatedCount > 0) activeTab = 'graduated';
		else if (upcomingCount > 0) activeTab = 'upcoming';
		else activeTab = 'all';
		_tabAutoSwitched = true;
	});

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
			totalBuyers: row.total_buyers ?? 0,
			totalPurchases: row.total_purchases ?? 0,
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

			// Fetch token logos + trust signals for all launches in one query
			const tokenAddrs = mapped.map(l => l.token?.toLowerCase()).filter(Boolean);
			if (tokenAddrs.length > 0) {
				const { data: tokenRows } = await supabase
					.from('created_tokens')
					.select('address, logo_url, is_safu, is_kyc, is_mintable, is_taxable, is_partner, lp_burned, tax_ceiling_locked, owner_renounced')
					.in('address', tokenAddrs);
				const tokenByAddr = new Map<string, any>();
				for (const t of tokenRows || []) {
					tokenByAddr.set(t.address.toLowerCase(), t);
				}
				for (const l of mapped) {
					const addr = l.token?.toLowerCase();
					const t = tokenByAddr.get(addr);
					if (t) {
						if (!(l as any).logoUrl && t.logo_url) (l as any).logoUrl = t.logo_url;
						(l as any).tokenTrust = {
							is_safu: t.is_safu,
							is_kyc: t.is_kyc,
							is_mintable: t.is_mintable,
							is_taxable: t.is_taxable,
							is_partner: t.is_partner,
							is_platform: true, // exists in created_tokens = made via our factory
							lp_burned: t.lp_burned,
							tax_ceiling_locked: t.tax_ceiling_locked,
							owner_renounced: t.owner_renounced,
						};
					}
					// No row in created_tokens = external token, no "Audited" badge
				}
			}

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
				const factory = new LaunchpadFactoryClient(net.launchpad_address, provider);
				const count = await factory.totalLaunches();
				const limit = Math.min(count, 50);
				const offset = Math.max(0, count - limit);
				const addrs = await factory.getLaunches(offset, limit);
				for (const addr of addrs) {
					try {
						const info = await fetchLaunchInfoViaClient(addr, provider);
						const meta = await fetchTokenMeta(info.token, provider);
						allLaunches.push({ ...info, tokenName: meta.name, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals, network: net });
					} catch (e) { console.warn(`Failed to load launch ${addr}:`, e); }
				}
			} catch (e) { console.warn(`Failed to load launches from ${net.name}:`, e); }
		}
		allLaunches.sort((a, b) => Number(b.deadline - a.deadline));
		launches = allLaunches;
	}

	/**
	 * Fetch LaunchInfo for a single launch using LaunchInstanceClient. Mirrors
	 * the shape returned by `fetchLaunchInfo` in `$lib/launchpad` but uses the
	 * typed client instead of a raw ethers.Contract.
	 */
	async function fetchLaunchInfoViaClient(
		launchAddress: string,
		provider: ethers.Provider,
	): Promise<LaunchInfo> {
		const client = new LaunchInstanceClient(launchAddress, provider);
		const [info, totalTokensRequired, totalTokensDeposited, effectiveState, totalBuyers, totalPurchases] = await Promise.all([
			client.getLaunchInfo(),
			client.totalTokensRequired(),
			client.totalTokensDeposited(),
			client.effectiveState().catch(() => null),
			client.totalBuyers().catch(() => 0),
			client.totalPurchases().catch(() => 0),
		]);
		return {
			address: launchAddress,
			token: info.token,
			creator: info.creator,
			curveType: Number(info.curveType) as LaunchInfo['curveType'],
			state: (effectiveState != null ? Number(effectiveState) : Number(info.state)) as LaunchState,
			softCap: info.softCap,
			hardCap: info.hardCap,
			deadline: info.deadline,
			totalBaseRaised: info.totalBaseRaised,
			tokensSold: info.tokensSold,
			tokensForCurve: info.tokensForCurve,
			tokensForLP: info.tokensForLP,
			creatorAllocationBps: info.creatorAllocationBps,
			currentPrice: info.currentPrice,
			usdtAddress: info.usdt,
			startTimestamp: info.startTimestamp,
			totalTokensRequired,
			totalTokensDeposited,
			totalBuyers: Number(totalBuyers),
			totalPurchases: Number(totalPurchases),
		} as LaunchInfo;
	}

	async function loadBadges() {
		try {
			if (launches.length === 0) return;
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
		// If SSR already populated, just refresh badges in background
		if (launches.length > 0 && loading === false) {
			loadFromDb().then(() => loadBadges());
			return;
		}
		loading = true;
		await Promise.all([loadFromDb(), loadBadges()]);
		loading = false;
	}

	// Realtime subscription for live updates
	let launchChannel: any;

	// Only fire on the providersReady flip; wrap the async call in untrack so
	// reads inside loadLaunches (which reassigns `launches`) don't re-trigger
	// this effect and cause an empty-result reload loop.
	$effect(() => {
		if (providersReady) untrack(() => { loadLaunches(); });
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
			<h1 class="heading-1">{$t('lp.title')}</h1>
			<p class="text-muted font-mono text-xs mt-1">{$t('lp.subtitle')}</p>
		</div>
		<div class="flex gap-2">
			<!-- Single primary CTA — /create handles the intent picker
			     (token / token+launch / token+listing). Two side-by-side
			     CTAs here just duplicated that choice a step earlier. -->
			<a href="/create" class="btn-primary text-xs px-4 py-2 no-underline">{$t('lp.createLaunch')}</a>
		</div>
	</div>

	<!-- Stats bar -->
	{#if loading}
		<div class="flex gap-px bg-surface-hover border border-surface-hover rounded-[10px] overflow-hidden mb-5">
			<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface"><span class="skeleton-line" style="width:30px;height:22px;border-radius:4px;"></span><span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.live')}</span></div>
			<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface"><span class="skeleton-line" style="width:30px;height:22px;border-radius:4px;"></span><span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.graduated')}</span></div>
			<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface"><span class="skeleton-line" style="width:70px;height:22px;border-radius:4px;"></span><span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.totalRaised')}</span></div>
		</div>
	{:else if launches.length > 0}
		<div class="flex gap-px bg-surface-hover border border-surface-hover rounded-[10px] overflow-hidden mb-5">
			<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface">
				<span class="text-base font-bold text-heading font-mono">{liveCount}</span>
				<span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.live')}</span>
			</div>
			{#if upcomingCount > 0}
				<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface">
					<span class="text-base font-bold text-heading font-mono">{upcomingCount}</span>
					<span class="text-3xs text-dim uppercase tracking-wider font-mono">Upcoming</span>
				</div>
			{/if}
			{#if graduatedCount > 0}
				<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface">
					<span class="text-base font-bold text-heading font-mono">{graduatedCount}</span>
					<span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.graduated')}</span>
				</div>
			{/if}
			<div class="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 bg-surface">
				<span class="text-base font-bold text-heading font-mono">{formatUsdt(totalRaised)}</span>
				<span class="text-3xs text-dim uppercase tracking-wider font-mono">{$t('lp.totalRaised')}</span>
			</div>
		</div>
	{/if}

	<!-- Platform trust banner — contract-enforced guarantees -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line-subtle rounded-[10px] overflow-hidden mb-5">
		<div class="flex flex-col items-center gap-1.5 py-3 px-2 bg-surface text-center font-numeric text-xs2 text-muted leading-snug">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			<span>LP burned permanently</span>
		</div>
		<div class="flex flex-col items-center gap-1.5 py-3 px-2 bg-surface text-center font-numeric text-xs2 text-muted leading-snug">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
			<span>Instant token delivery</span>
		</div>
		<div class="flex flex-col items-center gap-1.5 py-3 px-2 bg-surface text-center font-numeric text-xs2 text-muted leading-snug">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
			<span>Refundable if soft cap missed</span>
		</div>
		<div class="flex flex-col items-center gap-1.5 py-3 px-2 bg-surface text-center font-numeric text-xs2 text-muted leading-snug">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
			<span>Unsold tokens burned</span>
		</div>
	</div>

	<!-- Filters: tabs + search + sort on one row -->
	<div class="flex items-center justify-between gap-2.5 mb-4 flex-wrap">
		<div class="flex items-center gap-1 flex-wrap">
			<div class="flex gap-0.5 bg-surface border border-surface-hover rounded-[10px] p-[3px]">
				<button class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (activeTab === 'live' ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')} onclick={() => activeTab = 'live'}>{$t('lp.live')} <span class="text-xs4 opacity-50 ml-0.5">{liveCount}</span></button>
				<button class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (activeTab === 'upcoming' ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')} onclick={() => activeTab = 'upcoming'}>{$t('lp.upcoming')} <span class="text-xs4 opacity-50 ml-0.5">{upcomingCount}</span></button>
				<button class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (activeTab === 'graduated' ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')} onclick={() => activeTab = 'graduated'}>{$t('lp.graduated')} <span class="text-xs4 opacity-50 ml-0.5">{graduatedCount}</span></button>
				<button class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (activeTab === 'all' ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')} onclick={() => activeTab = 'all'}>{$t('lp.all')} <span class="text-xs4 opacity-50 ml-0.5">{launches.length}</span></button>
			</div>
			<button
				onclick={() => { showFavorites = !showFavorites; if (showFavorites) showMyLaunches = false; }}
				class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (showFavorites ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')}
				title="Favorites"
			>
				<svg width="11" height="11" viewBox="0 0 24 24" fill={showFavorites ? '#00d2ff' : 'none'} stroke={showFavorites ? '#00d2ff' : 'currentColor'} stroke-width="2.5" class="inline align-[-1px]"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
			</button>
			{#if userAddress}
				<button
					onclick={() => { showMyLaunches = !showMyLaunches; if (showMyLaunches) showFavorites = false; }}
					class={'text-xs font-mono px-3.5 py-1.5 rounded-lg border-none cursor-pointer transition whitespace-nowrap ' + (showMyLaunches ? 'bg-brand-cyan/10 text-brand-cyan font-semibold' : 'bg-transparent text-dim hover:text-foreground')}
				>Mine</button>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<div class="relative flex items-center max-sm:w-full max-sm:order-10">
				<svg class="absolute left-2.5 text-dim pointer-events-none" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<input type="text" class="input-field pl-[30px]! min-w-[180px] max-w-[260px] text-xs2 h-8 max-sm:w-full max-sm:max-w-none" placeholder="Search..." bind:value={searchQuery} />
			</div>
			<select class="text-xs2 font-mono px-3 py-1.5 rounded-lg border border-surface-hover bg-surface text-muted cursor-pointer min-w-[120px] focus:border-brand-cyan/30 focus:outline-none [&>option]:bg-select" bind:value={sortBy}>
				<option value="newest">{$t('lp.newest')}</option>
				<option value="ending">{$t('lp.endingSoon')}</option>
				<option value="raised">{$t('lp.mostRaised')}</option>
				<option value="trending">{$t('lp.trending')}</option>
			</select>
		</div>
	</div>

	<!-- Grid -->
	{#if loading}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(6) as _}
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
		<div class="flex flex-col items-center gap-2 py-12 px-5 text-center">
			{#if showFavorites}
				<svg class="mb-1" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
				<h3 class="font-display text-17 font-bold text-heading m-0">No favorites yet</h3>
				<p class="font-mono text-xs text-dim m-0 max-w-[300px]">Tap the heart on any launch to save it here</p>
			{:else if showMyLaunches}
				<svg class="mb-1" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg>
				<h3 class="font-display text-17 font-bold text-heading m-0">No launches yet</h3>
				<p class="font-mono text-xs text-dim m-0 max-w-[300px]">Create your first bonding curve launch</p>
			{:else if launches.length === 0}
				<svg class="mb-1" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
				<h3 class="font-display text-17 font-bold text-heading m-0">No launches on the platform yet</h3>
				<p class="font-mono text-xs text-dim m-0 max-w-[300px]">Be the first to launch a token with bonding curve pricing</p>
			{:else}
				<svg class="mb-1" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<h3 class="font-display text-17 font-bold text-heading m-0">No matching launches</h3>
				<p class="font-mono text-xs text-dim m-0 max-w-[300px]">Try adjusting your filters</p>
			{/if}
			<a href="/create?launch=true" class="mt-2.5 px-[22px] py-2.5 rounded-[10px] bg-gradient-to-br from-brand-cyan to-brand-blue text-white font-display font-bold text-13 no-underline transition hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(0,210,255,0.3)]">Create Launch</a>
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
					class="launch-card card p-0 block no-underline group relative overflow-visible transition hover:-translate-y-0.5 hover:shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
					onmouseenter={() => onCardMouseEnter(launch.address)}
					onmouseleave={onCardMouseLeave}
				>
					<!-- Favorite button -->
					<button
						class={'absolute top-2.5 right-2.5 z-[2] bg-surface border border-line rounded-full w-[30px] h-[30px] flex items-center justify-center cursor-pointer transition text-dim hover:border-brand-cyan/40 hover:bg-brand-cyan/10 hover:text-brand-cyan group-hover:opacity-100 focus-visible:opacity-100 ' + ($favorites.includes(launch.address.toLowerCase()) ? 'opacity-100' : 'opacity-0')}
						onclick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(launch.address); }}
						title={$favorites.includes(launch.address.toLowerCase()) ? 'Remove from favorites' : 'Add to favorites'}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill={$favorites.includes(launch.address.toLowerCase()) ? '#00d2ff' : 'none'} stroke={$favorites.includes(launch.address.toLowerCase()) ? '#00d2ff' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
					</button>

					<!-- 1. Badges banner (top) — per-launch attributes only.
					     Platform-wide guarantees (LP burned, refundable, unsold burn)
					     are in the trust banner above the grid, not per-card. -->
					<div class="flex items-center gap-1 px-3 py-1.5 flex-wrap border-b border-line-subtle min-h-[32px]">
						{#each ((launch as any).badges ?? []) as badge}
							{#if BADGE_META[badge]}
								<span class="badge-pill {BADGE_META[badge].cls}">{BADGE_META[badge].label}</span>
							{/if}
						{/each}
						{#if (launch as any).tokenTrust?.is_safu}
							<span class="badge-pill badge-pill-safu">SAFU</span>
						{/if}
						{#if (launch as any).tokenTrust?.is_kyc}
							<span class="badge-pill badge-pill-kyc">KYC</span>
						{/if}
						{#if (launch as any).tokenTrust?.is_platform}
							<span class="badge-pill badge-pill-audited">Audited</span>
						{/if}
						{#if (launch as any).tokenTrust?.is_mintable}
							<span class="badge-pill badge-pill-mintable">Mintable</span>
						{/if}
						{#if (launch as any).tokenTrust?.is_taxable}
							{@const bt = (launch as any).tokenTrust?.buy_tax_bps ?? 0}
							{@const st = (launch as any).tokenTrust?.sell_tax_bps ?? 0}
							{#if bt > 0 || st > 0}
								{#if (launch as any).tokenTrust?.tax_ceiling_locked}
									<span class="badge-pill badge-pill-tax-locked">Tax {(bt/100).toFixed(0)}/{(st/100).toFixed(0)}% Locked</span>
								{:else}
									<span class="badge-pill badge-pill-taxable">Tax {(bt/100).toFixed(0)}/{(st/100).toFixed(0)}%</span>
								{/if}
							{/if}
						{/if}
						{#if (launch as any).tokenTrust?.is_partner}
							<span class="badge-pill badge-pill-partner">Partner</span>
						{/if}
						{#if isHot(launch)}
							<span class="badge-pill badge-list-hot">HOT</span>
						{/if}
					</div>

					<!-- 2. Identity -->
					<div class="p-4 pb-3">
						<div class="flex items-start gap-3">
							{#if (launch as any).logoUrl}
								<img src={(launch as any).logoUrl} alt="" class="w-10 h-10 rounded-full object-cover shrink-0 border border-surface-hover card-logo-adapt" />
							{:else}
								<div class="w-10 h-10 rounded-full shrink-0 border border-brand-cyan/15 flex items-center justify-center bg-brand-cyan/10 text-brand-cyan text-15 font-bold font-display">
									{(launch.tokenSymbol || '?').charAt(0)}
								</div>
							{/if}
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="font-display font-bold text-heading text-sm group-hover:text-cyan-300 transition truncate">{launch.tokenName || 'Unknown'}</span>
									<span class="text-muted text-xs font-mono shrink-0">{launch.tokenSymbol || '???'}</span>
								</div>
								<div class="flex items-center gap-1.5">
									<span class="state-dot state-dot-{color}"></span>
									{#if launch.state === 1 && launch.startTimestamp > 0n && launch.startTimestamp > BigInt(Math.floor(Date.now() / 1000))}
										<span class="text-xs font-mono text-amber-400">Scheduled</span>
									{:else}
										<span class="text-xs font-mono state-text-{color}">{stateLabel(launch.state)}</span>
									{/if}
									<span class="text-dim text-3xs font-mono ml-auto">{CURVE_TYPES[launch.curveType]}</span>
								</div>
							</div>
						</div>
					</div>

					<!-- 3. Description preview -->
					{#if (launch as any).description}
						<div class="px-4 pb-2">
							<p class="text-foreground text-xs font-mono leading-relaxed line-clamp-2">{(launch as any).description}</p>
						</div>
					{/if}

					<!-- 3b. Key stats + SC badge -->
					<div class="flex gap-px mx-4 mb-2 bg-line-subtle rounded-lg overflow-hidden">
						<div class="flex-1 py-1.5 px-2.5 bg-white/[0.02]">
							<span class="block font-numeric text-xs4 text-dim uppercase tracking-wider">Hard Cap</span>
							<span class="font-display text-xs font-bold text-heading">{formatUsdt(launch.hardCap, ud)}</span>
						</div>
						<div class="flex-1 py-1.5 px-2.5 bg-white/[0.02]">
							<span class="block font-numeric text-xs4 text-dim uppercase tracking-wider">Buyers</span>
							{#if (launch as any).totalBuyers > 0}
								<span class="font-display text-xs font-bold text-heading">{(launch as any).totalBuyers}</span>
							{:else if launch.totalBaseRaised > 0n}
								<span class="font-display text-xs font-bold text-heading">-</span>
							{:else}
								<span class="font-display font-bold text-brand-cyan text-3xs">Be first!</span>
							{/if}
						</div>
					</div>
					{#if launch.totalBaseRaised >= launch.softCap && launch.softCap > 0n}
						<div class="flex items-center justify-center gap-1.5 mx-4 mb-2 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/15 font-mono text-xs4 font-bold text-emerald-500">
							<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
							Soft cap reached — will graduate
						</div>
					{/if}

					<!-- 4. Countdown Timer Grid -->
					{#if launch.state <= 1}
						{@const isScheduled = launch.startTimestamp > 0n && launch.startTimestamp > BigInt(Math.floor(tickNow / 1000))}
						{@const targetTs = isScheduled ? launch.startTimestamp : launch.deadline}
						{@const cd = countdownParts(targetTs)}
						{#if !cd.ended}
							<div class="px-4 pb-3">
								<LaunchCountdown
									deadline={Number(targetTs)}
									label={isScheduled ? 'Starts in' : 'Sale ends in'}
									variant={isScheduled ? 'amber' : 'cyan'}
									size="md"
								/>
							</div>
						{/if}
					{/if}

					<!-- 5. Progress -->
					<div class="px-4 pt-3 pb-4 border-t border-line-subtle">
						<div class="flex justify-between items-baseline mb-2">
							<span class="text-heading text-xs font-mono font-semibold">Raised {progress}%</span>
							<span class="text-muted text-3xs font-mono">{formatUsdt(launch.hardCap, ud)}</span>
						</div>
						<div class="relative h-5">
							<div class="progress-track h-3 mt-0.5 rounded-md border border-line-subtle">
								<div class="progress-fill progress-{color}" style="width: {progress}%"></div>
							</div>
							{#if scPct > 0 && scPct < 100}
								<div class="absolute top-0 -translate-x-1/2 flex flex-col items-center pointer-events-none" style="left: {scPct}%">
									<div class="w-0.5 h-2.5 bg-white/40 rounded-[1px]"></div>
									<div class="text-7 font-mono text-white/35 mt-px tracking-wider">SC</div>
								</div>
							{/if}
						</div>
						<div class="flex justify-between mt-1.5">
							<span class="text-dim text-3xs font-mono">{formatUsdt(launch.totalBaseRaised, ud)} / {formatUsdt(launch.hardCap, ud)}</span>
						</div>

						<!-- Buy CTA -->
						{#if launch.state === 1}
							<div class="mt-2.5 p-2 rounded-lg text-center font-display text-xs font-bold bg-gradient-to-br from-brand-cyan/10 to-brand-blue/10 text-brand-cyan border border-brand-cyan/20 transition group-hover:from-brand-cyan/20 group-hover:to-brand-blue/20 group-hover:border-brand-cyan/40">Buy Now</div>
						{:else if launch.state === 0}
							<div class="mt-2.5 p-2 rounded-lg text-center font-display text-xs font-bold bg-surface-hover text-muted border border-line">View Launch</div>
						{:else if launch.state === 2}
							<div class="mt-2.5 p-2 rounded-lg text-center font-display text-xs font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">Graduated</div>
						{/if}
					</div>

					<!-- Hover tooltip -->
					{#if hoveredLaunch === launch.address}
						<div class="card-tooltip absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+8px)] bg-surface backdrop-blur-[12px] border border-line rounded-lg px-3.5 py-2.5 min-w-[220px] z-50 shadow-[0_12px_40px_rgba(0,0,0,0.5)] pointer-events-none">
							<div class="flex justify-between items-center py-0.5">
								<span class="text-3xs text-dim font-mono">{$t('lp.softCapLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{formatUsdt(launch.softCap, ud)}</span>
							</div>
							<div class="flex justify-between items-center py-0.5 border-t border-white/[0.04]">
								<span class="text-3xs text-dim font-mono">{$t('lp.hardCapLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{formatUsdt(launch.hardCap, ud)}</span>
							</div>
							<div class="flex justify-between items-center py-0.5 border-t border-white/[0.04]">
								<span class="text-3xs text-dim font-mono">{$t('lp.curveLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{CURVE_TYPES[launch.curveType]}</span>
							</div>
							<div class="flex justify-between items-center py-0.5 border-t border-white/[0.04]">
								<span class="text-3xs text-dim font-mono">{$t('lp.creatorLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{truncateAddr(launch.creator)}</span>
							</div>
							<div class="flex justify-between items-center py-0.5 border-t border-white/[0.04]">
								<span class="text-3xs text-dim font-mono">{$t('lp.tokensForLpLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{lpPercent(launch)}%</span>
							</div>
							<div class="flex justify-between items-center py-0.5 border-t border-white/[0.04]">
								<span class="text-3xs text-dim font-mono">{$t('lp.creatorAllocLabel')}</span>
								<span class="text-3xs text-foreground font-mono font-semibold">{(Number(launch.creatorAllocationBps) / 100).toFixed(1)}%</span>
							</div>
						</div>
					{/if}
				</a>
			{/each}
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="flex items-center justify-center gap-4 mt-6 py-3">
				<button
					class="text-xs font-mono px-4 py-1.5 rounded-lg border border-surface-hover bg-surface text-muted cursor-pointer transition hover:text-brand-cyan hover:border-brand-cyan/30 hover:bg-brand-cyan/5 disabled:opacity-[0.35] disabled:cursor-not-allowed disabled:hover:text-muted disabled:hover:border-surface-hover disabled:hover:bg-surface"
					disabled={currentPage <= 1}
					onclick={() => currentPage = Math.max(1, currentPage - 1)}
				>{$t('lp.previous')}</button>
				<span class="text-xs font-mono text-dim">{pageLabel()}</span>
				<button
					class="text-xs font-mono px-4 py-1.5 rounded-lg border border-surface-hover bg-surface text-muted cursor-pointer transition hover:text-brand-cyan hover:border-brand-cyan/30 hover:bg-brand-cyan/5 disabled:opacity-[0.35] disabled:cursor-not-allowed disabled:hover:text-muted disabled:hover:border-surface-hover disabled:hover:bg-surface"
					disabled={currentPage >= totalPages}
					onclick={() => currentPage = Math.min(totalPages, currentPage + 1)}
				>{$t('lp.next')}</button>
			</div>
		{/if}
	{/if}
	</div>
	<!-- Market Flow sidebar — always present on desktop so skeleton matches loaded layout -->
	<div class="hidden xl:block sticky top-0 h-[calc(100vh-56px)] overflow-hidden">
		<MarketFlow />
	</div>
</div>

<style>
	/* State dot — dynamic class name `state-dot-{color}` can't be safely
	   expressed as a utility since Tailwind can't statically extract the
	   variable. Same for state-text-* and the HOT badge color. */
	.state-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
	.state-dot-cyan { background: #00d2ff; box-shadow: 0 0 6px rgba(0,210,255,0.5); }
	.state-dot-amber { background: #f59e0b; }
	.state-dot-purple { background: #a78bfa; }
	.state-dot-red { background: #f87171; }
	.state-text-cyan { color: #00d2ff; }
	.state-text-amber { color: #f59e0b; }
	.state-text-purple { color: #a78bfa; }
	.state-text-red { color: #f87171; }

	/* Badge pills — dynamic BADGE_META cls values mean these have to stay
	   as concrete classes so Tailwind's extractor + Svelte scoping cooperate. */
	.badge-pill {
		font-size: 9px; font-weight: 600;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.03em;
		padding: 2px 6px; border-radius: 3px; border: 1px solid; white-space: nowrap;
	}
	.badge-list-cyan { background: rgba(0, 210, 255, 0.08); color: #00d2ff; border-color: rgba(0, 210, 255, 0.2); }
	.badge-list-emerald { background: rgba(16, 185, 129, 0.08); color: #34d399; border-color: rgba(16, 185, 129, 0.2); }
	.badge-list-purple { background: rgba(139, 92, 246, 0.08); color: #a78bfa; border-color: rgba(139, 92, 246, 0.2); }
	.badge-list-amber { background: rgba(245, 158, 11, 0.08); color: #fbbf24; border-color: rgba(245, 158, 11, 0.2); }
	.badge-list-blue { background: rgba(59, 130, 246, 0.08); color: #60a5fa; border-color: rgba(59, 130, 246, 0.2); }
	.badge-list-orange { background: rgba(249, 115, 22, 0.08); color: #fb923c; border-color: rgba(249, 115, 22, 0.2); }
	.badge-list-hot { background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: rgba(239, 68, 68, 0.2); }
	.badge-pill-safu { background: rgba(16,185,129,0.15); color: #10b981; font-weight: 800; border-color: rgba(16,185,129,0.3); }
	.badge-pill-kyc { background: rgba(59,130,246,0.12); color: #60a5fa; font-weight: 800; border-color: rgba(59,130,246,0.25); }
	.badge-pill-audited { background: rgba(16,185,129,0.1); color: #34d399; border-color: rgba(16,185,129,0.25); font-weight: 800; }
	.badge-pill-mintable { background: rgba(245,158,11,0.08); color: #fbbf24; border-color: rgba(245,158,11,0.2); }
	.badge-pill-taxable { background: rgba(245,158,11,0.08); color: #f59e0b; border-color: rgba(245,158,11,0.2); }
	.badge-pill-tax-locked { background: rgba(16,185,129,0.08); color: #10b981; border-color: rgba(16,185,129,0.2); }
	.badge-pill-partner { background: rgba(139,92,246,0.08); color: #a78bfa; border-color: rgba(139,92,246,0.2); }

	/* Tooltip arrow pseudo-element — can't be a utility */
	.card-tooltip::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		border: 6px solid transparent;
		border-top-color: var(--bg-surface-hover);
	}

	/* Skeleton pulse animation */
	.skeleton-card { animation: skeletonPulse 1.5s ease-in-out infinite; }
	@keyframes skeletonPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
</style>
