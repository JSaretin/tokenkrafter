<script lang="ts">
	import WithdrawalRow from './WithdrawalRow.svelte';
	import LoadingSpinner from '$lib/LoadingSpinner.svelte';
	import { t } from '$lib/i18n';
	import { WithdrawStatus } from '$lib/structure/tradeRouter';
	import type { HistoryFilter } from './HistoryFilterBar.svelte';
	import type { MergedWithdrawal } from '$lib/structure';

	let {
		withdrawals,
		filter,
		loading = false,
		usdtDecimals = 18,
		onselect,
	}: {
		withdrawals: MergedWithdrawal[];
		filter: HistoryFilter;
		loading?: boolean;
		usdtDecimals?: number;
		onselect: (w: MergedWithdrawal) => void;
	} = $props();

	let nowTs = $state(Math.floor(Date.now() / 1000));

	$effect(() => {
		const id = setInterval(() => { nowTs = Math.floor(Date.now() / 1000); }, 1000);
		return () => clearInterval(id);
	});

	let sorted = $derived([...withdrawals].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)));

	let visible = $derived(sorted.filter(w => {
		if (filter === 'all') return true;
		const timedOut = w.status === WithdrawStatus.Pending && w.expiresAt > 0 && nowTs > w.expiresAt;
		if (filter === 'timeout') return timedOut;
		if (filter === 'pending') return w.status === WithdrawStatus.Pending && !timedOut;
		if (filter === 'completed') return w.status === WithdrawStatus.Confirmed;
		if (filter === 'cancelled') return w.status === WithdrawStatus.Cancelled;
		return true;
	}));
</script>

{#if loading}
	<div class="flex justify-center p-5">
		<LoadingSpinner />
	</div>
{:else if withdrawals.length === 0}
	<p class="text-center text-[var(--text-muted)] font-mono text-xs p-5">{$t('trade.noWithdrawals')}</p>
{:else}
	{#each visible as w}
		<WithdrawalRow
			withdrawal={w}
			{usdtDecimals}
			onclick={() => onselect(w)}
		/>
	{/each}
{/if}
