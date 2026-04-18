<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		buyAmount = $bindable(''),
		paySymbol,
		swapEstimate,
		swapEstimateLoading,
	}: {
		buyAmount: string;
		paySymbol: string;
		swapEstimate: string;
		swapEstimateLoading: boolean;
	} = $props();
</script>

<!-- Amount in USDT -->
<div class="mb-3">
	<label class="label-text" for="buy-amount">{$t('lpd.amountUsdt')}</label>
	<input
		id="buy-amount"
		type="number"
		class="input-field"
		placeholder={$t('lpd.amountPlaceholder')}
		bind:value={buyAmount}
		step="any"
		min="0"
	/>
</div>

{#if swapEstimateLoading}
	<div class="text-gray-500 text-xs2 font-mono mt-1 mb-2">{$t('lpd.estimating').replace('{symbol}', paySymbol)}</div>
{:else if swapEstimate}
	<div class="text-cyan-400 text-xs3 font-mono mt-1 mb-2">{swapEstimate}</div>
{/if}
