<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt } from '$lib/launchpad';

	let {
		maxBuyPerWallet,
		remainingBuyUsdt,
		allocationPct,
		atMaxBuy,
		usdtDecimals,
	}: {
		maxBuyPerWallet: bigint;
		remainingBuyUsdt: bigint;
		allocationPct: number;
		atMaxBuy: boolean;
		usdtDecimals: number;
	} = $props();
</script>

<!-- Remaining Buy Indicator -->
<div class="py-2.5 px-3 bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] rounded-[10px] mb-4">
	{#if maxBuyPerWallet === 0n}
		<span class="text-gray-500 text-xs font-mono">{$t('lpd.noBuyLimit')}</span>
	{:else if atMaxBuy}
		<div>
			<div class="flex justify-between text-xs2 font-mono mb-1.5">
				<span class="text-emerald-400 font-semibold">{$t('lpd.maxAllocReached')}</span>
				<span class="text-emerald-400">100%</span>
			</div>
			<div class="h-1.5 rounded-sm bg-[var(--bg-surface-hover)] overflow-hidden">
				<div class="h-full w-full rounded-sm bg-gradient-to-r from-success to-success-dark transition-[width] duration-300"></div>
			</div>
			<div class="text-xs2 font-mono mt-1.5 text-gray-500">
				{$t('lpd.usedFullAlloc').replace('{amount}', formatUsdt(maxBuyPerWallet, usdtDecimals))}
			</div>
		</div>
	{:else}
		<div>
			<div class="flex justify-between text-xs2 font-mono mb-1.5">
				<span class="text-gray-500">{$t('lpd.allocationUsed')}</span>
				<span class="text-gray-400">{allocationPct.toFixed(1)}%</span>
			</div>
			<div class="h-1.5 rounded-sm bg-[var(--bg-surface-hover)] overflow-hidden">
				<div class="h-full rounded-sm bg-gradient-to-r from-cyan to-blue transition-[width] duration-300" style="width: {allocationPct}%"></div>
			</div>
			<div class="text-xs2 font-mono mt-1.5 text-gray-400">
				{$t('lpd.remainingBuyUsdt').replace('{amount}', formatUsdt(remainingBuyUsdt, usdtDecimals))}
			</div>
		</div>
	{/if}
</div>
