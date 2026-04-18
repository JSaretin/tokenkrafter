<script lang="ts">
	let {
		text,
	}: {
		text: string;
	} = $props();
</script>

<div class="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[rgba(0,210,255,0.04)] border border-[rgba(0,210,255,0.08)] font-mono text-xs3 text-(--text-muted) mb-1">
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-cyan shrink-0">
		<path d="M17 1l4 4-4 4" />
		<path d="M3 11V9a4 4 0 0 1 4-4h14" />
		<path d="M7 23l-4-4 4-4" />
		<path d="M21 13v2a4 4 0 0 1-4 4H3" />
	</svg>
	{text}
</div>
