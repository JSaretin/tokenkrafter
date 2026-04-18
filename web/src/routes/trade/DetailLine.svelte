<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		warn = false,
		children,
	}: {
		label: string;
		warn?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="flex justify-between py-[3px] font-mono text-xs3">
	<span class="text-(--text-muted)">{label}</span>
	<span class={warn ? "text-warning" : "text-(--text)"}>{@render children()}</span>
</div>
