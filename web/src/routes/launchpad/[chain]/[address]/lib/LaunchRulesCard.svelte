<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt } from '$lib/launchpad';

	let {
		maxBuyPerWallet,
		lockDurationAfterListing,
		creatorAllocationBps,
		vestingCliffSeconds,
		vestingDurationSeconds,
		usdtDecimals,
		badges
	}: {
		maxBuyPerWallet: bigint;
		lockDurationAfterListing: bigint;
		creatorAllocationBps: bigint;
		vestingCliffSeconds: bigint;
		vestingDurationSeconds: bigint;
		usdtDecimals: number;
		badges: string[];
	} = $props();

	let show = $derived(
		badges.includes('taxable') ||
		maxBuyPerWallet > 0n ||
		lockDurationAfterListing > 0n ||
		(creatorAllocationBps > 0n && (vestingCliffSeconds > 0n || vestingDurationSeconds > 0n))
	);
</script>

{#if show}
<div class="bg-(--bg-surface) border border-(--border) rounded-[14px] py-3.5 px-4 mb-4">
	<div class="flex items-center gap-1.5 mb-2.5">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
		<span class="syne text-xs font-extrabold text-(--text-heading) tracking-wide">{$t('lpd.launchSettings')}</span>
	</div>
	<div class="flex flex-col gap-2">
		{#if badges.includes('taxable')}
			<div class="flex items-start gap-2 rajdhani text-xs leading-tight text-success">
				<svg class="shrink-0 mt-px" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
				<span>{$t('lpd.taxRatesLocked')}</span>
			</div>
		{/if}
		{#if maxBuyPerWallet > 0n}
			<div class="flex items-start gap-2 rajdhani text-xs leading-tight text-(--text-muted)">
				<svg class="shrink-0 mt-px" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
				<span>{$t('lpd.maxPerWallet').replace('{amount}', formatUsdt(maxBuyPerWallet, usdtDecimals))}</span>
			</div>
		{/if}
		{#if lockDurationAfterListing > 0n}
			<div class="flex items-start gap-2 rajdhani text-xs leading-tight text-(--text-muted)">
				<svg class="shrink-0 mt-px" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
				<span>{$t('lpd.tradingDelay').replace('{duration}', Number(lockDurationAfterListing) >= 3600 ? `${Math.round(Number(lockDurationAfterListing) / 3600)}h` : `${Math.round(Number(lockDurationAfterListing) / 60)}m`)}</span>
			</div>
		{/if}
		{#if creatorAllocationBps > 0n && (vestingCliffSeconds > 0n || vestingDurationSeconds > 0n)}
			<div class="flex items-start gap-2 rajdhani text-xs leading-tight text-(--text-muted)">
				<svg class="shrink-0 mt-px" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
				<span>{$t('lpd.creatorVested')}{vestingCliffSeconds > 0n ? ` - ${$t('lpd.cliffSuffix').replace('{days}', String(Math.round(Number(vestingCliffSeconds) / 86400)))}` : ''}{vestingDurationSeconds > 0n ? ` + ${$t('lpd.linearUnlockSuffix').replace('{days}', String(Math.round(Number(vestingDurationSeconds) / 86400)))}` : ''}</span>
			</div>
		{/if}
	</div>
</div>
{/if}
