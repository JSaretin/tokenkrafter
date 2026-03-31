<script lang="ts">
	let {
		curveType = 0,
		tokensForCurve = 0n,
		tokensSold = 0n,
		currentPrice = 0n,
		hardCap = 0n,
		tokenDecimals = 18,
		usdtDecimals = 18,
		width = 360,
		height = 220
	}: {
		curveType?: number;
		tokensForCurve?: bigint;
		tokensSold?: bigint;
		currentPrice?: bigint;
		hardCap?: bigint;
		tokenDecimals?: number;
		usdtDecimals?: number;
		width?: number;
		height?: number;
	} = $props();

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];

	const pad = { top: 28, right: 20, bottom: 36, left: 52 };
	let plotW = $derived(width - pad.left - pad.right);
	let plotH = $derived(height - pad.top - pad.bottom);

	const STEPS = 100;

	function curveFn(x: number, type: number): number {
		switch (type) {
			case 0: return x;                                          // Linear
			case 1: return Math.sqrt(x);                               // Square Root
			case 2: return x * x;                                      // Quadratic
			case 3: return (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1); // Exponential
			default: return x;
		}
	}

	let progressFrac = $derived.by(() => {
		if (tokensForCurve === 0n) return 0;
		const frac = Number(tokensSold) / Number(tokensForCurve);
		return Math.max(0, Math.min(1, frac));
	});

	// Compute max Y for normalization — the curve value at x=1
	let maxY = $derived(curveFn(1, curveType));

	let pathData = $derived.by(() => {
		const pts: string[] = [];
		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			const y = curveFn(x, curveType) / maxY;
			const px = pad.left + x * plotW;
			const py = pad.top + plotH - y * plotH;
			pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
		}
		return pts.join(' ');
	});

	let fillPath = $derived.by(() => {
		if (progressFrac <= 0) return '';
		const steps = Math.max(1, Math.round(progressFrac * STEPS));
		const pts: string[] = [];

		for (let i = 0; i <= steps; i++) {
			const x = i / STEPS;
			const y = curveFn(x, curveType) / maxY;
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
		const y = curveFn(progressFrac, curveType) / maxY;
		return {
			x: pad.left + progressFrac * plotW,
			y: pad.top + plotH - y * plotH
		};
	});

	// Format bigint to human-readable with abbreviated suffixes
	function formatNum(val: bigint, decimals: number): string {
		const num = Number(val) / (10 ** decimals);
		if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
		if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
		if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
		if (num >= 1) return num.toFixed(2);
		if (num >= 0.001) return num.toFixed(4);
		return num.toFixed(6);
	}

	let yTicks = $derived.by(() => {
		return [0, 0.25, 0.5, 0.75, 1].map((t) => ({
			y: pad.top + plotH - t * plotH,
			label: formatNum(BigInt(Math.round(t * maxY * Number(currentPrice > 0n ? currentPrice : 1n) / curveFn(progressFrac || 0.01, curveType) * maxY)) || 0n, 0)
		}));
	});

	// Simpler Y-axis ticks using percentage
	let yTicksSimple = $derived.by(() => {
		return [0, 0.25, 0.5, 0.75, 1].map((t) => ({
			y: pad.top + plotH - t * plotH,
			label: `${Math.round(t * 100)}%`
		}));
	});

	let xTicks = $derived.by(() => {
		return [0, 0.25, 0.5, 0.75, 1].map((t) => ({
			x: pad.left + t * plotW,
			label: formatNum(BigInt(Math.round(t * Number(tokensForCurve))), tokenDecimals)
		}));
	});
</script>

<div class="price-chart">
	<svg viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="pc-fill-grad" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color="#10b981" stop-opacity="0.3" />
				<stop offset="100%" stop-color="#10b981" stop-opacity="0.02" />
			</linearGradient>
			<linearGradient id="pc-line-grad" x1="0" y1="0" x2="1" y2="0">
				<stop offset="0%" stop-color="#10b981" />
				<stop offset="100%" stop-color="#00d2ff" />
			</linearGradient>
		</defs>

		<!-- Grid lines -->
		{#each yTicksSimple as tick}
			<line
				x1={pad.left}
				y1={tick.y}
				x2={pad.left + plotW}
				y2={tick.y}
				stroke="var(--border-subtle, rgba(255,255,255,0.06))"
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
				stroke="var(--border-subtle, rgba(255,255,255,0.06))"
				stroke-width="1"
			/>
			<text x={tick.x} y={pad.top + plotH + 14} class="axis-label" text-anchor="middle">
				{tick.label}
			</text>
		{/each}

		<!-- Filled area up to progress -->
		{#if progressFrac > 0 && fillPath}
			<path d={fillPath} fill="url(#pc-fill-grad)" />
		{/if}

		<!-- Full curve line -->
		<path d={pathData} fill="none" stroke="url(#pc-line-grad)" stroke-width="2" stroke-linecap="round" opacity="0.4" />

		<!-- Active segment of the curve (thicker) -->
		{#if progressFrac > 0}
			{@const steps = Math.max(1, Math.round(progressFrac * STEPS))}
			{@const activePts = Array.from({ length: steps + 1 }, (_, i) => {
				const x = i / STEPS;
				const y = curveFn(x, curveType) / maxY;
				const px = pad.left + x * plotW;
				const py = pad.top + plotH - y * plotH;
				return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
			}).join(' ')}
			<path d={activePts} fill="none" stroke="url(#pc-line-grad)" stroke-width="2.5" stroke-linecap="round" />
		{/if}

		<!-- Progress marker -->
		{#if progressFrac > 0}
			<line
				x1={markerPos.x}
				y1={markerPos.y}
				x2={markerPos.x}
				y2={pad.top + plotH}
				stroke="#10b981"
				stroke-width="1"
				stroke-dasharray="3,3"
				opacity="0.4"
			/>
			<circle cx={markerPos.x} cy={markerPos.y} r="5" fill="#10b981" />
			<circle cx={markerPos.x} cy={markerPos.y} r="9" fill="none" stroke="#10b981" stroke-width="1.5" opacity="0.3">
				<animate attributeName="r" values="6;10;6" dur="2s" repeatCount="indefinite" />
				<animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
			</circle>
		{/if}

		<!-- Axis labels -->
		<text x={pad.left + plotW / 2} y={height - 4} class="axis-title" text-anchor="middle">Tokens Sold</text>
		<text
			x={8}
			y={pad.top + plotH / 2}
			class="axis-title"
			text-anchor="middle"
			transform="rotate(-90, 8, {pad.top + plotH / 2})"
		>
			Price
		</text>

		<!-- Curve label -->
		<text x={pad.left + plotW / 2} y={16} class="curve-label" text-anchor="middle">
			{CURVE_LABELS[curveType]} Price Curve
		</text>
	</svg>
</div>

<style>
	.price-chart {
		width: 100%;
	}
	.price-chart svg {
		width: 100%;
		height: auto;
	}
	.axis-label {
		font-size: 8px;
		fill: #6b7280;
		font-family: 'Space Mono', monospace;
	}
	.axis-title {
		font-size: 9px;
		fill: #4b5563;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.curve-label {
		font-size: 10px;
		fill: #94a3b8;
		font-family: 'Syne', sans-serif;
		font-weight: 600;
	}
</style>
