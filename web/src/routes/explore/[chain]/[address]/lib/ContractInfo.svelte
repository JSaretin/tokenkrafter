<script lang="ts">
	import { t } from '$lib/i18n';
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

<!-- Contract details — lives inside the "Technical details" disclosure on the
     detail page. Creator attribution moved to the hero, so this card stays
     terse: address + decimals + standard. -->
<section class="mb-4">
	<h3 class="syne text-3xs font-bold text-(--text-dim) uppercase tracking-wide m-0 mb-2">{$t('explore.detail.contract')}</h3>
	<div class="flex justify-between items-center px-4 py-3 rounded-[10px] border border-(--border-subtle) bg-(--bg-surface) gap-3">
		<span class="font-mono text-xs3 max-[540px]:text-xxs text-(--text-dim) overflow-hidden text-ellipsis whitespace-nowrap">{tokenAddress}</span>
		<span class="flex gap-2 shrink-0">
			<CopyButton text={tokenAddress} label={$t('explore.detail.copy')} copiedLabel={$t('explore.detail.copiedCheck')} class="font-mono text-xs2 text-cyan bg-transparent border-none cursor-pointer py-0.5 no-underline transition-opacity duration-150 hover:opacity-70" />
			<a class="font-mono text-xs2 text-cyan bg-transparent border-none cursor-pointer py-0.5 no-underline transition-opacity duration-150 hover:opacity-70" href="{explorerUrl}/address/{tokenAddress}" target="_blank" rel="noopener">{$t('explore.detail.explorer')}</a>
		</span>
	</div>
	<div class="flex flex-wrap gap-x-5 gap-y-1 mt-2 px-4">
		<span class="font-mono text-xxs text-(--text-dim)"><span class="uppercase">{$t('explore.detail.decimals')}</span> <span class="text-[#0891b2]">{view.decimals}</span></span>
		<span class="font-mono text-xxs text-(--text-dim)"><span class="uppercase">{$t('explore.detail.standard')}</span> <span class="text-[#0891b2]">ERC-20</span></span>
	</div>
</section>
