<script lang="ts">
	import ModeBtn from './ModeBtn.svelte';

	let {
		selected = $bindable<'token' | 'bank' | 'fiat'>('token'),
	}: {
		selected: 'token' | 'bank' | 'fiat';
	} = $props();
</script>

<div class="flex gap-1 p-1 bg-(--bg-surface) border border-(--border) rounded-[14px] mb-2">
	<ModeBtn id="token" bind:selected activeColor="cyan">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
		Swap
	</ModeBtn>
	<ModeBtn id="bank" bind:selected activeColor="emerald">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>
		Sell
	</ModeBtn>
	<ModeBtn id="fiat" bind:selected activeColor="cyan">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>
		Buy
	</ModeBtn>
</div>
