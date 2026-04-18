<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt } from '$lib/launchpad';

	let {
		strandedUsdtBalance,
		usdtDecimals,
		sweepWindowOpen,
		isSweeping,
		refundStartTimestamp = 0n,
		strandedSweepDelay = 0n,
		onSweep,
	}: {
		strandedUsdtBalance: bigint;
		usdtDecimals: number;
		sweepWindowOpen: boolean;
		isSweeping: boolean;
		refundStartTimestamp?: bigint;
		strandedSweepDelay?: bigint;
		onSweep: () => Promise<void>;
	} = $props();

	let unlockTs = $derived(Number(refundStartTimestamp) + Number(strandedSweepDelay));
	let daysLeft = $derived(Math.max(0, Math.ceil((unlockTs * 1000 - Date.now()) / (24 * 60 * 60 * 1000))));
</script>

<div class="card p-6 mb-4 border-cyan-500/20">
	<h3 class="syne font-bold text-cyan-300 mb-1">{$t('lpd.platformTools')}</h3>
	<p class="text-gray-500 text-xs font-mono mb-4">
		{$t('lpd.platformSweepExplain')}
	</p>
	<div class="detail-row mb-3">
		<span class="detail-label">{$t('lpd.strandedUsdt')}</span>
		<span class="detail-value">{formatUsdt(strandedUsdtBalance, usdtDecimals)}</span>
	</div>
	{#if sweepWindowOpen}
		<button
			onclick={onSweep}
			disabled={isSweeping}
			class="btn-secondary w-full py-2.5 text-sm cursor-pointer"
		>
			{isSweeping ? $t('lpd.sweeping') : $t('lpd.sweepBtn')}
		</button>
		<p class="text-gray-600 text-xs2 font-mono mt-2">
			{$t('lpd.sweepWindowPassed')}
		</p>
	{:else if refundStartTimestamp > 0n}
		<p class="text-gray-600 text-xs font-mono">
			{$t('lpd.sweepUnlocksIn').replace('{days}', String(daysLeft)).replace('{label}', daysLeft === 1 ? $t('lpd.day') : $t('lpd.days'))}
		</p>
	{/if}
</div>
