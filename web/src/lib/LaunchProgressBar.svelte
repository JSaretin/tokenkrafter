<script lang="ts">
	let {
		progress = 0,
		softCapPct = 0,
		raised = '',
		hardCap = '',
		size = 'md' as 'sm' | 'md' | 'lg',
	}: {
		progress: number;
		softCapPct?: number;
		raised?: string;
		hardCap?: string;
		size?: 'sm' | 'md' | 'lg';
	} = $props();
</script>

<div class="lp-bar lp-bar-{size}">
	{#if raised || hardCap}
		<div class="lp-bar-header">
			<span class="lp-bar-raised">Raised {progress < 1 && progress > 0 ? progress.toFixed(1) : Math.round(progress)}%</span>
			{#if hardCap}
				<span class="lp-bar-cap">{hardCap}</span>
			{/if}
		</div>
	{/if}
	<div class="lp-bar-track-wrap">
		<div class="lp-bar-track">
			<div class="lp-bar-fill" style="width: {progress}%"></div>
		</div>
		{#if softCapPct > 0 && softCapPct < 100}
			<div class="lp-bar-sc" style="left: {softCapPct}%">
				<div class="lp-bar-sc-tick"></div>
				<div class="lp-bar-sc-label">SC</div>
			</div>
		{/if}
	</div>
	{#if raised}
		<div class="lp-bar-footer">
			<span>{raised}{hardCap ? ` / ${hardCap}` : ''}</span>
		</div>
	{/if}
</div>

<style>
	.lp-bar { width: 100%; }

	.lp-bar-header {
		display: flex; justify-content: space-between; align-items: baseline;
		margin-bottom: 6px;
	}
	.lp-bar-raised {
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
		color: var(--text-heading);
	}
	.lp-bar-cap {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim);
	}

	.lp-bar-track-wrap { position: relative; }
	.lp-bar-track {
		width: 100%; overflow: hidden;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border-subtle);
	}
	.lp-bar-fill {
		height: 100%;
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
		border-radius: inherit;
		transition: width 0.3s ease;
		box-shadow: 0 0 8px rgba(0, 210, 255, 0.3);
	}

	/* Size variants */
	.lp-bar-sm .lp-bar-track { height: 8px; border-radius: 4px; }
	.lp-bar-sm .lp-bar-fill { border-radius: 4px; }
	.lp-bar-sm .lp-bar-raised { font-size: 10px; }
	.lp-bar-sm .lp-bar-cap { font-size: 9px; }

	.lp-bar-md .lp-bar-track { height: 12px; border-radius: 6px; }
	.lp-bar-md .lp-bar-fill { border-radius: 6px; }

	.lp-bar-lg .lp-bar-track { height: 16px; border-radius: 8px; }
	.lp-bar-lg .lp-bar-fill { border-radius: 8px; }
	.lp-bar-lg .lp-bar-raised { font-size: 13px; }
	.lp-bar-lg .lp-bar-cap { font-size: 11px; }

	/* Soft cap marker */
	.lp-bar-sc {
		position: absolute; top: 0;
		transform: translateX(-50%);
		display: flex; flex-direction: column; align-items: center;
		pointer-events: none;
	}
	.lp-bar-sc-tick {
		width: 2px; background: rgba(255, 255, 255, 0.4); border-radius: 1px;
	}
	.lp-bar-sm .lp-bar-sc-tick { height: 8px; }
	.lp-bar-md .lp-bar-sc-tick { height: 12px; }
	.lp-bar-lg .lp-bar-sc-tick { height: 16px; }
	.lp-bar-sc-label {
		font-size: 7px; font-family: 'Space Mono', monospace;
		color: rgba(255, 255, 255, 0.35);
		margin-top: 1px; letter-spacing: 0.03em;
	}

	.lp-bar-footer {
		display: flex; justify-content: space-between;
		margin-top: 4px; margin-bottom: 4px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim);
	}
</style>
