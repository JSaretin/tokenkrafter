<script lang="ts">
	import { chartPrefs, type ChartType } from '$lib/chartPrefs.svelte';

	const types: { key: ChartType; label: string; icon: string }[] = [
		{ key: 'line', label: 'Line', icon: '⌇' },
		{ key: 'bar', label: 'Bar', icon: '▥' },
		{ key: 'scatter', label: 'Dot', icon: '⁙' },
	];
</script>

<div class="chart-type-toggle">
	{#each types as t}
		<button
			onclick={() => { chartPrefs.type = t.key; }}
			class="toggle-btn"
			class:active={chartPrefs.type === t.key}
			title="{t.label} chart"
		>
			{t.icon}
		</button>
	{/each}
</div>

<style>
	.chart-type-toggle {
		display: flex;
		gap: 2px;
		background: rgba(255,255,255,0.03);
		border-radius: 6px;
		padding: 2px;
	}
	.toggle-btn {
		padding: 3px 8px;
		font-size: 12px;
		font-weight: 600;
		color: #64748b;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.15s;
		line-height: 1;
	}
	.toggle-btn:hover {
		color: #94a3b8;
		background: rgba(255,255,255,0.05);
	}
	.toggle-btn.active {
		color: #00d2ff;
		background: rgba(0,210,255,0.1);
	}
</style>
