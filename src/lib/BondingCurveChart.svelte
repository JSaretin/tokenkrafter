<script lang="ts">
	let {
		curveType = 0,
		progress = 0,
		width = 280,
		height = 160
	}: {
		curveType?: number;
		progress?: number;
		width?: number;
		height?: number;
	} = $props();

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];

	const pad = { top: 24, right: 16, bottom: 28, left: 40 };
	let plotW = $derived(width - pad.left - pad.right);
	let plotH = $derived(height - pad.top - pad.bottom);

	const STEPS = 80;

	function curveFn(x: number, type: number): number {
		switch (type) {
			case 0: return x;
			case 1: return Math.sqrt(x);
			case 2: return x * x;
			case 3: return (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1);
			default: return x;
		}
	}

	let pathData = $derived.by(() => {
		const pts: string[] = [];
		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			const y = curveFn(x, curveType);
			const px = pad.left + x * plotW;
			const py = pad.top + plotH - y * plotH;
			pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
		}
		return pts.join(' ');
	});

	let fillPath = $derived.by(() => {
		const clampedProgress = Math.max(0, Math.min(100, progress));
		const pFrac = clampedProgress / 100;
		const steps = Math.max(1, Math.round(pFrac * STEPS));
		const pts: string[] = [];

		for (let i = 0; i <= steps; i++) {
			const x = i / STEPS;
			const y = curveFn(x, curveType);
			const px = pad.left + x * plotW;
			const py = pad.top + plotH - y * plotH;
			pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
		}

		const lastX = pad.left + (steps / STEPS) * plotW;
		const bottomY = pad.top + plotH;
		pts.push(`L${lastX.toFixed(1)},${bottomY.toFixed(1)}`);
		pts.push(`L${pad.left.toFixed(1)},${bottomY.toFixed(1)}`);
		pts.push('Z');
		return pts.join(' ');
	});

	let markerPos = $derived.by(() => {
		const clampedProgress = Math.max(0, Math.min(100, progress));
		const pFrac = clampedProgress / 100;
		const y = curveFn(pFrac, curveType);
		return {
			x: pad.left + pFrac * plotW,
			y: pad.top + plotH - y * plotH
		};
	});

	let yTicks = $derived.by(() => {
		const ticks = [0, 0.25, 0.5, 0.75, 1];
		return ticks.map((t) => ({
			y: pad.top + plotH - t * plotH,
			label: `${Math.round(t * 100)}%`
		}));
	});

	let xTicks = $derived.by(() => {
		return [0, 0.5, 1].map((t) => ({
			x: pad.left + t * plotW,
			label: `${Math.round(t * 100)}%`
		}));
	});
</script>

<div class="curve-chart">
	<svg viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="curve-grad-{curveType}" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color="#00d2ff" stop-opacity="0.25" />
				<stop offset="100%" stop-color="#00d2ff" stop-opacity="0.02" />
			</linearGradient>
			<linearGradient id="line-grad-{curveType}" x1="0" y1="0" x2="1" y2="0">
				<stop offset="0%" stop-color="#3a7bd5" />
				<stop offset="100%" stop-color="#00d2ff" />
			</linearGradient>
		</defs>

		<!-- Grid lines -->
		{#each yTicks as tick}
			<line
				x1={pad.left}
				y1={tick.y}
				x2={pad.left + plotW}
				y2={tick.y}
				stroke="var(--border-subtle)"
				stroke-width="1"
			/>
			<text x={pad.left - 6} y={tick.y + 3} class="axis-label" text-anchor="end">
				{tick.label}
			</text>
		{/each}

		{#each xTicks as tick}
			<line
				x1={tick.x}
				y1={pad.top}
				x2={tick.x}
				y2={pad.top + plotH}
				stroke="var(--border-subtle)"
				stroke-width="1"
			/>
			<text x={tick.x} y={pad.top + plotH + 16} class="axis-label" text-anchor="middle">
				{tick.label}
			</text>
		{/each}

		<!-- Filled area up to progress -->
		{#if progress > 0}
			<path d={fillPath} fill="url(#curve-grad-{curveType})" />
		{/if}

		<!-- Curve line -->
		<path d={pathData} fill="none" stroke="url(#line-grad-{curveType})" stroke-width="2" stroke-linecap="round" />

		<!-- Progress marker -->
		{#if progress > 0}
			<!-- Vertical dashed line at progress -->
			<line
				x1={markerPos.x}
				y1={markerPos.y}
				x2={markerPos.x}
				y2={pad.top + plotH}
				stroke="#00d2ff"
				stroke-width="1"
				stroke-dasharray="3,3"
				opacity="0.4"
			/>
			<!-- Dot -->
			<circle cx={markerPos.x} cy={markerPos.y} r="4" fill="#00d2ff" />
			<circle cx={markerPos.x} cy={markerPos.y} r="7" fill="none" stroke="#00d2ff" stroke-width="1" opacity="0.3" />
		{/if}

		<!-- Axis labels -->
		<text x={pad.left + plotW / 2} y={height - 2} class="axis-title" text-anchor="middle">Tokens Sold</text>
		<text
			x={6}
			y={pad.top + plotH / 2}
			class="axis-title"
			text-anchor="middle"
			transform="rotate(-90, 6, {pad.top + plotH / 2})"
		>
			Price
		</text>

		<!-- Curve label -->
		<text x={pad.left + plotW / 2} y={14} class="curve-label" text-anchor="middle">
			{CURVE_LABELS[curveType]} Curve
		</text>
	</svg>
</div>

<style>
	.curve-chart {
		width: 100%;
	}
	.curve-chart svg {
		width: 100%;
		height: auto;
	}
	.axis-label {
		font-size: 8px;
		fill: var(--text-dim);
		font-family: 'Space Mono', monospace;
	}
	.axis-title {
		font-size: 9px;
		fill: var(--text-dim);
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.curve-label {
		font-size: 10px;
		fill: var(--text-muted);
		font-family: 'Syne', sans-serif;
		font-weight: 600;
	}
</style>
