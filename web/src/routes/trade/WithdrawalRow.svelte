<script lang="ts">
	import { ethers } from 'ethers';
	import { WithdrawStatus, withdrawStatusLabel, withdrawStatusColor } from '$lib/structure/tradeRouter';
	import { t } from '$lib/i18n';
	import type { WithdrawalRecord } from '$lib/TradeRouterClient';

	interface DisplayWithdrawal extends Pick<WithdrawalRecord, 'grossAmount' | 'createdAt' | 'expiresAt' | 'status'> {
		withdraw_id?: number | string;
	}

	let {
		withdrawal,
		usdtDecimals = 18,
		onclick,
	}: {
		withdrawal: DisplayWithdrawal;
		usdtDecimals?: number;
		onclick: () => void;
	} = $props();

	let timedOut = $derived(
		withdrawal.status === WithdrawStatus.Pending
		&& withdrawal.expiresAt > 0
		&& Date.now() / 1000 > withdrawal.expiresAt
	);
	let statusColor = $derived(timedOut ? 'red' : withdrawStatusColor(withdrawal.status));
	let statusText = $derived(timedOut ? $t('trade.timedOut') : withdrawStatusLabel(withdrawal.status));
	let canCancel = $derived(timedOut);
	let amount = $derived(parseFloat(ethers.formatUnits(withdrawal.grossAmount, usdtDecimals)).toFixed(2));
	let createdDate = $derived(new Date(Number(withdrawal.createdAt) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

	let hasPendingTimer = $derived(withdrawal.status === WithdrawStatus.Pending && withdrawal.expiresAt > 0);
	let now = $derived(Math.floor(Date.now() / 1000));
	let totalDuration = $derived(withdrawal.expiresAt - Number(withdrawal.createdAt));
	let remaining = $derived(Math.max(0, withdrawal.expiresAt - now));
	let progressPct = $derived(totalDuration > 0 ? Math.max(0, (remaining / totalDuration) * 100) : 0);
	let timerText = $derived(remaining > 0 ? `${Math.floor(remaining / 60)}m ${remaining % 60}s` : $t('trade.timedOut'));

	let statusColorClass = $derived(
		statusColor === 'amber' ? 'text-warning'
			: statusColor === 'emerald' ? 'text-success'
			: statusColor === 'red' ? 'text-danger-light'
			: 'text-(--text-muted)'
	);
</script>

<button class="p-2.5 bg-(--bg-surface-input) rounded-[10px] mb-1.5 w-full border border-transparent cursor-pointer text-left transition-all duration-150 hover:border-[rgba(0,210,255,0.2)] hover:bg-[rgba(0,210,255,0.03)]" {onclick}>
	<div class="flex justify-between items-center">
		<span class="font-mono text-sm2 font-bold text-(--text-heading)">${amount}</span>
		<span class={"font-mono text-xs2 font-bold uppercase " + statusColorClass}>{statusText}</span>
	</div>
	<div class="flex justify-between items-center mt-1">
		{#if withdrawal.withdraw_id}<span class="font-mono text-xs2 text-(--text-muted) font-semibold">#{withdrawal.withdraw_id}</span>{/if}
		<span class="font-mono text-xs2 text-(--text-dim)">{createdDate}</span>
		{#if canCancel}
			<span class="font-mono text-xs2 text-danger-light">{$t('trade.tapToCancel')}</span>
		{/if}
	</div>
	{#if hasPendingTimer}
		<div class="mt-1.5">
			<div class="w-full h-0.75 bg-(--bg-surface-hover) rounded-xs overflow-hidden mb-0.5">
				<div class="h-full rounded-xs transition-[width] duration-300 bg-[linear-gradient(90deg,#f59e0b,#d97706)]" style="width: {progressPct}%"></div>
			</div>
			<span class="font-mono text-xxs text-[rgba(245,158,11,0.7)]">{timerText}</span>
		</div>
	{/if}
</button>
