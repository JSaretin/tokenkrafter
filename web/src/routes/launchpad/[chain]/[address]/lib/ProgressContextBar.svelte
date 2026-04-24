<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { formatUsdt, progressPercent, type LaunchInfo } from '$lib/launchpad';

	type Purchase = {
		buyer: string;
		base_amount: string;
		tokens_received: string;
		fee: string;
		price: string;
		created_at: string;
	};

	let {
		launch,
		progress,
		softCapPct,
		tokenProgress = 0,
		countdownNow,
		txItems,
		usdtDecimals,
	}: {
		launch: LaunchInfo;
		progress: number;
		softCapPct: number;
		tokenProgress?: number;
		countdownNow: number;
		txItems: Purchase[];
		usdtDecimals: number;
	} = $props();

	// ── Ghost marker: where raised was ~1h ago ──────────────────────────
	let oneHourAgo = $derived(Date.now() - 3600000);
	let recentBuysUsdt = $derived(
		txItems.reduce((sum, tx) => {
			const ts = typeof tx.created_at === 'number' ? (tx.created_at as number) * 1000 : new Date(tx.created_at).getTime();
			return ts > oneHourAgo
				? sum + parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals))
				: sum;
		}, 0)
	);
	let hardCapNum = $derived(launch && launch.hardCap > 0n ? Number(launch.hardCap) / (10 ** usdtDecimals) : 0);
	let ghostPct = $derived(hardCapNum > 0 ? Math.max(0, progress - (recentBuysUsdt / hardCapNum * 100)) : 0);
	let showGhost = $derived(txItems.length > 0 && launch.hardCap > 0n && ghostPct > 0 && progress - ghostPct > 0.5);

	// ── Context signal derivations ──────────────────────────────────────
	// Scarcity
	let remainingUsdt = $derived(launch.hardCap - launch.totalBaseRaised);
	let remainingNum = $derived(Number(remainingUsdt) / (10 ** usdtDecimals));

	// Pace (elapsed time vs progress)
	let startTs = $derived(launch.startTimestamp > 0n ? Number(launch.startTimestamp) : 0);
	let deadlineTs = $derived(Number(launch.deadline));
	let totalDuration = $derived(deadlineTs - startTs);
	// elapsed uses countdownNow as tick source so the value updates reactively
	let elapsed = $derived(startTs > 0 ? Math.floor(countdownNow / 1000) - startTs : 0);
	let timePct = $derived(totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 0);
	let pace = $derived(timePct > 0 ? progress / timePct : 0);

	// Curve / price impact
	let tokFrac = $derived(launch.tokensForCurve > 0n ? Number(launch.tokensSold) / Number(launch.tokensForCurve) : 0);
	let ct = $derived(Number(launch.curveType));
	let curveFnAt = $derived(
		(x: number) =>
			ct === 0 ? x
			: ct === 1 ? Math.sqrt(x)
			: ct === 2 ? x * x
			: (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1)
	);
	let nextFrac = $derived(Math.min(1, tokFrac + 0.01));
	let curveAtNow = $derived(curveFnAt(tokFrac));
	let curveAtNext = $derived(curveFnAt(nextFrac));
	let impactPct = $derived(curveAtNow > 0 ? ((curveAtNext - curveAtNow) / curveAtNow * 100) : 0);

	// Velocity (raw speed in last hour)
	let oneHrAgo = $derived(countdownNow - 3600000);
	let tenMinAgo = $derived(countdownNow - 600000);
	let hourVol = $derived(
		txItems.reduce((s, tx) => {
			try {
				const ts = typeof tx.created_at === 'number' ? (tx.created_at as number) * 1000 : new Date(tx.created_at).getTime();
				if (isNaN(ts) || ts <= oneHrAgo) return s;
				return s + parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals));
			} catch {
				return s;
			}
		}, 0)
	);
	let recentCount = $derived(
		txItems.filter(tx => {
			try {
				const ts = typeof tx.created_at === 'number' ? (tx.created_at as number) * 1000 : new Date(tx.created_at).getTime();
				return !isNaN(ts) && ts > tenMinAgo;
			} catch {
				return false;
			}
		}).length
	);
</script>

