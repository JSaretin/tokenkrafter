<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
	}: {
		children: Snippet;
	} = $props();
</script>

<div class="flex items-center gap-[7px] font-mono text-xs2 text-(--text-muted)">
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
	{@render children()}
</div>
