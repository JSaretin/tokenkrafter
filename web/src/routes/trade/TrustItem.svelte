<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
	}: {
		children: Snippet;
	} = $props();
</script>

<div class="flex items-center gap-[7px] font-mono text-3xs text-(--text-muted)">
	<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
	{@render children()}
</div>