<div class="mb-3">
	<div class="flex justify-between text-xs font-mono mb-1.5">
		<span class="text-gray-300 font-semibold">{formatUsdt(launch.totalBaseRaised, usdtDecimals)}</span>
		<span class="text-gray-500">{formatUsdt(launch.hardCap, usdtDecimals)}</span>
	</div>
	<div class="relative">
		<div class="progress-track h-4 rounded-lg bg-[var(--bg-surface-input)] border border-[var(--border-subtle)]">
			<div class="progress-fill progress-cyan rounded min-w-1 transition-[width] duration-300" style="width: {Math.max(progress > 0 ? 0.5 : 0, progress)}%"></div>
		</div>
		{#if softCapPct > 0 && softCapPct < 100}
			<div class="absolute -top-1 -translate-x-1/2 flex flex-col items-center z-[2]" style="left: {softCapPct}%" title={$t('lpd.softCapTitle') + ': ' + formatUsdt(launch.softCap, usdtDecimals)}>
				<div class="w-0.5 h-6 bg-warning rounded-sm shadow-[0_0_6px_rgba(245,158,11,0.4)]"></div>
				<div class="text-xs4 text-warning font-mono font-bold mt-0.5 bg-[var(--bg)] px-1 rounded-sm border border-warning/30">{$t('lpd.scLabel')}</div>
			</div>
		{/if}
		<!-- Milestone ticks at 25%, 50%, 75% -->
		{#each [25, 50, 75] as pct}
			<div class="absolute top-0 -translate-x-1/2 pointer-events-none z-[1]" style="left: {pct}%" title="{pct}%">
				<div class={"w-px h-4 transition-colors duration-300 " + (progress >= pct ? "bg-cyan/25" : "bg-white/[0.08]")}></div>
			</div>
		{/each}
		<!-- Ghost marker: where it was ~1h ago -->
		{#if showGhost}
			<div class="absolute top-[3px] -translate-x-1/2 w-1.5 h-2.5 rounded-sm bg-white/10 border border-white/[0.08] pointer-events-none z-[1]" style="left: {ghostPct}%" title={$t('lpd.aboutOneHourAgo')}></div>
		{/if}
	</div>
	<div class="flex justify-between text-xs2 font-mono mt-1">
		<span class="text-gray-500">{progress}% {$t('lpd.raised')}</span>
		{#if launch.totalBaseRaised < launch.softCap}
			<span class="text-amber-400">{$t('lpd.softCapLabel')}: {progressPercent(launch.totalBaseRaised, launch.softCap)}%</span>
		{:else}
			<span class="text-emerald-400">{$t('lpd.softCapReached')}</span>
		{/if}
	</div>

	<!-- Context signals under progress bar -->
	{#if launch.state === 1}
		<div class="flex flex-col gap-1 mt-2">
			{#if remainingNum > 0}
				<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-warning bg-warning/[0.05]">
					<svg class="shrink-0 text-warning" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
					<span>{$t('lpd.leftUntilHardCap').replace('{amount}', formatUsdt(remainingUsdt, usdtDecimals))}</span>
				</div>
			{/if}

			<!-- Velocity: raw speed in the last hour -->
			{#if txItems.length > 0 && hourVol > 0}
				<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-warning bg-warning/[0.05]">
					<span>🔥</span>
					<span>{recentCount > 0 ? $t('lpd.hourlyAndRecent').replace('{vol}', hourVol.toFixed(2)).replace('{n}', String(recentCount)).replace('{label}', recentCount > 1 ? $t('lpd.buys') : $t('lpd.buy')) : $t('lpd.hourlyVolume').replace('{vol}', hourVol.toFixed(2))}</span>
				</div>
			{/if}

			{#if timePct > 0 && progress > 0}
				{#if pace > 1.5}
					<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-cyan bg-cyan-400/[0.05]">
						<span>🚀</span>
						<span>{$t('lpd.aheadOfPace').replace('{progress}', progress.toFixed(1)).replace('{time}', timePct.toFixed(0))}</span>
					</div>
				{:else if pace < 0.5 && timePct > 20}
					<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-[var(--text-dim)] bg-white/[0.02]">
						<span>⏳</span>
						<span>{$t('lpd.behindPace').replace('{progress}', progress.toFixed(1)).replace('{time}', (100 - timePct).toFixed(0))}</span>
					</div>
				{/if}
			{/if}

			{#if tokenProgress > 0 && Math.abs(progress - tokenProgress) > 3}
				<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-[var(--text-muted)] bg-white/[0.02]">
					<svg class="shrink-0 text-[var(--text-dim)]" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
					<span>{$t('lpd.tokensVsHardCap').replace('{tokens}', String(tokenProgress)).replace('{raised}', String(progress))}</span>
				</div>
			{/if}

			{#if impactPct > 0.1}
				<div class="flex items-center gap-[5px] font-mono text-xxs py-1 px-2 rounded-md text-success bg-success/[0.05]">
					<svg class="shrink-0 text-success" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
					<span>{$t('lpd.priceImpactNext').replace('{pct}', impactPct.toFixed(1))}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>
