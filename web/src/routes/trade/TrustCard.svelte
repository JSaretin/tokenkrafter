<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n';

	let {
		title,
		contractUrl = '',
		children,
	}: {
		title: string;
		contractUrl?: string;
		children: Snippet;
	} = $props();
</script>

<div class="mt-3 py-3 px-3.5 rounded-[10px] bg-[rgba(16,185,129,0.04)] border border-[rgba(16,185,129,0.12)]">
	<div class="flex items-center gap-1.5 mb-2 syne text-xs font-bold text-[#10b981]">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
		<span>{title}</span>
	</div>
	<div class="flex flex-col gap-[5px]">
		{@render children()}
	</div>
	{#if contractUrl}
		<a
			href={contractUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="block mt-2 pt-2 border-t border-[rgba(16,185,129,0.08)] font-mono text-xs4 text-[rgba(16,185,129,0.6)] no-underline transition-colors hover:text-[#10b981]"
		>
			{$t('trade.verifyContract')}
		</a>
	{/if}
</div>
