<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		tradingEnabled,
		state: launchState,
		isCreator,
		tradingOpensIn,
		isEnablingTrading,
		onEnableTrading
	}: {
		tradingEnabled: boolean;
		state: number;
		isCreator: boolean;
		tradingOpensIn: bigint | number;
		isEnablingTrading: boolean;
		onEnableTrading: () => Promise<void>;
	} = $props();

	const opensInBig = $derived(typeof tradingOpensIn === 'bigint' ? tradingOpensIn : BigInt(Math.floor(Number(tradingOpensIn))));
	const neverEnabled = $derived(opensInBig === -1n);
	const show = $derived(!tradingEnabled && launchState === 2 && neverEnabled);
</script>

{#if show}
	{#if isCreator}
		<!-- enableTrading was never called — creator needs to act -->
		<div class="card p-4 mb-4 border border-red-500/20">
			<h3 class="syne font-bold text-red-400 mb-2 text-sm">{$t('lpd.enableTradingTitle')}</h3>
			<p class="text-gray-400 text-xs font-mono mb-2">
				{$t('lpd.enableTradingMsg')}
			</p>
			<p class="text-gray-500 text-xs2 font-mono mb-3">
				{$t('lpd.enableTradingNote')}
			</p>
			<button
				onclick={onEnableTrading}
				disabled={isEnablingTrading}
				class="btn-primary w-full py-2.5 text-sm cursor-pointer"
			>
				{#if isEnablingTrading}
					<span class="spinner-inline"></span> {$t('lpd.enabling')}
				{:else}
					{$t('lpd.enableTrading')}
				{/if}
			</button>
		</div>
	{:else}
		<!-- Not creator, trading never enabled -->
		<div class="card p-4 mb-4 border border-red-500/20">
			<p class="text-red-400 text-xs font-mono">
				{$t('lpd.tradingNotEnabled')}
			</p>
		</div>
	{/if}
{/if}
