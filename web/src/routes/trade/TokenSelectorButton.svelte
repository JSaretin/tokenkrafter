<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		symbol = '',
		logo = '',
		onclick,
	}: {
		symbol?: string;
		logo?: string;
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="flex items-center gap-1.5 py-2 px-3 rounded-[20px] border border-(--border) bg-(--bg-surface) cursor-pointer transition-all duration-150 shrink-0 hover:border-[rgba(0,210,255,0.3)] hover:bg-[rgba(0,210,255,0.05)]"
	{onclick}
>
	{#if symbol}
		{#if logo}<img src={logo} alt="" class="w-5 h-5 rounded-full object-cover" />{/if}
		<span class="font-mono text-sm font-bold text-(--text-heading)">{symbol}</span>
	{:else}
		<span class="font-mono text-sm2 text-cyan">{$t('trade.selectToken')}</span>
	{/if}
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
</button>
