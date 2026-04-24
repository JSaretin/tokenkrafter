<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		address,
		explorerUrl = '',
		oncopy,
	}: {
		address: string;
		explorerUrl?: string;
		oncopy?: (address: string) => void;
	} = $props();

	let short = $derived(address.slice(0, 6) + '...' + address.slice(-4));

	const btnCls = 'flex items-center justify-center w-[22px] h-[22px] rounded-[5px] border-0 bg-(--bg-surface-input) text-(--text-dim) cursor-pointer transition-all duration-150 no-underline hover:bg-[rgba(0,210,255,0.1)] hover:text-[#00d2ff]';
</script>

<div class="flex items-center gap-1 shrink-0">
	<span class="font-mono text-3xs text-(--text-dim)">{short}</span>
	{#if oncopy}
		<button type="button" class={btnCls} title={$t('trade.copyAddress')} onclick={(e) => { e.stopPropagation(); oncopy(address); }}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
		</button>
	{/if}
	{#if explorerUrl}
		<a class={btnCls} title={$t('trade.viewOnExplorer')} href="{explorerUrl}/address/{address}" target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
		</a>
	{/if}
</div>
