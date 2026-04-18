<script lang="ts">
	let {
		state,
		number,
	}: {
		state: 'pending' | 'active' | 'done';
		number: number;
	} = $props();

	let indicatorCls = $derived(
		state === 'done' ? 'border-[#10b981] bg-[rgba(16,185,129,0.15)] text-[#10b981]'
		: state === 'active' ? 'border-[#00d2ff] bg-[rgba(0,210,255,0.1)] text-[#00d2ff]'
		: 'border-(--border) bg-(--bg-surface) text-(--text-dim)'
	);
</script>

<div class={"w-7 h-7 rounded-full shrink-0 flex items-center justify-center border-2 font-mono text-[11px] font-bold transition-all duration-300 " + indicatorCls}>
	{#if state === 'done'}
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
	{:else if state === 'active'}
		<div class="w-3.5 h-3.5 border-2 border-[rgba(0,210,255,0.2)] border-t-[#00d2ff] rounded-full animate-spin"></div>
	{:else}
		<span>{number}</span>
	{/if}
</div>
