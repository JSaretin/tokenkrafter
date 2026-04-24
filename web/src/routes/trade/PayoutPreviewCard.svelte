<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';

	let {
		fiatEquivalent = '',
		previewFee,
		previewNet,
		usdtDecimals = 18,
	}: {
		fiatEquivalent?: string;
		previewFee: bigint;
		previewNet: bigint;
		usdtDecimals?: number;
	} = $props();

	let show = $derived(!!fiatEquivalent || previewNet > 0n);

	let netUsd = $derived(Number(ethers.formatUnits(previewNet, usdtDecimals)).toFixed(2));
	let feeUsd = $derived(Number(ethers.formatUnits(previewFee, usdtDecimals)).toFixed(2));

	let feePct = $derived(
		previewFee > 0n && previewNet > 0n
			? ((Number(previewFee) / Number(previewFee + previewNet)) * 100).toFixed(1)
			: '1'
	);
</script>

{#if show}
	<div class="bg-[rgba(16,185,129,0.05)] border border-[rgba(16,185,129,0.1)] rounded-[10px] p-3.5 my-3 mb-2.5">
		{#if fiatEquivalent}
			<div class="text-center">
				<span class="block font-[Rajdhani,sans-serif] text-28 font-bold text-[#10b981] leading-[1.2] tabular-nums">{fiatEquivalent}</span>
				<span class="block font-mono text-3xs text-(--text-dim) mt-1">≈${netUsd} USD</span>
			</div>
		{/if}
		{#if previewNet > 0n}
			<div class={"flex flex-col gap-1 " + (fiatEquivalent ? "mt-2 pt-2 border-t border-(--border-subtle)" : "")}>
				<div class="flex justify-between font-mono text-3xs text-(--text-dim)">
					<span>{$t('trade.feeWithPct').replace('{pct}', feePct)}</span>
					<span>${feeUsd}</span>
				</div>
				<div class="flex justify-between font-mono text-3xs text-(--text-dim)">
					<span>{$t('trade.youReceive')}</span>
					<span class="text-[#10b981] font-bold">${netUsd}</span>
				</div>
			</div>
		{/if}
	</div>
{/if}
