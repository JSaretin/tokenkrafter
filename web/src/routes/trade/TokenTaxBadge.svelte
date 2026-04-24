<script lang="ts">
	import type { TaxInfo } from '$lib/tradeLens';
	import { t } from '$lib/i18n';

	let {
		taxInfo = null,
		taxBuy = 0,
		taxSell = 0,
		hasTax = false,
		isNative = false,
		isPlatform = false,
	}: {
		taxInfo?: TaxInfo | null;
		taxBuy?: number;
		taxSell?: number;
		hasTax?: boolean;
		isNative?: boolean;
		isPlatform?: boolean;
	} = $props();

	let isHoneypot = $derived(!!(taxInfo && !taxInfo.canSell && !isNative && !isPlatform));
	let showTax = $derived(hasTax || (taxInfo && taxInfo.transferTaxBps > 0));
	let transferTax = $derived(taxInfo?.transferTaxBps || 0);
	let totalTax = $derived((taxSell + transferTax) / 100);
</script>

{#if isHoneypot}
	<div class="inline-flex items-center gap-[5px] mt-2 font-mono text-3xs text-[#f87171] bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] rounded-md py-1 px-2 font-bold">
		<span class="w-[5px] h-[5px] rounded-full shrink-0 bg-[#f87171]"></span>
		{$t('trade.honeypot')}
	</div>
{:else if showTax}
	<div class="inline-flex items-center gap-[5px] mt-2 font-mono text-3xs text-[#f59e0b] bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.15)] rounded-md py-1 px-2">
		<span class="w-[5px] h-[5px] rounded-full shrink-0 bg-[#f59e0b]"></span>
		{$t('trade.taxBreakdown').replace('{buy}', String(taxBuy / 100)).replace('{sell}', String(taxSell / 100))}{#if transferTax}{$t('trade.taxBreakdownTransfer').replace('{transfer}', String(transferTax / 100))}{/if}
	</div>
	{#if totalTax > 0}
		<p class="font-mono text-3xs text-[#fbbf24] mt-1.5 mb-0">{$t('trade.taxDeductedNote').replace('{pct}', String(totalTax))}</p>
	{/if}
{/if}
