<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { formatUsdt, progressPercent, stateLabel, stateColor, CURVE_TYPES } from '$lib/launchpad';
	import { chainSlug } from '$lib/structure';
	import { t } from '$lib/i18n';
	import { supabase } from '$lib/supabaseClient';
	import RecentTransactionsTicker from '$lib/RecentTransactionsTicker.svelte';
	import LaunchProgressBar from '$lib/LaunchProgressBar.svelte';
	import LaunchCountdown from '$lib/LaunchCountdown.svelte';
	import TokenLogo from '$lib/TokenLogo.svelte';

	let { data: serverData }: { data: any } = $props();

	let liveLaunches: any[] = $state([]);
	let scheduledLaunches: any[] = $state([]);
	let graduatedLaunches: any[] = $state([]);
	let partnerLaunches: any[] = $state([]);
	let launchesLoading = $state(true);
	let tickNow = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	// Platform stats
	let totalLaunches = $state(0);
	let totalRaised = $state(0n);
	let graduatedCount = $state(0);

	function processLaunches(all: any[]) {
		const nowSec = Math.floor(Date.now() / 1000);
		totalLaunches = all.length;
		graduatedCount = all.filter((r: any) => r.state === 2).length;
		totalRaised = all.reduce((sum: bigint, r: any) => sum + BigInt(r.total_base_raised || '0'), 0n);

		const active = all.filter((r: any) => r.state === 1);
		liveLaunches = active.filter((r: any) => {
			const st = Number(r.start_timestamp || 0);
			return st === 0 || st <= nowSec;
		}).slice(0, 9);

		scheduledLaunches = [
			...active.filter((r: any) => {
				const st = Number(r.start_timestamp || 0);
				return st > 0 && st > nowSec;
			}),
			...all.filter((r: any) => r.state === 0)
		].slice(0, 6);

		graduatedLaunches = all.filter((r: any) => r.state === 2).slice(0, 6);
		partnerLaunches = all.filter((r: any) => r.is_partner && (r.state === 1 || r.state === 2)).slice(0, 8);
	}

	// Supabase Realtime channel
	let channel: any;

	// Process server data immediately (no loading spinner)
	if (serverData?.launches?.length) {
		processLaunches(serverData.launches);
		launchesLoading = false;
	}

	onMount(() => {
		tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);

		// If SSR data was empty, fetch client-side as fallback
		if (!serverData?.launches?.length) {
			supabase
				.from('launches')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(100)
				.then(({ data }) => {
					if (data) processLaunches(data);
					launchesLoading = false;
				});
		}

		// Subscribe to realtime changes
		channel = supabase
			.channel('homepage-launches')
			.on('postgres_changes', {
				event: '*',
				schema: 'public',
				table: 'launches'
			}, () => {
				// Re-fetch all on any change (insert, update, delete)
				supabase
					.from('launches')
					.select('*')
					.order('created_at', { ascending: false })
					.limit(100)
					.then(({ data }) => {
						if (data) processLaunches(data);
					});
			})
			.subscribe();

		return () => { if (tickInterval) clearInterval(tickInterval); };
	});

	onDestroy(() => {
		if (channel) supabase.removeChannel(channel);
	});

	function countdownStr(ts: number): string {
		const ms = ts * 1000 - tickNow;
		if (ms <= 0) return 'Ended';
		const d = Math.floor(ms / 86400000);
		const h = Math.floor((ms % 86400000) / 3600000);
		const m = Math.floor((ms % 3600000) / 60000);
		const s = Math.floor((ms % 60000) / 1000);
		const pad = (n: number) => String(n).padStart(2, '0');
		if (d >= 30) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
		if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
		return `${pad(h)}:${pad(m)}:${pad(s)}`;
	}

	function countdownParts(ts: number): { d: number; h: number; m: number; s: number; ended: boolean } {
		const ms = ts * 1000 - tickNow;
		if (ms <= 0) return { d: 0, h: 0, m: 0, s: 0, ended: true };
		return {
			d: Math.floor(ms / 86400000),
			h: Math.floor((ms % 86400000) / 3600000),
			m: Math.floor((ms % 3600000) / 60000),
			s: Math.floor((ms % 60000) / 1000),
			ended: false,
		};
	}

	function countdownColor(deadline: number): string {
		const ms = deadline * 1000 - tickNow;
		if (ms <= 0) return 'text-gray-500';
		if (ms < 900000) return 'text-red-400'; // <15min
		if (ms < 3600000) return 'text-amber-400'; // <1h
		return 'text-cyan-400';
	}

	function isHot(launch: any): boolean {
		if (launch.state !== 1) return false;
		const raised = BigInt(launch.total_base_raised || '0');
		const hardCap = BigInt(launch.hard_cap || '1');
		return hardCap > 0n && (raised * 100n / hardCap) >= 50n;
	}

	function isNew(launch: any): boolean {
		if (!launch.created_at) return false;
		const created = new Date(launch.created_at).getTime();
		return Date.now() - created < 24 * 60 * 60 * 1000; // <24h
	}
