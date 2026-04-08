<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { formatUsdt, progressPercent, stateLabel, stateColor, CURVE_TYPES } from '$lib/launchpad';
	import { chainSlug } from '$lib/structure';
	import { t } from '$lib/i18n';
	import { supabase } from '$lib/supabaseClient';
	import RecentTransactionsTicker from '$lib/RecentTransactionsTicker.svelte';

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
	<title>TokenKrafter - Fair Launch Your Token With Bonding Curves</title>
	<meta name="description" content="Launch your token with bonding curve pricing, soft/hard caps, anti-whale limits, and vesting. Fair, transparent token launches on BSC and more." />
</svelte:head>

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6">
	<!-- Compact Hero -->
	<section class="compact-hero">
		<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
			<div>
				<h1 class="syne text-2xl sm:text-3xl font-bold text-white">
					{$t('home.heroTitle1')} <span class="gradient-text">{$t('home.heroTitle2')}</span>
				</h1>
				<p class="text-gray-400 font-mono text-sm mt-1 max-w-lg">{$t('home.statsTagline')}</p>
			</div>
			<div class="flex gap-3 shrink-0">
				<a href="/create?launch=true" class="btn-primary text-sm px-5 py-2.5 no-underline">
					{$t('home.startLaunch')} →
				</a>
				<a href="/create" class="btn-secondary text-sm px-5 py-2.5 no-underline">
					{$t('home.tokenBasic')}
				</a>
			</div>
		</div>

		<!-- Live Stats Strip -->
		<div class="stats-strip">
			<div class="stat-chip">
				<span class="stat-chip-dot bg-cyan-400"></span>
				<span class="stat-chip-value">{liveLaunches.length}</span>
				<span class="stat-chip-label">Live Now</span>
			</div>
			{#if scheduledLaunches.length > 0}
				<div class="stat-chip">
					<span class="stat-chip-dot bg-amber-400"></span>
					<span class="stat-chip-value">{scheduledLaunches.length}</span>
					<span class="stat-chip-label">Upcoming</span>
				</div>
			{/if}
			<div class="stat-chip">
				<span class="stat-chip-value">{graduatedCount}</span>
				<span class="stat-chip-label">Graduated</span>
			</div>
			<div class="stat-chip">
				<span class="stat-chip-value">{formatUsdt(totalRaised)}</span>
				<span class="stat-chip-label">Total Raised</span>
			</div>
		</div>
	</section>

	<!-- RECENT TRANSACTIONS TICKER — Social proof -->
	<section class="mb-6">
		<RecentTransactionsTicker />
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
			<div class="empty-hero card p-12 text-center">
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
					{@const progress = progressPercent(raised, hardCap)}
					{@const deadline = Number(launch.deadline || 0)}
					{@const hot = isHot(launch)}
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="launch-card card p-0 block no-underline group">
						<!-- Countdown banner -->
						{#if deadline > 0}
							<div class="card-countdown {countdownColor(deadline)}">
								<span class="font-mono text-xs font-bold">{countdownStr(deadline)}</span>
								<div class="flex items-center gap-1.5">
									{#if isNew(launch)}
										<span class="new-badge">NEW</span>
									{/if}
									{#if hot}
										<span class="hot-badge">HOT</span>
									{/if}
								</div>
							</div>
						{/if}

						<div class="p-4 pb-3">
							<div class="flex items-start gap-3">
								{#if launch.logo_url}
									<img src={launch.logo_url} alt="" class="launch-logo card-logo-adapt" />
								{:else}
									<div class="launch-logo launch-logo-placeholder">
										{(launch.token_symbol || '?').charAt(0)}
									</div>
								{/if}
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-cyan-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										{#if launch.is_partner}
											<span class="partner-verified" title="Partner">✓</span>
										{/if}
										<span class="text-gray-600 text-xs font-mono shrink-0">{launch.token_symbol || '???'}</span>
									</div>
									<div class="flex items-center gap-1.5">
										<span class="live-dot"></span>
										<span class="text-xs font-mono text-cyan-400">Active</span>
										<span class="text-gray-600 text-[10px] font-mono ml-auto">{CURVE_TYPES[launch.curve_type] ?? 'Linear'}</span>
									</div>
								</div>
							</div>
						</div>

						{#if launch.description}
							<div class="px-4 pb-2">
								<p class="text-gray-400 text-xs font-mono leading-relaxed line-clamp-2">{launch.description}</p>
							</div>
						{/if}

						<div class="px-4 pb-4">
							<div class="flex justify-between items-baseline mb-1.5">
								<span class="text-white text-xs font-mono font-semibold">{progress}% {$t('home.raised')}</span>
								<span class="text-gray-500 text-[10px] font-mono">{formatUsdt(hardCap, ud)}</span>
							</div>
							<div class="progress-track">
								<div class="progress-fill progress-cyan" style="width: {progress}%"></div>
							</div>
							<div class="flex justify-between mt-1.5">
								<span class="text-gray-600 text-[10px] font-mono">{formatUsdt(raised, ud)} {$t('home.raised')}</span>
							</div>
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

	<!-- Featured Partners -->
	<section class="mb-10">
		<div class="partner-section-header">
			<div class="partner-section-glow"></div>
			<div class="relative flex items-center justify-between p-4 sm:p-5">
				<div class="flex items-center gap-3">
					<div class="partner-section-icon">P</div>
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
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="partner-launch-card card p-0 block no-underline group">
						<!-- Partner accent -->
						<div class="partner-accent"></div>

						<div class="p-4 pb-3">
							<div class="flex items-start gap-3">
								{#if launch.logo_url}
									<img src={launch.logo_url} alt="" class="launch-logo card-logo-adapt" />
								{:else}
									<div class="launch-logo launch-logo-placeholder" style="background: rgba(139,92,246,0.08); color: #a78bfa; border-color: rgba(139,92,246,0.15);">
										{(launch.token_symbol || '?').charAt(0)}
									</div>
								{/if}
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-1.5 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-purple-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										<span class="partner-verified" title="Verified Partner">✓</span>
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
								<span class="partner-pill">Featured</span>
								<span class="partner-pill">Auto DEX</span>
								<span class="partner-pill">Verified</span>
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
			<div class="partner-cta card p-6 text-center">
				<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-500/25 bg-purple-500/10 mb-3">
					<span class="text-purple-400 text-[10px] font-mono uppercase tracking-widest">Partnership Program</span>
				</div>
				<h3 class="syne font-bold text-white mb-2">Launch as a Partner</h3>
				<p class="text-gray-500 font-mono text-xs mb-4 max-w-md mx-auto">
					Get featured here, auto-created DEX pools, verified badge, and priority support. 1% platform fee on trades.
				</p>
				<a href="/create?launch=true" class="btn-partner text-sm px-6 py-2.5 no-underline inline-block">
					Create a Partner Launch →
				</a>
			</div>
		{/if}
	</section>

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
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="upcoming-card-full card p-0 block no-underline group">
						<!-- Countdown banner -->
						<div class="card-countdown-upcoming">
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
								{#if launch.logo_url}
									<img src={launch.logo_url} alt="" class="launch-logo card-logo-adapt" />
								{:else}
									<div class="launch-logo launch-logo-placeholder launch-logo-upcoming">
										{(launch.token_symbol || '?').charAt(0)}
									</div>
								{/if}
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-0.5">
										<span class="syne font-bold text-white text-sm group-hover:text-amber-300 transition truncate">{launch.token_name || 'Unknown'}</span>
										<span class="text-gray-600 text-xs font-mono shrink-0">{launch.token_symbol || '???'}</span>
									</div>
									<div class="flex items-center gap-1.5">
										<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
										<span class="text-xs font-mono text-amber-400">Scheduled</span>
										<span class="text-gray-600 text-[10px] font-mono ml-auto">{CURVE_TYPES[launch.curve_type] ?? 'Linear'}</span>
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
					<a href="/launchpad/{chainSlug(launch.chain_id)}/{launch.address}" class="graduated-card card p-4 block no-underline group">
						<div class="flex items-center gap-3">
							{#if launch.logo_url}
								<img src={launch.logo_url} alt="" class="launch-logo-sm card-logo-adapt" />
							{:else}
								<div class="launch-logo-sm launch-logo-placeholder launch-logo-graduated">
									{(launch.token_symbol || '?').charAt(0)}
								</div>
							{/if}
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

	<!-- Compact CTA Banner -->
	<section class="mb-10">
		<div class="cta-banner card p-6 sm:p-8 flex flex-col sm:flex-row items-center justify-between gap-4">
			<div>
				<h2 class="syne text-xl sm:text-2xl font-bold text-white mb-1">{$t('home.ctaTitle')}</h2>
				<p class="text-gray-400 font-mono text-sm">{$t('home.ctaDesc')}</p>
			</div>
			<div class="flex gap-3 shrink-0">
				<a href="/create?launch=true" class="btn-primary text-sm px-6 py-2.5 no-underline">
					{$t('home.ctaButton')} →
				</a>
				<a href="/create" class="btn-secondary text-sm px-5 py-2.5 no-underline">
					{$t('home.featureTokenCreation')}
				</a>
			</div>
		</div>
	</section>
</div>

<style>
	/* Compact hero */
	.compact-hero {
		padding: 28px 0 20px;
	}

	.gradient-text {
		background: linear-gradient(135deg, #00d2ff, #a78bfa);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	/* Stats strip */
	.stats-strip {
		display: flex;
		gap: 16px;
		margin-top: 16px;
		flex-wrap: wrap;
	}

	.stat-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: 'Space Mono', monospace;
		font-size: 12px;
	}

	.stat-chip-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		animation: pulse 2s ease-in-out infinite;
	}

	.stat-chip-value {
		color: var(--text-heading);
		font-weight: 700;
	}

	.stat-chip-label {
		color: var(--text-muted);
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* Live badge */
	.live-badge {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.live-badge-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #00d2ff;
		box-shadow: 0 0 8px rgba(0, 210, 255, 0.6);
		animation: pulse 2s ease-in-out infinite;
	}

	/* Launch cards */
	.launch-card {
		overflow: hidden;
		transition: all 0.2s ease;
	}
	.launch-card:hover {
		transform: translateY(-3px);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
		border-color: rgba(0, 210, 255, 0.2);
	}

	.card-countdown {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 16px;
		background: var(--bg-surface-hover);
		border-bottom: 1px solid var(--border-subtle);
	}

	.hot-badge, .new-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 999px;
		font-family: 'Syne', sans-serif;
		letter-spacing: 0.05em;
	}
	.hot-badge {
		background: rgba(245, 158, 11, 0.15);
		color: #f59e0b;
	}
	.new-badge {
		background: rgba(0, 210, 255, 0.15);
		color: #00d2ff;
	}

	.launch-logo {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.launch-logo-sm {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.launch-logo-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
		font-size: 14px;
		font-weight: 700;
		font-family: 'Syne', sans-serif;
		border: 1px solid rgba(0, 210, 255, 0.15);
	}

	.launch-logo-graduated {
		background: rgba(16, 185, 129, 0.08);
		color: #10b981;
		border-color: rgba(16, 185, 129, 0.15);
	}

	.launch-logo-upcoming {
		background: rgba(245, 158, 11, 0.08);
		color: #f59e0b;
		border-color: rgba(245, 158, 11, 0.15);
	}

	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #00d2ff;
		box-shadow: 0 0 6px rgba(0, 210, 255, 0.5);
		flex-shrink: 0;
	}

	/* Upcoming cards (full size like active) */
	.upcoming-card-full {
		overflow: hidden;
		transition: all 0.2s ease;
		border-color: rgba(245, 158, 11, 0.1);
	}
	.upcoming-card-full:hover {
		transform: translateY(-3px);
		box-shadow: 0 12px 40px rgba(245, 158, 11, 0.1);
		border-color: rgba(245, 158, 11, 0.25);
	}

	.card-countdown-upcoming {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: rgba(245, 158, 11, 0.06);
		border-bottom: 1px solid rgba(245, 158, 11, 0.1);
	}

	/* Graduated cards */
	.graduated-card {
		transition: all 0.2s ease;
	}
	.graduated-card:hover {
		transform: translateY(-2px);
		border-color: rgba(16, 185, 129, 0.2);
	}

	/* Empty hero */
	.empty-hero {
		background: var(--bg-surface);
		border-style: dashed;
	}

	/* Featured Partners */
	.partner-section-header {
		position: relative;
		background: rgba(139, 92, 246, 0.04);
		border: 1px solid rgba(139, 92, 246, 0.15);
		border-radius: 14px;
		margin-bottom: 16px;
		overflow: hidden;
	}
	.partner-section-glow {
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at 20% 50%, rgba(139, 92, 246, 0.12), transparent 60%);
		pointer-events: none;
	}
	.partner-section-icon {
		width: 36px;
		height: 36px;
		border-radius: 10px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(135deg, #8b5cf6, #a78bfa);
		color: white;
		font-size: 16px;
		font-weight: 800;
		font-family: 'Syne', sans-serif;
		flex-shrink: 0;
	}

	/* partner-scroll kept for backward compat but grid is used now */

	.partner-launch-card {
		overflow: hidden;
		transition: all 0.2s ease;
		border-color: rgba(139, 92, 246, 0.12);
	}
	.partner-launch-card:hover {
		transform: translateY(-3px);
		border-color: rgba(139, 92, 246, 0.3);
		box-shadow: 0 12px 40px rgba(139, 92, 246, 0.12);
	}

	.partner-accent {
		height: 3px;
		background: linear-gradient(90deg, #8b5cf6, #a78bfa, #c4b5fd);
	}

	.partner-avatar {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(139, 92, 246, 0.1);
		color: #a78bfa;
		font-size: 15px;
		font-weight: 700;
		font-family: 'Syne', sans-serif;
		border: 1px solid rgba(139, 92, 246, 0.2);
		flex-shrink: 0;
	}

	.partner-verified {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: #8b5cf6;
		color: white;
		font-size: 8px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.partner-pill {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 9px;
		font-family: 'Space Mono', monospace;
		font-weight: 600;
		color: #c4b5fd;
		background: rgba(139, 92, 246, 0.08);
		border: 1px solid rgba(139, 92, 246, 0.12);
	}

	.partner-cta {
		background: rgba(139, 92, 246, 0.03);
		border-color: rgba(139, 92, 246, 0.12);
		border-style: dashed;
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

	/* CTA banner */
	.cta-banner {
		background: rgba(0, 210, 255, 0.03);
		border-color: rgba(0, 210, 255, 0.12);
	}
</style>
