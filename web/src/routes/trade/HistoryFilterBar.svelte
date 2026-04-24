<script lang="ts">
	import { t } from '$lib/i18n';

	export type HistoryFilter = 'all' | 'pending' | 'completed' | 'timeout' | 'cancelled';
	export type FilterCounts = Record<HistoryFilter, number>;

	let {
		filter = $bindable<HistoryFilter>('all'),
		counts,
	}: {
		filter: HistoryFilter;
		counts: FilterCounts;
	} = $props();

	const FILTERS: HistoryFilter[] = ['all', 'pending', 'completed', 'timeout', 'cancelled'];

	function labelFor(f: HistoryFilter): string {
		switch (f) {
			case 'all': return $t('trade.all');
			case 'pending': return $t('trade.pending');
			case 'completed': return $t('trade.completed');
			case 'timeout': return $t('trade.timeout');
			case 'cancelled': return $t('trade.cancelled');
		}
	}
</script>

<div class="flex gap-1 mb-2.5">
	{#each FILTERS as f}
		{@const count = counts[f]}
		<button
			type="button"
			class={"py-1 px-2.5 rounded-full border font-mono text-3xs cursor-pointer transition-all duration-[120ms] capitalize " + (filter === f ? "text-[#00d2ff] border-[rgba(0,210,255,0.25)] bg-[rgba(0,210,255,0.06)]" : "text-(--text-dim) border-(--border) bg-transparent hover:text-(--text-muted) hover:border-(--border-input)")}
			onclick={() => filter = f}
		>
			{labelFor(f)}
			{#if count > 0}
				<span class="inline-flex items-center justify-center min-w-4 h-4 py-0 px-1 rounded-lg text-xs4 font-bold bg-[rgba(0,210,255,0.1)] text-[#00d2ff] ml-[3px]">{count}</span>
			{/if}
		</button>
	{/each}
</div>