</script>

<svelte:head>
	<title>TokenKrafter - Launch Tokens With On-Chain Enforced Protection</title>
	<meta name="description" content="The only launchpad where tax ceilings are locked, LP is permanently burned, and refunds are guaranteed. Every protection enforced by smart contract on BSC." />
</svelte:head>

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6">
	<!-- Compact Hero -->
	<section class="pt-7 pb-5">
		<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
			<div>
				<h1 class="heading-1">
					{$t('home.heroTitle1')} <span class="gradient-text">{$t('home.heroTitle2')}</span>
				</h1>
				<p class="syne text-gray-400 text-sm font-light mt-1 max-w-xl">{$t('home.statsTagline')}</p>
			</div>
			<div class="flex gap-3 shrink-0">
				<a href="/create" class="btn-primary text-sm px-6 py-2.5 no-underline font-bold">
					Create Token →
				</a>
				<a href="/create?launch=true" class="btn-secondary text-sm px-4 py-2 no-underline opacity-75">
					{$t('home.startLaunch')}
				</a>
			</div>
		</div>

		<!-- Live Stats Strip -->
		<div class="flex gap-4 mt-4 flex-wrap">
			<div class="inline-flex items-center gap-1.5 font-mono text-xs">
				<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-[pulse_2s_ease-in-out_infinite]"></span>
				<span class="text-heading font-bold">{liveLaunches.length}</span>
				<span class="text-muted">Live Now</span>
			</div>
			{#if scheduledLaunches.length > 0}
				<div class="inline-flex items-center gap-1.5 font-mono text-xs">
					<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-[pulse_2s_ease-in-out_infinite]"></span>
					<span class="text-heading font-bold">{scheduledLaunches.length}</span>
					<span class="text-muted">Upcoming</span>
				</div>
			{/if}
			<div class="inline-flex items-center gap-1.5 font-mono text-xs">
				<span class="text-heading font-bold">{graduatedCount}</span>
				<span class="text-muted">Graduated</span>
			</div>
			{#if totalRaised > 100n * (10n ** 18n)}
				<div class="inline-flex items-center gap-1.5 font-mono text-xs">
					<span class="text-heading font-bold">{formatUsdt(totalRaised)}</span>
					<span class="text-muted">Total Raised</span>
				</div>
			{/if}
			<div class="inline-flex items-center gap-1.5 font-mono text-xs">
				<span class="text-heading font-bold">$5</span>
				<span class="text-muted">to create</span>
			</div>
			<div class="inline-flex items-center gap-1.5 font-mono text-xs">
				<span class="text-heading font-bold">60s</span>
				<span class="text-muted">to live</span>
			</div>
		</div>
	</section>

	<!-- Trust Bar — On-chain guarantee badges -->
	<section class="flex items-center justify-center gap-4 sm:gap-4 flex-wrap px-3.5 py-3 sm:px-5 sm:py-3.5 bg-surface border border-line-subtle rounded-xl mb-6">
		<div class="inline-flex items-center gap-2">
			<span class="flex items-center justify-center text-emerald-500">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
			</span>
			<span class="font-mono text-[10px] sm:text-[11px] font-bold text-foreground tracking-wide">Tax Ceiling Enforced</span>
		</div>
		<div class="w-px h-4 bg-line-subtle shrink-0 hidden sm:block"></div>
		<div class="inline-flex items-center gap-2">
			<span class="flex items-center justify-center text-amber-500">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-5"/></svg>
			</span>
			<span class="font-mono text-[10px] sm:text-[11px] font-bold text-foreground tracking-wide">100% LP Burned</span>
		</div>
		<div class="w-px h-4 bg-line-subtle shrink-0 hidden sm:block"></div>
		<div class="inline-flex items-center gap-2">
			<span class="flex items-center justify-center text-cyan-400">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/></svg>
			</span>
			<span class="font-mono text-[10px] sm:text-[11px] font-bold text-foreground tracking-wide">On-Chain Refunds</span>
		</div>
		<div class="w-px h-4 bg-line-subtle shrink-0 hidden sm:block"></div>
		<div class="inline-flex items-center gap-2">
			<span class="flex items-center justify-center text-violet-400">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
			</span>
			<span class="font-mono text-[10px] sm:text-[11px] font-bold text-foreground tracking-wide">Creator Vesting Lock</span>
		</div>
	</section>

	<!-- RECENT TRANSACTIONS TICKER — Social proof -->
	<section class="mb-6">
		<RecentTransactionsTicker />
	</section>

	<!-- HOW IT WORKS — 3-step explainer for cold traffic -->
	<section class="mb-10">
		<h2 class="syne text-lg font-bold text-white mb-1">{$t('home.howItWorksTitle')}</h2>
		<p class="text-gray-500 font-mono text-xs mb-5">{$t('home.howItWorksSub')}</p>
		<div class="flex flex-col sm:flex-row items-stretch bg-surface border border-line rounded-2xl overflow-hidden">
			<div class="flex-1 flex flex-row sm:flex-col items-center gap-3.5 sm:gap-2.5 p-4 sm:p-5 sm:px-4 text-left sm:text-center">
				<div class="relative w-13 h-13 rounded-full flex items-center justify-center shrink-0 bg-cyan-400/10 text-cyan-400 border border-cyan-400/25" style="width:52px;height:52px">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
					<span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-[5px] rounded-[9px] inline-flex items-center justify-center syne text-[10px] font-extrabold bg-background border border-current">1</span>
				</div>
				<div class="flex-1">
					<h3 class="syne text-sm font-bold text-heading m-0 mb-1">{$t('home.step1Label')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.step1Desc')}</p>
				</div>
			</div>
			<div class="w-0.5 h-5 sm:w-6 sm:h-0.5 shrink-0 self-center opacity-40" style="background: repeating-linear-gradient(var(--dash-dir, 90deg), var(--text-dim) 0, var(--text-dim) 4px, transparent 4px, transparent 8px);"></div>
			<div class="flex-1 flex flex-row sm:flex-col items-center gap-3.5 sm:gap-2.5 p-4 sm:p-5 sm:px-4 text-left sm:text-center">
				<div class="relative w-13 h-13 rounded-full flex items-center justify-center shrink-0 bg-amber-500/10 text-amber-500 border border-amber-500/25" style="width:52px;height:52px">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
					<span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-[5px] rounded-[9px] inline-flex items-center justify-center syne text-[10px] font-extrabold bg-background border border-current">2</span>
				</div>
				<div class="flex-1">
					<h3 class="syne text-sm font-bold text-heading m-0 mb-1">{$t('home.step2Label')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.step2Desc')}</p>
				</div>
			</div>
			<div class="w-0.5 h-5 sm:w-6 sm:h-0.5 shrink-0 self-center opacity-40" style="background: repeating-linear-gradient(var(--dash-dir, 90deg), var(--text-dim) 0, var(--text-dim) 4px, transparent 4px, transparent 8px);"></div>
			<div class="flex-1 flex flex-row sm:flex-col items-center gap-3.5 sm:gap-2.5 p-4 sm:p-5 sm:px-4 text-left sm:text-center">
				<div class="relative w-13 h-13 rounded-full flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-500 border border-emerald-500/25" style="width:52px;height:52px">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
					<span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-[5px] rounded-[9px] inline-flex items-center justify-center syne text-[10px] font-extrabold bg-background border border-current">3</span>
				</div>
				<div class="flex-1">
					<h3 class="syne text-sm font-bold text-heading m-0 mb-1">{$t('home.step3Label')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.step3Desc')}</p>
				</div>
			</div>
		</div>
	</section>

	<!-- LIVE LAUNCHES — The main content -->
	<section class="mb-10">
		<div class="flex items-center justify-between mb-5">
			<div class="flex items-center gap-3">
				<div class="live-badge">
					<span class="live-badge-dot"></span>
					<span class="syne font-bold text-sm text-white">{$t('home.activeLaunches')}</span>
				</div>
			</div>
			<a href="/launchpad" class="text-cyan-400 text-xs font-mono hover:underline no-underline">
				{$t('home.viewAllLaunches')} →
			</a>
		</div>

		{#if launchesLoading}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each Array(6) as _}
					<div class="card p-5">
						<div class="flex items-start gap-3 mb-4">
							<div class="skeleton-line w-10 h-10 rounded-full"></div>
							<div class="flex-1">
								<div class="skeleton-line w-28 h-4 mb-2"></div>
								<div class="skeleton-line w-20 h-3"></div>
							</div>
						</div>
						<div class="skeleton-line w-full h-2 rounded-full mb-3"></div>
						<div class="flex justify-between">
							<div class="skeleton-line w-16 h-3"></div>
							<div class="skeleton-line w-20 h-3"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if liveLaunches.length === 0}
			<div class="card p-12 text-center bg-surface border-dashed">
				<div class="text-5xl mb-4 opacity-15">~</div>
				<h3 class="syne text-lg font-bold text-white mb-2">{$t('home.noActiveLaunches')}</h3>
				<p class="text-gray-500 font-mono text-sm mb-6 max-w-sm mx-auto">{$t('home.activeLaunchesSub')}</p>
				<a href="/create?launch=true" class="btn-primary text-sm px-6 py-3 no-underline inline-block">
					{$t('home.beFirst')} →
				</a>
			</div>
		{:else}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each liveLaunches as launch}
					{@const ud = launch.usdt_decimals ?? 18}
					{@const raised = BigInt(launch.total_base_raised || '0')}
					{@const hardCap = BigInt(launch.hard_cap || '0')}
					{@const softCap = BigInt(launch.soft_cap || '0')}
					{@const progress = progressPercent(raised, hardCap)}
					{@const scPct = hardCap > 0n ? Math.min(100, Number((softCap * 100n) / hardCap)) : 0}
					{@const deadline = Number(launch.deadline || 0)}
					{@const hot = isHot(launch)}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="card p-0 block no-underline group overflow-hidden transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[0_12px_40px_rgba(0,0,0,0.25)] hover:border-cyan-400/20">
						<!-- Header: badges -->
						{#if isNew(launch) || hot || launch.is_partner}
							<div class="flex items-center gap-1 px-3 py-1.5 border-b border-line-subtle">
								{#if isNew(launch)}<span class="inline-flex items-center gap-[3px] text-[10px] font-bold py-0.5 px-2 rounded-full syne tracking-wider bg-cyan-400/15 text-cyan-400">NEW</span>{/if}
								{#if hot}<span class="inline-flex items-center gap-[3px] text-[10px] font-bold py-0.5 px-2 rounded-full syne tracking-wider bg-amber-500/15 text-amber-500">HOT</span>{/if}
								{#if launch.is_partner}<span class="inline-flex items-center py-px px-1.5 rounded-full text-[9px] font-bold font-mono tracking-wider bg-violet-500/[0.12] text-violet-400 border border-violet-500/20">Partner</span>{/if}
							</div>
						{/if}

						<!-- Identity -->
						<div class="p-4 pb-3">
							<div class="flex items-start gap-3">
								<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={40} />
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-cyan-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										<span class="text-gray-600 text-xs font-mono shrink-0">{launch.token_symbol || '???'}</span>
									</div>
									<div class="flex items-center gap-1.5 flex-wrap">
										<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(0,210,255,0.5)] shrink-0"></span>
										<span class="text-xs font-mono text-cyan-400">Active</span>
										<span class="text-gray-600 text-[10px] font-mono ml-auto" title="Bonding curve: {CURVE_TYPES[launch.curve_type] ?? 'Linear'}">{CURVE_TYPES[launch.curve_type] ?? 'Linear'}</span>
									</div>
								</div>
							</div>
						</div>

						{#if launch.description}
							<div class="px-4 pb-2">
								<p class="text-gray-400 text-xs font-mono leading-relaxed line-clamp-2">{launch.description}</p>
							</div>
						{/if}

						<!-- Countdown -->
						{#if deadline > 0}
							<div class="px-4 pb-2.5">
								<LaunchCountdown deadline={deadline} size="sm" />
							</div>
						{/if}

						<!-- Progress -->
						<div class="px-4 pt-3.5 pb-4 border-t border-line-subtle">
							<LaunchProgressBar
								{progress}
								softCapPct={scPct}
								raised={formatUsdt(raised, ud)}
								hardCap={formatUsdt(hardCap, ud)}
								size="md"
							/>
						</div>
					</a>
				{/each}
			</div>

			{#if liveLaunches.length >= 9}
				<div class="text-center mt-6">
					<a href="/launchpad" class="btn-secondary text-sm px-6 py-2.5 no-underline inline-block">
						{$t('home.exploreAllLaunches')} →
					</a>
				</div>
			{/if}
		{/if}
	</section>

	<!-- Featured Partners (hidden entirely when empty — the dashed empty
	     CTA looked like a placeholder bug, not an invitation) -->
	{#if partnerLaunches.length > 0}
	<section class="mb-10">
		<div class="relative bg-violet-500/[0.04] border border-violet-500/15 rounded-2xl mb-4 overflow-hidden">
			<div class="absolute inset-0 pointer-events-none" style="background: radial-gradient(ellipse at 20% 50%, rgba(139, 92, 246, 0.12), transparent 60%);"></div>
			<div class="relative flex items-center justify-between p-4 sm:p-5">
				<div class="flex items-center gap-3">
					<div class="w-9 h-9 rounded-[10px] flex items-center justify-center text-white text-base font-extrabold syne shrink-0" style="background: linear-gradient(135deg, #8b5cf6, #a78bfa);">P</div>
					<div>
						<span class="syne font-bold text-base text-white">Featured Partners</span>
						<p class="text-gray-500 text-[10px] font-mono mt-0.5">Verified projects with premium platform benefits</p>
					</div>
				</div>
				<a href="/create" class="btn-partner text-xs px-4 py-2 no-underline shrink-0">
					Become a Partner →
				</a>
			</div>
		</div>

		{#if partnerLaunches.length > 0}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each partnerLaunches as launch}
					{@const ud = launch.usdt_decimals ?? 18}
					{@const raised = BigInt(launch.total_base_raised || '0')}
					{@const hardCap = BigInt(launch.hard_cap || '0')}
					{@const progress = progressPercent(raised, hardCap)}
					{@const deadline = Number(launch.deadline || 0)}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="card p-0 block no-underline group overflow-hidden transition-all duration-200 border-violet-500/[0.12] hover:-translate-y-[3px] hover:border-violet-500/30 hover:shadow-[0_12px_40px_rgba(139,92,246,0.12)]">
						<!-- Partner accent -->
						<div class="h-[3px]" style="background: linear-gradient(90deg, #8b5cf6, #a78bfa, #c4b5fd);"></div>

						<div class="p-4 pb-3">
							<div class="flex items-start gap-3">
								<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={40} />
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-1.5 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-purple-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										<span class="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full bg-violet-500 text-white text-[8px] font-bold shrink-0" title="Verified Partner">✓</span>
										<span class="text-gray-600 text-xs font-mono shrink-0">{launch.token_symbol || '???'}</span>
									</div>
									<div class="flex items-center gap-1.5">
										{#if launch.state === 1}
											<span class="live-dot" style="background: #a78bfa; box-shadow: 0 0 6px rgba(139,92,246,0.5);"></span>
											<span class="text-xs font-mono text-purple-400">Partner Launch</span>
										{:else}
											<span class="text-xs font-mono text-emerald-400">Graduated</span>
										{/if}
										{#if deadline > 0 && launch.state === 1}
											<span class="text-gray-600 text-[10px] font-mono ml-auto">{countdownStr(deadline)}</span>
										{/if}
									</div>
								</div>
							</div>
						</div>

						<div class="px-4 pb-3">
							<!-- Partner benefits -->
							<div class="flex flex-wrap gap-1.5 mb-3">
								<span class="inline-block py-0.5 px-2 rounded-full text-[9px] font-mono font-semibold text-violet-300 bg-violet-500/[0.08] border border-violet-500/[0.12]">Featured</span>
								<span class="inline-block py-0.5 px-2 rounded-full text-[9px] font-mono font-semibold text-violet-300 bg-violet-500/[0.08] border border-violet-500/[0.12]">Auto DEX</span>
								<span class="inline-block py-0.5 px-2 rounded-full text-[9px] font-mono font-semibold text-violet-300 bg-violet-500/[0.08] border border-violet-500/[0.12]">Verified</span>
							</div>

							<div class="flex justify-between items-baseline mb-1.5">
								<span class="text-white text-xs font-mono font-semibold">{progress}% raised</span>
								<span class="text-gray-500 text-[10px] font-mono">{formatUsdt(hardCap, ud)}</span>
							</div>
							<div class="progress-track">
								<div class="progress-fill" style="width: {progress}%; background: linear-gradient(90deg, #8b5cf6, #a78bfa);"></div>
							</div>
							<div class="flex justify-between mt-1.5">
								<span class="text-gray-600 text-[10px] font-mono">{formatUsdt(raised, ud)} raised</span>
								<span class="text-gray-600 text-[10px] font-mono">{CURVE_TYPES[launch.curve_type] ?? 'Linear'}</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="card p-6 text-center bg-violet-500/[0.03] border-violet-500/[0.12] border-dashed">
				<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-500/25 bg-purple-500/10 mb-3">
					<span class="text-purple-400 text-[10px] font-mono uppercase tracking-widest">Partnership Program</span>
				</div>
				<h3 class="syne font-bold text-white mb-2">Launch as a Partner</h3>
				<p class="text-gray-500 font-mono text-xs mb-4 max-w-md mx-auto">
					Get featured here, auto-created DEX pools, verified badge, and priority support. 0.5% platform fee on trades.
				</p>
				<a href="/create?launch=true" class="btn-partner text-sm px-6 py-2.5 no-underline inline-block">
					Create a Partner Launch →
				</a>
			</div>
		{/if}
	</section>
	{/if}

	<!-- Upcoming / Scheduled Launches -->
	{#if scheduledLaunches.length > 0}
		<section class="mb-10">
			<div class="flex items-center justify-between mb-5">
				<div class="flex items-center gap-2">
					<span class="w-2 h-2 rounded-full bg-amber-400"></span>
					<span class="syne font-bold text-sm text-white">Upcoming Launches</span>
				</div>
				<a href="/launchpad" class="text-cyan-400 text-xs font-mono hover:underline no-underline">
					{$t('home.viewAllLaunches')} →
				</a>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each scheduledLaunches as launch}
					{@const ud = launch.usdt_decimals ?? 18}
					{@const hardCap = BigInt(launch.hard_cap || '0')}
					{@const softCap = BigInt(launch.soft_cap || '0')}
					{@const startTs = Number(launch.start_timestamp || 0)}
					{@const isPending = launch.state === 0}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="card p-0 block no-underline group overflow-hidden transition-all duration-200 border-amber-500/10 hover:-translate-y-[3px] hover:border-amber-500/25 hover:shadow-[0_12px_40px_rgba(245,158,11,0.1)]">
						<!-- Countdown banner -->
						<div class="flex items-center justify-between px-4 py-2 bg-amber-500/[0.06] border-b border-amber-500/10">
							{#if isPending}
								<span class="font-mono text-xs font-bold text-gray-400">Awaiting Deposit</span>
								<span class="badge-amber text-[10px] px-2 py-0.5 rounded-full">Pending</span>
							{:else if startTs > 0}
								<span class="font-mono text-xs text-amber-400">Starts in</span>
								<span class="font-mono text-xs font-bold text-amber-300">{countdownStr(startTs)}</span>
							{/if}
						</div>

						<div class="p-4 pb-3">
							<div class="flex items-start gap-3">
								<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={40} />
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-amber-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										<span class="text-gray-600 text-xs font-mono shrink-0">{launch.token_symbol || '???'}</span>
									</div>
									<div class="flex items-center gap-1.5">
										<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
										<span class="text-xs font-mono text-amber-400">Scheduled</span>
										<span class="text-gray-600 text-[10px] font-mono ml-auto" title="Bonding curve: {CURVE_TYPES[launch.curve_type] ?? 'Linear'}">{CURVE_TYPES[launch.curve_type] ?? 'Linear'}</span>
									</div>
								</div>
							</div>
						</div>

						<div class="px-4 pb-4">
							<div class="flex justify-between items-baseline mb-1.5">
								<span class="text-gray-400 text-xs font-mono">Soft Cap</span>
								<span class="text-gray-500 text-[10px] font-mono">{formatUsdt(softCap, ud)}</span>
							</div>
							<div class="flex justify-between items-baseline">
								<span class="text-gray-400 text-xs font-mono">Hard Cap</span>
								<span class="text-white text-[10px] font-mono font-semibold">{formatUsdt(hardCap, ud)}</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Recently Graduated -->
	{#if graduatedLaunches.length > 0}
		<section class="mb-10">
			<div class="flex items-center justify-between mb-5">
				<div class="flex items-center gap-2">
					<span class="w-2 h-2 rounded-full bg-emerald-400"></span>
					<span class="syne font-bold text-sm text-white">Recently Graduated</span>
				</div>
				<a href="/launchpad" class="text-cyan-400 text-xs font-mono hover:underline no-underline">
					{$t('home.viewAllLaunches')} →
				</a>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each graduatedLaunches as launch}
					{@const ud = launch.usdt_decimals ?? 18}
					{@const raised = BigInt(launch.total_base_raised || '0')}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="card p-4 block no-underline group transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-500/20">
						<div class="flex items-center gap-3">
							<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={32} />
							<div class="flex-1 min-w-0">
								<span class="syne font-bold text-white text-sm group-hover:text-emerald-300 transition truncate block">{launch.token_name || 'Unknown'}</span>
								<span class="text-gray-500 text-xs font-mono">{launch.token_symbol} · {formatUsdt(raised, ud)} {$t('home.raised')}</span>
							</div>
							<span class="badge-emerald text-[10px] px-2 py-0.5 rounded-full">{$t('lp.graduated')}</span>
						</div>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- WHY TOKENKRAFTER — What the smart contracts enforce -->
	<section class="mb-10">
		<h2 class="syne text-lg font-bold text-white mb-1">{$t('home.featuresTitle')}</h2>
		<p class="text-gray-500 font-mono text-xs mb-6">{$t('home.featuresSub')}</p>

		<!-- Investor Protection -->
		<div class="mb-5 last:mb-0">
			<div class="flex items-center gap-2 mb-2.5">
				<span class="w-2 h-2 rounded-full shrink-0 bg-emerald-500"></span>
				<span class="font-mono text-[11px] font-bold text-muted uppercase tracking-wider">Investor Protection</span>
			</div>
			<div class="grid grid-cols-1 min-[481px]:grid-cols-2 md:grid-cols-3 gap-3">
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box emerald">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureTaxCeiling')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureTaxCeilingDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box emerald">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-5"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureLpBurn')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureLpBurnDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box emerald">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureRefunds')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureRefundsDesc')}</p>
				</div>
			</div>
		</div>

		<!-- Anti-Abuse -->
		<div class="mb-5 last:mb-0">
			<div class="flex items-center gap-2 mb-2.5">
				<span class="w-2 h-2 rounded-full shrink-0 bg-amber-500"></span>
				<span class="font-mono text-[11px] font-bold text-muted uppercase tracking-wider">Anti-Abuse</span>
			</div>
			<div class="grid grid-cols-1 min-[481px]:grid-cols-2 md:grid-cols-3 gap-3">
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box amber">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureAntiSnipe')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureAntiSnipeDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box amber">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureAntiWhale')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureAntiWhaleDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box amber">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureRelaxOnly')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureRelaxOnlyDesc')}</p>
				</div>
			</div>
		</div>

		<!-- Liquidity & Creator Controls -->
		<div class="mb-5 last:mb-0">
			<div class="flex items-center gap-2 mb-2.5">
				<span class="w-2 h-2 rounded-full shrink-0 bg-cyan-400"></span>
				<span class="font-mono text-[11px] font-bold text-muted uppercase tracking-wider">Liquidity & Creator Controls</span>
			</div>
			<div class="grid grid-cols-1 min-[481px]:grid-cols-2 md:grid-cols-3 gap-3">
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box cyan">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureVesting')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureVestingDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box cyan">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featurePayAny')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featurePayAnyDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box cyan">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureSafuLens')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureSafuLensDesc')}</p>
				</div>
			</div>
		</div>

		<!-- Platform Guarantees -->
		<div class="mb-5 last:mb-0">
			<div class="flex items-center gap-2 mb-2.5">
				<span class="w-2 h-2 rounded-full shrink-0 bg-violet-400"></span>
				<span class="font-mono text-[11px] font-bold text-muted uppercase tracking-wider">Platform Guarantees</span>
			</div>
			<div class="grid grid-cols-1 min-[481px]:grid-cols-2 md:grid-cols-3 gap-3">
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box purple">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureEscrow')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureEscrowDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box purple">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featureAffiliate')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featureAffiliateDesc')}</p>
				</div>
				<div class="flex flex-col gap-2 p-[18px] rounded-xl bg-surface border border-line-subtle transition-colors duration-150 hover:border-cyan-400/15">
					<div class="feature-icon-box purple">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
					</div>
					<h3 class="syne text-[13px] font-bold text-heading m-0">{$t('home.featurePlatformRescue')}</h3>
					<p class="font-mono text-[10px] text-dim leading-relaxed m-0">{$t('home.featurePlatformRescueDesc')}</p>
				</div>
			</div>
		</div>
	</section>

	<!-- AFFILIATE CTA — dedicated banner for the referral program -->
	<section class="mb-10">
		<div class="card p-6 sm:p-8 bg-emerald-500/[0.03] border-emerald-500/15">
			<div class="flex items-center justify-between gap-5 flex-wrap max-sm:flex-col max-sm:items-stretch max-sm:text-center">
				<div class="flex-1 min-w-[240px]">
					<div class="flex items-center gap-2 mb-2 max-sm:justify-center">
						<span class="flex items-center justify-center text-emerald-500">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
						</span>
						<span class="syne text-xs font-bold text-emerald-400 uppercase tracking-wider">Affiliate Program</span>
					</div>
					<h2 class="syne text-xl sm:text-2xl font-bold text-white mb-2">Earn 25% of all platform fees. For life.</h2>
					<p class="text-gray-400 font-mono text-sm mb-2">Share your link. Earn on every action your referrals take — no cap, no expiry. Paid in USDT.</p>
					<div class="flex items-center gap-2 flex-wrap mt-2 max-sm:justify-center">
						<span class="font-mono text-[11px] text-dim">
							<span class="font-bold text-emerald-500">25%</span>
							Token Creation Fees
						</span>
						<span class="text-dim text-[11px]">·</span>
						<span class="font-mono text-[11px] text-dim">
							<span class="font-bold text-emerald-500">25%</span>
							Launch Buy Fees
						</span>
						<span class="text-dim text-[11px]">·</span>
						<span class="font-mono text-[11px] text-dim">
							<span class="font-bold text-emerald-500">25%</span>
							Off-Ramp Fees
						</span>
					</div>
				</div>
				<div class="flex gap-2.5 shrink-0 flex-wrap max-sm:justify-center">
					<a href="/affiliate" class="btn-affiliate text-sm px-6 py-3 no-underline font-bold">
						Start Earning →
					</a>
				</div>
			</div>
		</div>
	</section>

	<!-- BOTTOM CTA — Specific, with pricing, for users who scrolled through everything -->
	<section class="mb-10">
		<div class="card p-6 sm:p-8 bg-cyan-400/[0.03] border-cyan-400/[0.12]">
			<div class="flex items-center justify-between gap-5 flex-wrap max-sm:flex-col max-sm:items-stretch max-sm:text-center">
				<div class="flex-1 min-w-[240px]">
					<h2 class="syne text-xl sm:text-2xl font-bold text-white mb-2">Your token can be live in 60 seconds</h2>
					<p class="text-gray-400 font-mono text-sm mb-1">No coding. No MetaMask required. Just connect with Google and launch.</p>
					<p class="text-gray-600 font-mono text-xs">Token creation from $5 · Tax ceiling locked at launch · LP permanently burned</p>
				</div>
				<div class="flex gap-2.5 shrink-0 flex-wrap max-sm:justify-center">
					<a href="/create?launch=true" class="btn-primary text-base px-8 py-3.5 no-underline font-bold">
						Launch with Bonding Curve →
					</a>
					<a href="/create" class="btn-secondary text-sm px-5 py-2.5 no-underline opacity-75">
						Create Token Only
					</a>
				</div>
			</div>
		</div>
	</section>
</div>

<style>
	.gradient-text {
		background: linear-gradient(135deg, #00d2ff, #a78bfa);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.btn-partner {
		background: linear-gradient(135deg, #8b5cf6, #a78bfa);
		color: var(--text-heading);
		font-weight: 700;
		border-radius: 10px;
		border: none;
		cursor: pointer;
		transition: all 0.2s;
		font-family: 'Syne', sans-serif;
	}
	.btn-partner:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 28px rgba(139, 92, 246, 0.35);
	}

	.btn-affiliate {
		background: linear-gradient(135deg, #10b981, #059669);
		color: white; font-family: 'Syne', sans-serif;
		border-radius: 10px; border: none; cursor: pointer;
		transition: all 0.2s;
	}
	.btn-affiliate:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 28px rgba(16, 185, 129, 0.35);
	}
</style>
