<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import type { ExploreView } from '$lib/structure/views/exploreView';

	let {
		view,
		tokenAddress,
		chainSlug,
		launchAddress,
		copied,
		onCopyAddress,
	}: {
		view: ExploreView;
		tokenAddress: string;
		chainSlug: string;
		launchAddress: string | null;
		copied: boolean;
		onCopyAddress: () => void;
	} = $props();
</script>

<div class="flex flex-wrap gap-1.5 mb-5">
	{#if view.isSafu}<span class="font-mono text-xs2 font-extrabold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-success/15 text-success border-success/30">{$t('explore.detail.safu')}</span>{/if}
	{#if view.ownerRenounced}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-success/8 text-success-dark border-success/12">{$t('explore.detail.renounced')}</span>{/if}
	{#if view.taxCeilingLocked}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-success/8 text-success-dark border-success/12">{$t('explore.detail.taxLocked')}</span>{/if}
	{#if view.allBurned}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-success/8 text-success-dark border-success/12">{$t('explore.detail.lpBurned')}</span>{/if}
	{#if view.isTaxable}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-warning/8 text-[#d97706] border-warning/12">{$t('explore.detail.taxable')}</span>{/if}
	{#if view.isMintable}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-danger/8 text-[#dc2626] border-danger/12">{$t('explore.detail.mintable')}</span>{/if}
	{#if view.isPartner}<span class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border uppercase tracking-wide cursor-default bg-purple-dark/8 text-[#7c3aed] border-purple-dark/12">{$t('explore.detail.partner')}</span>{/if}
	<button class="font-mono text-xs2 font-normal px-2.5 py-1 rounded-md border bg-cyan/4 text-[#0e7490] border-cyan/8 cursor-pointer flex items-center gap-1.25 hover:bg-cyan/8 hover:text-cyan" onclick={onCopyAddress}>
		{copied ? $t('explore.detail.copied') : shortAddr(tokenAddress)}
		<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
	</button>
	{#if launchAddress}
		<a href="/launchpad/{chainSlug}/{launchAddress}" class="font-mono text-xs2 font-bold px-2.5 py-1 rounded-md border bg-cyan/6 text-cyan border-cyan/15 uppercase tracking-wide flex items-center gap-1 no-underline hover:bg-cyan/12 hover:border-cyan/30">
			<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			{$t('explore.detail.launch')}
		</a>
	{/if}
</div>
