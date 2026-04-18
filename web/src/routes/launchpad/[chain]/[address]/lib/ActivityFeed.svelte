<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { formatUsdt, type LaunchInfo } from '$lib/launchpad';
	import type { SupportedNetwork } from '$lib/structure';
	import ActivityRow from './ActivityRow.svelte';
	import ActivitySignalPill from './ActivitySignalPill.svelte';

	type Purchase = {
		buyer: string;
		base_amount: string;
		tokens_received: string;
		fee: string;
		price: string;
		created_at: string;
	};

	let {
		txItems,
		txLoading,
		isLoadingMore,
		txShowMore,
		txTotal,
		userAddress,
		userBasePaid,
		userTokensBought,
		tokenSymbol,
		tokenDecimals,
		usdtDecimals,
		launch,
		network,
		onLoadMore,
		onConnectWallet,
	}: {
		txItems: Purchase[];
		txLoading: boolean;
		isLoadingMore: boolean;
		txShowMore: boolean;
		txTotal: number;
		userAddress: string | null;
		userBasePaid: bigint;
		userTokensBought: bigint;
		tokenSymbol: string;
		tokenDecimals: number;
		usdtDecimals: number;
		launch: LaunchInfo;
		network: SupportedNetwork | null;
		onLoadMore: () => Promise<void> | void;
		onConnectWallet?: () => void;
	} = $props();

	// ── Stats derived from txItems ──────────────────────────────────────
	let totalBuyers = $derived(new Set(txItems.map(t => t.buyer)).size);
	let totalVol = $derived(
		txItems.reduce(
			(sum, t) => sum + parseFloat(ethers.formatUnits(BigInt(t.base_amount) + BigInt(t.fee || '0'), usdtDecimals)),
			0
		)
	);
	let recentBuys = $derived(
		txItems.filter(t => {
			const ts = typeof t.created_at === 'number' ? (t.created_at as number) * 1000 : new Date(t.created_at).getTime();
			return Date.now() - ts < 300000;
		}).length
	);
	let remainingUsdt = $derived(launch ? launch.hardCap - launch.totalBaseRaised : 0n);
	let remainingUsdtNum = $derived(Number(remainingUsdt) / (10 ** usdtDecimals));

	// ── Gain signal ─────────────────────────────────────────────────────
	let userAvg = $derived(userTokensBought > 0n ? Number(userBasePaid) / Number(userTokensBought) : 0);
	let currentP = $derived(launch ? Number(launch.currentPrice) / (10 ** usdtDecimals) : 0);
	let gain = $derived(userAvg > 0 && currentP > userAvg ? ((currentP - userAvg) / userAvg * 100) : 0);
	let showGainSignal = $derived(userBasePaid > 0n && launch && launch.currentPrice > 0n && currentP > userAvg);

	// ── Row-level shared derivations ────────────────────────────────────
	let firstBuyerAddr = $derived(txItems.length > 0 ? txItems[txItems.length - 1].buyer : '');
	let curPriceForCtx = $derived(launch ? Number(launch.currentPrice) / (10 ** usdtDecimals) : 0);
	let buyerCounts = $derived(
		txItems.reduce((m, tx) => {
			m[tx.buyer] = (m[tx.buyer] || 0) + 1;
			return m;
		}, {} as Record<string, number>)
	);
	let softCapNum = $derived(launch ? Number(launch.softCap) / (10 ** usdtDecimals) : 0);
	let hardCapNum2 = $derived(launch ? Number(launch.hardCap) / (10 ** usdtDecimals) : 0);
	let hardCapVal = $derived(launch ? Number(launch.hardCap) / (10 ** usdtDecimals) : 0);

	// Format total volume for summary bar
	let totalVolLabel = $derived(totalVol >= 1000 ? (totalVol / 1000).toFixed(1) + 'K' : totalVol.toFixed(0));

	// Milestone helpers — precompute cumulative raised per row so markup stays clean
	function milestoneFor(i: number) {
		if (i >= txItems.length - 1) return null;
		const raisedIncluding = txItems.slice(i).reduce(
			(s, t) => s + parseFloat(ethers.formatUnits(BigInt(t.base_amount), usdtDecimals)),
			0
		);
		const raisedBefore = txItems.slice(i + 1).reduce(
			(s, t) => s + parseFloat(ethers.formatUnits(BigInt(t.base_amount), usdtDecimals)),
			0
		);
		return { raisedIncluding, raisedBefore, buyNumber: txItems.length - i };
	}
