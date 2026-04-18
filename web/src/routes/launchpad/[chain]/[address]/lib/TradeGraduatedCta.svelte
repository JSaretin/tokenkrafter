<script lang="ts">
	import { t } from '$lib/i18n';
	let {
		state,
		tradingEnabled,
		tokenAddress,
		tokenSymbol,
		chainId: _chainId
	}: {
		state: number;
		tradingEnabled: boolean;
		tokenAddress: string;
		tokenSymbol: string;
		chainId: number;
	} = $props();
</script>

{#if state === 2 && tradingEnabled}
	<div class="bg-gradient-to-br from-cyan-400/[0.06] to-emerald-500/[0.06] border border-cyan-400/15 rounded-xl py-4 px-5 mb-4">
		<div class="flex items-center justify-between gap-3 flex-wrap">
			<div>
				<span class="font-mono text-xs font-semibold text-success">{$t('lpd.nowTradingDex')}</span>
			</div>
			<a href={"/trade?token=" + tokenAddress} class="btn-primary text-sm px-5 py-2.5 no-underline">
				{$t('lpd.tradeArrow').replace('{symbol}', tokenSymbol)} →
			</a>
		</div>
	</div>
{/if}
