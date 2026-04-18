<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		subtitle = '',
		action,
	}: {
		title: string;
		subtitle?: string;
		action: Snippet;
	} = $props();
</script>

<div class="text-center pt-4 pb-2">
	<div class="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center bg-[rgba(16,185,129,0.1)] border-2 border-[rgba(16,185,129,0.3)] animate-scale-in">
		<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
	</div>
	<span class="block syne text-lg2 font-bold text-success mb-1">{title}</span>
	{#if subtitle}
		<span class="block font-mono text-xs text-(--text-muted)">{subtitle}</span>
	{/if}
	<div class="mt-3">
		{@render action()}
	</div>
</div>
