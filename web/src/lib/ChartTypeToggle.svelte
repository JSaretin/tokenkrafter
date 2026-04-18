<script lang="ts">
	import { chartPrefs, type ChartType } from '$lib/chartPrefs.svelte';

	const types: { key: ChartType; label: string; icon: string }[] = [
		{ key: 'line', label: 'Line', icon: '⌇' },
		{ key: 'bar', label: 'Bar', icon: '▥' },
		{ key: 'scatter', label: 'Dot', icon: '⁙' },
	];
</script>

<div class="flex gap-[2px] bg-surface rounded-md p-[2px]">
	{#each types as t}
		<button
			onclick={() => { chartPrefs.type = t.key; }}
			class={'px-2 py-[3px] text-xs font-semibold bg-transparent border-none rounded cursor-pointer transition-all duration-150 leading-none ' + (chartPrefs.type === t.key ? 'text-[#00d2ff] bg-[rgba(0,210,255,0.1)]' : 'text-dim hover:text-muted hover:bg-surface-hover')}
			title="{t.label} chart"
		>
			{t.icon}
		</button>
	{/each}
</div>
