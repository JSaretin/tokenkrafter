<script lang="ts">
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';

	let {
		value = $bindable(0),
	}: {
		value: number;
	} = $props();

	let showModal = $state(false);

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];
	const CURVE_DESCS = [
		'Price rises steadily as tokens sell',
		'Cheaper early, flattens later',
		'Cheap early, expensive late',
		'Slow start, rapid price surge',
	];

	function curveMiniPath(type: number, w: number, h: number): string {
		const pad = 2;
		const pw = w - pad * 2, ph = h - pad * 2;
		const pts: string[] = [];
		const steps = 30;
		for (let i = 0; i <= steps; i++) {
			const x = i / steps;
			let y: number;
			switch (type) {
				case 0: y = x; break;
				case 1: y = Math.sqrt(x); break;
				case 2: y = x * x; break;
				case 3: y = (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1); break;
				default: y = x;
			}
			const px = pad + x * pw;
			const py = pad + ph - y * ph;
			pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
		}
		return pts.join(' ');
	}
</script>

<button class="curve-pick-btn" type="button" onclick={() => showModal = true}>
	<svg class="curve-pick-preview" viewBox="0 0 60 32" fill="none"><path d={curveMiniPath(value, 60, 32)} stroke="#00d2ff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
	<span class="curve-pick-name">{CURVE_LABELS[value]}</span>
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
</button>

{#if showModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="curve-modal-overlay" onclick={() => showModal = false} role="presentation">
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="curve-modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose curve type" tabindex="-1">
			<div class="curve-modal-header">
				<h3 class="curve-modal-title">Choose Curve Type</h3>
				<button type="button" class="curve-modal-close" aria-label="Close" onclick={() => showModal = false}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
				</button>
			</div>

			<div class="curve-modal-body">
				<div class="curve-modal-chart">
					<BondingCurveChart curveType={value} height="200px" />
				</div>

				<div class="curve-modal-options">
					{#each CURVE_LABELS as label, i}
						<button type="button"
							class="curve-option"
							class:curve-option-active={value === i}
							onclick={() => value = i}
						>
							<svg class="curve-option-mini" viewBox="0 0 48 28" fill="none"><path d={curveMiniPath(i, 48, 28)} stroke={value === i ? '#00d2ff' : '#475569'} stroke-width="2" stroke-linecap="round" fill="none"/></svg>
							<div class="curve-option-info">
								<span class="curve-option-name">{label}</span>
								<span class="curve-option-desc">{CURVE_DESCS[i]}</span>
							</div>
							{#if value === i}
								<svg class="curve-option-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			<button type="button" class="curve-modal-done" onclick={() => showModal = false}>
				Done
			</button>
		</div>
	</div>
{/if}

<style>
	.curve-pick-btn {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 10px 14px; border-radius: 10px;
		background: var(--bg-surface-hover, rgba(255,255,255,0.04));
		border: 1px solid var(--border-input, rgba(255,255,255,0.08));
		color: var(--text); cursor: pointer; transition: all 150ms;
	}
	.curve-pick-btn:hover { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.04); }
	.curve-pick-preview { width: 60px; height: 32px; flex-shrink: 0; }
	.curve-pick-name { flex: 1; text-align: left; font-family: 'Syne', sans-serif; font-weight: 600; font-size: 14px; }
	.curve-pick-btn svg { color: var(--text-dim); flex-shrink: 0; }

	.curve-modal-overlay {
		position: fixed; inset: 0; z-index: 80;
		background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center; padding: 16px;
	}
	.curve-modal {
		width: 100%; max-width: 440px;
		background: var(--bg, #07070d); border: 1px solid var(--border);
		border-radius: 20px; overflow: hidden;
		animation: curveModalIn 200ms ease-out;
		box-shadow: 0 24px 80px rgba(0,0,0,0.5);
	}
	@keyframes curveModalIn {
		from { opacity: 0; transform: scale(0.95) translateY(8px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}
	.curve-modal-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 18px 20px 0;
	}
	.curve-modal-title { font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700; color: var(--text-heading); margin: 0; }
	.curve-modal-close {
		width: 32px; height: 32px; border-radius: 8px; border: none;
		background: var(--bg-surface-hover); color: var(--text-dim);
		display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 150ms;
	}
	.curve-modal-close:hover { background: var(--border-input); color: var(--text-heading); }

	.curve-modal-body { padding: 16px 20px; }
	.curve-modal-chart {
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 12px; padding: 4px; margin-bottom: 14px; overflow: hidden;
	}

	.curve-modal-options { display: flex; flex-direction: column; gap: 6px; }
	.curve-option {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 12px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		color: inherit; cursor: pointer; transition: all 150ms; width: 100%;
	}
	.curve-option:hover { background: var(--bg-surface-hover); border-color: var(--border-input); }
	.curve-option-active { background: rgba(0,210,255,0.06); border-color: rgba(0,210,255,0.25); }
	.curve-option-mini { width: 48px; height: 28px; flex-shrink: 0; }
	.curve-option-info { flex: 1; display: flex; flex-direction: column; gap: 1px; text-align: left; }
	.curve-option-name { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: var(--text); }
	.curve-option-active .curve-option-name { color: #00d2ff; }
	.curve-option-desc { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); line-height: 1.3; }
	.curve-option-check { flex-shrink: 0; }

	.curve-modal-done {
		display: block; width: calc(100% - 40px); margin: 0 20px 18px;
		padding: 12px; border-radius: 10px; border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		cursor: pointer; transition: all 200ms;
	}
	.curve-modal-done:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }

	@media (max-width: 500px) {
		.curve-modal { max-width: 100%; border-radius: 16px; }
	}
</style>
