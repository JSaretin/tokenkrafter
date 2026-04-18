<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatTokens } from '$lib/launchpad';

	let {
		reclaimableBalance,
		tokenDecimals,
		tokenSymbol,
		isReclaiming,
		onReclaim,
	}: {
		reclaimableBalance: bigint;
		tokenDecimals: number;
		tokenSymbol: string;
		isReclaiming: boolean;
		onReclaim: () => Promise<void>;
	} = $props();
</script>

<div class="card p-6 mb-4 border-amber-500/20">
	<h3 class="syne font-bold text-amber-300 mb-1">{$t('lpd.creatorTools')}</h3>
	<p class="text-gray-500 text-xs font-mono mb-4">
		{$t('lpd.refundingExplain')}
	</p>

	{#if reclaimableBalance > 0n}
		<div class="detail-row mb-3">
			<span class="detail-label">{$t('lpd.reclaimableNow')}</span>
			<span class="detail-value">{formatTokens(reclaimableBalance, tokenDecimals)} {tokenSymbol}</span>
		</div>
		<button
			onclick={onReclaim}
			disabled={isReclaiming}
			class="btn-primary w-full py-2.5 text-sm cursor-pointer"
		>
			{isReclaiming ? $t('lpd.reclaiming') : $t('lpd.reclaimAvailable')}
		</button>
		<p class="text-gray-600 text-xs2 font-mono mt-2">
			{$t('lpd.reclaimCallNote')}
		</p>
	{:else}
		<p class="text-gray-600 text-xs font-mono">{$t('lpd.noReclaimable')}</p>
	{/if}
</div>
