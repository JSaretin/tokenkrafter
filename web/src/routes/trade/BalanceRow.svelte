<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';

	let {
		symbol = '',
		balance = 0n,
		decimals = 18,
		usdValue = '',
	}: {
		symbol?: string;
		balance?: bigint;
		decimals?: number;
		usdValue?: string;
	} = $props();

	let formatted = $derived(parseFloat(ethers.formatUnits(balance, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }));
</script>

{#if symbol || usdValue}
	<div class="mt-1.5 font-mono text-[11px] text-(--text-dim) flex justify-between items-center">
		{#if symbol}
			<span>{$t('trade.balance')}: {balance > 0n ? formatted : '0'} {symbol}</span>
		{:else}
			<span></span>
		{/if}
		{#if usdValue}
			<span class="text-(--text-muted) text-xs font-numeric font-medium tabular-nums">{usdValue}</span>
		{/if}
	</div>
{/if}
