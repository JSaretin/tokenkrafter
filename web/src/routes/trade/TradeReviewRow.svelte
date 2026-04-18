<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		leftLabel,
		rightLabel,
		leftSide,
		rightSide,
	}: {
		leftLabel: string;
		rightLabel: string;
		leftSide: Snippet;
		rightSide: Snippet;
	} = $props();
</script>

<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden relative">
	<div class="py-2.5 px-3.5">
		<span class="block font-mono text-xxs font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">{leftLabel}</span>
		{@render leftSide()}
	</div>
	<div class="w-7 h-7 rounded-full bg-(--bg) border border-(--border) flex items-center justify-center text-(--text-dim) -my-3.5 mx-auto z-[1]">
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14m0 0l-4-4m4 4l4-4"/></svg>
	</div>
	<div class="py-2.5 px-3.5 border-t border-(--border)">
		<span class="block font-mono text-xxs font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">{rightLabel}</span>
		{@render rightSide()}
	</div>
</div>
