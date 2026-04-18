<script lang="ts">
	import { t } from '$lib/i18n';
	import type { ExploreView } from '$lib/structure/views/exploreView';

	let {
		view,
		pools,
		effectivePrice,
		mcap,
		volume24h,
		fmtMcap,
		fmtVol,
		fmtSupply,
	}: {
		view: ExploreView;
		pools: Array<{ has_liquidity: boolean }>;
		effectivePrice: number;
		mcap: number;
		volume24h: number;
		fmtMcap: (v: number) => string;
		fmtVol: (v: number) => string;
		fmtSupply: (val: string | number, dec: number) => string;
	} = $props();
</script>

<div class="flex items-stretch bg-(--bg-surface) border border-(--border-subtle) rounded-xl overflow-hidden mb-4 max-[540px]:flex-wrap">
	{#if effectivePrice > 0}
		<div class="flex-1 px-4.5 py-3.5 max-[540px]:min-w-[45%]">
			<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-1">{$t('explore.detail.marketCap')}</span>
			<span class="rajdhani text-lg2 font-bold text-(--text)">{fmtMcap(mcap)}</span>
		</div>
		<div class="w-px bg-(--bg-surface-input) self-stretch max-[540px]:hidden"></div>
		{#if volume24h > 0}
			<div class="flex-1 px-4.5 py-3.5 max-[540px]:min-w-[45%]">
				<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-1">{$t('explore.detail.volume24h')}</span>
				<span class="rajdhani text-lg2 font-bold text-(--text)">{fmtVol(volume24h)}</span>
			</div>
			<div class="w-px bg-(--bg-surface-input) self-stretch max-[540px]:hidden"></div>
		{/if}
	{/if}
	<div class="flex-1 px-4.5 py-3.5 max-[540px]:min-w-[45%]">
		<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-1">{$t('explore.detail.supply')}</span>
		<span class="rajdhani text-lg2 font-bold text-(--text)">{fmtSupply(view.totalSupply, view.decimals)}</span>
	</div>
	<div class="w-px bg-(--bg-surface-input) self-stretch max-[540px]:hidden"></div>
	<div class="flex-1 px-4.5 py-3.5 max-[540px]:min-w-[45%]">
		<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-1">{$t('explore.detail.pools')}</span>
		<span class="rajdhani text-lg2 font-bold text-(--text)" title={$t('explore.detail.poolsTitle').replace('{active}', String(view.activePools.length)).replace('{total}', String(pools.length))}>{view.activePools.length}<span class="text-sm2 text-(--text-dim) font-medium">/{pools.length}</span></span>
	</div>
	{#if view.createdAt}
		<div class="w-px bg-(--bg-surface-input) self-stretch max-[540px]:hidden"></div>
		<div class="flex-1 px-4.5 py-3.5 max-[540px]:min-w-[45%]">
			<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-1">{$t('explore.detail.created')}</span>
			<span class="rajdhani text-lg2 font-bold text-(--text)">{view.createdAt}</span>
		</div>
	{/if}
</div>