</script>

<div class="card p-6 mb-4">
	<div class="flex items-center justify-between mb-4">
		<h3 class="syne font-bold text-white">{$t('lpd.recentActivity')}</h3>
		{#if launch.state === 1}
			<span class="flex items-center gap-[5px] font-mono text-xxs font-bold text-success uppercase tracking-widest">
				<span class="w-[7px] h-[7px] rounded-full bg-success shadow-[0_0_8px_rgba(16,185,129,0.6)] animate-pulse-glow"></span>{$t('lpd.live')}
			</span>
		{/if}
	</div>
	{#if txLoading}
		<div class="text-gray-500 text-xs font-mono text-center py-4">{$t('status.loading')}...</div>
	{:else if txItems.length === 0}
		<div class="text-center py-7 px-4">
			<div class="w-12 h-12 rounded-full mx-auto mb-2.5 bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-dim)] opacity-50">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
			</div>
			<p class="syne text-sm2 font-bold text-[var(--text-muted)] mb-1">{$t('lpd.noBuysYet')}</p>
			<span class="font-mono text-xs2 text-[var(--text-dim)]">{$t('lpd.beFirstHint')}</span>
		</div>
	{:else}
		<!-- Live stats -->
		<div class="flex items-center justify-center gap-4 pt-2.5 pb-3.5 mb-1 border-b border-[var(--border-subtle)]">
			<div class="flex flex-col items-center gap-px">
				<span class="syne text-base font-extrabold text-[var(--text-heading)]">{txTotal}</span>
				<span class="rajdhani text-xs2 text-[var(--text-muted)] uppercase tracking-wide">{$t('lpd.statBuys')}</span>
			</div>
			<div class="w-px h-6 bg-[var(--border-subtle)]"></div>
			<div class="flex flex-col items-center gap-px">
				<span class="syne text-base font-extrabold text-[var(--text-heading)]">{totalBuyers}</span>
				<span class="rajdhani text-xs2 text-[var(--text-muted)] uppercase tracking-wide">{$t('lpd.statBuyers')}</span>
			</div>
			<div class="w-px h-6 bg-[var(--border-subtle)]"></div>
			<div class="flex flex-col items-center gap-px">
				<span class="syne text-base font-extrabold text-[var(--text-heading)]">${totalVolLabel}</span>
				<span class="rajdhani text-xs2 text-[var(--text-muted)] uppercase tracking-wide">{$t('lpd.statVolume')}</span>
			</div>
		</div>

		<!-- Momentum + scarcity signals -->
		<div class="flex flex-col gap-1.5 py-2.5">
			{#if recentBuys > 0}
				<ActivitySignalPill variant="cyan" dot>
					{$t('lpd.recentBuysSignal').replace('{n}', String(recentBuys)).replace('{label}', recentBuys === 1 ? $t('lpd.buy') : $t('lpd.buys'))}
				</ActivitySignalPill>
			{/if}
			{#if remainingUsdt > 0n && remainingUsdtNum < 500}
				<ActivitySignalPill variant="warning">
					<svg class="text-warning shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
					{$t('lpd.scarcitySignal').replace('{amount}', formatUsdt(remainingUsdt, usdtDecimals))}
				</ActivitySignalPill>
			{/if}
			{#if showGainSignal}
				<ActivitySignalPill variant="success">
					<svg class="text-success shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
					{$t('lpd.gainSignal').replace('{pct}', gain.toFixed(0))}
				</ActivitySignalPill>
			{/if}
		</div>

		<!-- Timeline list -->
		<div class="flex flex-col gap-0 pt-2">
			{#each txItems as tx, i}
				{@const ms = milestoneFor(i)}
				{#if ms}
					{#if softCapNum > 0 && ms.raisedBefore < softCapNum && ms.raisedIncluding >= softCapNum}
						<div class="flex items-center gap-2 my-2 font-mono text-xs2 font-bold text-success before:flex-1 before:h-px before:bg-success/25 after:flex-1 after:h-px after:bg-success/25">🎯 {$t('lpd.softCapMilestone')}</div>
					{/if}
					{#if hardCapNum2 > 0 && ms.raisedBefore < hardCapNum2 * 0.5 && ms.raisedIncluding >= hardCapNum2 * 0.5}
						<div class="flex items-center gap-2 my-2 font-mono text-xs2 font-bold text-cyan before:flex-1 before:h-px before:bg-cyan/20 after:flex-1 after:h-px after:bg-cyan/20">💎 {$t('lpd.fiftyPctMilestone')}</div>
					{/if}
					{#if ms.buyNumber === 10}
						<div class="flex items-center gap-2 my-2 font-mono text-xs2 font-bold text-purple before:flex-1 before:h-px before:bg-purple-dark/20 after:flex-1 after:h-px after:bg-purple-dark/20">👥 {$t('lpd.tenthPurchaseMilestone')}</div>
					{/if}
				{/if}

				<ActivityRow
					{tx}
					index={i}
					total={txItems.length}
					{firstBuyerAddr}
					{buyerCounts}
					{hardCapVal}
					{curPriceForCtx}
					{userAddress}
					{tokenSymbol}
					{tokenDecimals}
					{usdtDecimals}
					{network}
				/>
			{/each}
		</div>

		<!-- Join CTA -->
		{#if launch.state === 1 && !userAddress}
			<div class="flex items-center justify-between py-3 px-3.5 mt-3 rounded-[10px] bg-gradient-to-br from-cyan-400/[0.06] to-success/[0.06] border border-cyan-400/[0.12] syne text-sm2 font-bold text-[var(--text-heading)]">
				<span>{$t('lpd.joinBuyers').replace('{n}', String(totalBuyers)).replace('{label}', totalBuyers !== 1 ? $t('lpd.buyers') : $t('lpd.buyer'))}</span>
				<button class="btn-primary text-xs px-4 py-2" onclick={onConnectWallet}>{$t('lpd.connectAndBuy')} →</button>
			</div>
		{:else if launch.state === 1 && userBasePaid === 0n}
			<div class="flex items-center justify-between py-3 px-3.5 mt-3 rounded-[10px] bg-gradient-to-br from-cyan-400/[0.06] to-success/[0.06] border border-cyan-400/[0.12] syne text-sm2 font-bold text-[var(--text-heading)]">
				<span>{$t('lpd.beNthBuyer').replace('{n}', String(totalBuyers + 1))}</span>
				<a href="#buy-amount" class="btn-primary text-xs px-4 py-2 no-underline">{$t('lpd.buyNowArrow')} →</a>
			</div>
		{/if}

		{#if txShowMore}
			<button
				class="block w-full mt-3 py-2 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg text-gray-400 font-mono text-xs3 cursor-pointer transition-[background,border-color] duration-150 hover:bg-white/[0.08] hover:border-cyan-400/30 hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={onLoadMore}
				disabled={isLoadingMore}
			>
				{isLoadingMore ? `${$t('status.loading')}...` : $t('lpd.loadOlder').replace('{n}', String(txTotal - txItems.length))}
			</button>
		{/if}
	{/if}
</div>
