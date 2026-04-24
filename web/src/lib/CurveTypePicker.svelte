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

<button class="flex items-center gap-2.5 w-full px-3.5 py-2.5 rounded-[10px] bg-surface-hover border border-line-input text-foreground cursor-pointer transition-all duration-150 hover:border-[rgba(0,210,255,0.3)] hover:bg-[rgba(0,210,255,0.04)] [&>svg]:text-dim [&>svg]:shrink-0" type="button" onclick={() => showModal = true}>
	<svg class="w-[60px] h-8 shrink-0" viewBox="0 0 60 32" fill="none"><path d={curveMiniPath(value, 60, 32)} stroke="#00d2ff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
	<span class="flex-1 text-left font-display font-semibold text-sm">{CURVE_LABELS[value]}</span>
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
</button>

{#if showModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-[80] bg-black/70 backdrop-blur flex items-center justify-center p-4 max-[500px]:p-0" onclick={() => showModal = false} role="presentation">
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="curve-modal w-full max-w-[440px] max-[500px]:max-w-full bg-background border border-line rounded-[20px] max-[500px]:rounded-2xl overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.5)]" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose curve type" tabindex="-1">
			<div class="flex items-center justify-between px-5 pt-[18px]">
				<h3 class="heading-3">Choose Curve Type</h3>
				<button type="button" class="w-8 h-8 rounded-lg border-none bg-surface-hover text-dim flex items-center justify-center cursor-pointer transition-all duration-150 hover:bg-line-input hover:text-heading" aria-label="Close" onclick={() => showModal = false}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
				</button>
			</div>

			<div class="px-5 py-4">
				<div class="bg-surface border border-line-subtle rounded-xl p-1 mb-3.5 overflow-hidden">
					<BondingCurveChart curveType={value} height="200px" />
				</div>

				<div class="flex flex-col gap-1.5">
					{#each CURVE_LABELS as label, i}
						<button type="button"
							class={'curve-opt flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] border w-full text-inherit cursor-pointer transition-all duration-150 ' + (value === i ? 'bg-[rgba(0,210,255,0.06)] border-[rgba(0,210,255,0.25)] is-active' : 'bg-surface border-line-subtle hover:bg-surface-hover hover:border-line-input')}
							onclick={() => value = i}
						>
							<svg class="w-12 h-7 shrink-0" viewBox="0 0 48 28" fill="none"><path d={curveMiniPath(i, 48, 28)} stroke={value === i ? '#00d2ff' : '#475569'} stroke-width="2" stroke-linecap="round" fill="none"/></svg>
							<div class="flex-1 flex flex-col gap-px text-left">
								<span class={'curve-opt-name font-display text-13 font-semibold ' + (value === i ? 'text-[#00d2ff]' : 'text-foreground')}>{label}</span>
								<span class="font-mono text-3xs text-dim leading-[1.3]">{CURVE_DESCS[i]}</span>
							</div>
							{#if value === i}
								<svg class="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			<button type="button" class="curve-done block w-[calc(100%-40px)] mx-5 mb-[18px] p-3 rounded-[10px] border-none text-white font-display text-sm font-bold cursor-pointer transition-all duration-200 hover:-translate-y-px hover:shadow-[0_6px_28px_rgba(0,210,255,0.3)]" onclick={() => showModal = false}>
				Done
			</button>
		</div>
	</div>
{/if}

<style>
	.curve-modal { animation: curveModalIn 200ms ease-out; }
	@keyframes curveModalIn {
		from { opacity: 0; transform: scale(0.95) translateY(8px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}
	.curve-done { background: linear-gradient(135deg, #00d2ff, #3a7bd5); }
</style>
