<script lang="ts">
	import type { TaxInfo } from '$lib/tradeLens';
	import { t } from '$lib/i18n';

	let {
		taxInfo = null,
		taxBuy = 0,
		taxSell = 0,
		hasTax = false,
		isNative = false,
		// Wrapped-native (WBNB / WETH / etc) — always 1:1 unwrappable to
		// the chain's native coin, so it's never a honeypot. The
		// simulator can't simulate a "sell" of WBNB because the AMM
		// pair semantics treat it as a base, not a swappable target,
		// so canSell comes back false even though the token is fine.
		// Skip the honeypot warning for it the same way we skip native.
		isWrappedNative = false,
		isPlatform = false,
	}: {
		taxInfo?: TaxInfo | null;
		taxBuy?: number;
		taxSell?: number;
		hasTax?: boolean;
		isNative?: boolean;
		isWrappedNative?: boolean;
		isPlatform?: boolean;
	} = $props();

	let isHoneypot = $derived(!!(taxInfo && !taxInfo.canSell && !isNative && !isWrappedNative && !isPlatform));
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
	<!-- Single badge only. The previous "<pct>% tax will be deducted
	     from the output" note duplicated the breakdown above it; on a
	     1% taxable token the user saw two near-identical warnings on
	     the same field. The breakdown carries the same information
	     and is clearly enough on its own. -->
	<div class="inline-flex items-center gap-[5px] mt-2 font-mono text-3xs text-[#f59e0b] bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.15)] rounded-md py-1 px-2">
		<span class="w-[5px] h-[5px] rounded-full shrink-0 bg-[#f59e0b]"></span>
		{$t('trade.taxBreakdown').replace('{buy}', String(taxBuy / 100)).replace('{sell}', String(taxSell / 100))}{#if transferTax}{$t('trade.taxBreakdownTransfer').replace('{transfer}', String(transferTax / 100))}{/if}
	</div>
{/if}
