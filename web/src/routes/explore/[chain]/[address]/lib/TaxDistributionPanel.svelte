<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import type { TaxDistributionRow } from '$lib/structure';

	let {
		taxDistribution,
	}: {
		taxDistribution: TaxDistributionRow[];
	} = $props();

	let totalDistributedBps = $derived(taxDistribution.reduce((s, w) => s + w.shareBps, 0));
</script>

{#if taxDistribution.length > 0}
	<div class="bg-(--bg-surface) border border-(--border-subtle) rounded-xl p-4 mb-4">
		<div class="flex items-center gap-2 syne text-xs2 font-bold text-(--text-heading) mb-3">
			<svg class="text-success shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
			<span>{$t('explore.detail.taxDistribution')}</span>
		</div>
		<div class="flex flex-col gap-1.5">
			{#each taxDistribution as w}
				<div class="flex justify-between items-center px-3 py-2 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="font-mono text-xs3 text-(--text-muted)">{shortAddr(w.addr)}</span>
					<span class="rajdhani text-sm2 font-semibold text-(--text)">{(w.shareBps / 100).toFixed(1)}%</span>
				</div>
			{/each}
			{#if totalDistributedBps < 10000}
				<div class="flex justify-between items-center px-3 py-2 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="font-mono text-xs3 text-(--text-dim)">{$t('explore.detail.burnedRemainder')}</span>
					<span class="rajdhani text-sm2 font-semibold text-danger-light">{((10000 - totalDistributedBps) / 100).toFixed(1)}%</span>
				</div>
			{/if}
		</div>
	</div>
{/if}
