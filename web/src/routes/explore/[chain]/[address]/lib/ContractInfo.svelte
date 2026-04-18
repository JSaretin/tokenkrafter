<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import CopyButton from '$lib/CopyButton.svelte';
	import type { ExploreView } from '$lib/structure/views/exploreView';

	let {
		view,
		tokenAddress,
		explorerUrl,
	}: {
		view: ExploreView;
		tokenAddress: string;
		explorerUrl: string;
	} = $props();
</script>

<section class="mb-7">
	<h2 class="syne text-sm2 font-bold text-(--text-dim) uppercase tracking-wide m-0 mb-3">{$t('explore.detail.contract')}</h2>
	<div class="flex justify-between items-center px-4 py-3.5 rounded-[10px] border border-(--border-subtle) bg-(--bg-surface) gap-3">
		<span class="font-mono text-xs3 max-[540px]:text-xxs text-(--text-dim) overflow-hidden text-ellipsis whitespace-nowrap">{tokenAddress}</span>
		<span class="flex gap-2 shrink-0">
			<CopyButton text={tokenAddress} label={$t('explore.detail.copy')} copiedLabel={$t('explore.detail.copiedCheck')} class="font-mono text-xs2 text-cyan bg-transparent border-none cursor-pointer py-0.5 no-underline transition-opacity duration-150 hover:opacity-70" />
			<a class="font-mono text-xs2 text-cyan bg-transparent border-none cursor-pointer py-0.5 no-underline transition-opacity duration-150 hover:opacity-70" href="{explorerUrl}/address/{tokenAddress}" target="_blank" rel="noopener">{$t('explore.detail.explorer')}</a>
		</span>
	</div>
	<div class="mt-1.5">
		{#if view.creator}
			<div class="flex justify-between items-center px-4 py-2.5">
				<span class="font-mono text-xxs text-(--text-dim) uppercase">{$t('explore.detail.creator')}</span>
				<a href="{explorerUrl}/address/{view.creator}" target="_blank" rel="noopener" class="font-mono text-xs3 text-[#0891b2] no-underline hover:text-cyan hover:underline">{shortAddr(view.creator)}</a>
			</div>
		{/if}
		<div class="flex justify-between items-center px-4 py-2.5">
			<span class="font-mono text-xxs text-(--text-dim) uppercase">{$t('explore.detail.decimals')}</span>
			<span class="font-mono text-xs3 text-[#0891b2] cursor-default">{view.decimals}</span>
		</div>
		<div class="flex justify-between items-center px-4 py-2.5">
			<span class="font-mono text-xxs text-(--text-dim) uppercase">{$t('explore.detail.standard')}</span>
			<span class="font-mono text-xs3 text-[#0891b2] cursor-default">ERC-20</span>
		</div>
	</div>
</section>
