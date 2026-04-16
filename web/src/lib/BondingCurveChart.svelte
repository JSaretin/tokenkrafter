<script lang="ts">
	import Chart from '$lib/Chart.svelte';

	let {
		curveType = 0,
		progress = 0,
		height = '240px'
	}: {
		curveType?: number;
		progress?: number;
		height?: string;
	} = $props();

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];
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

	let chartOption = $derived.by(() => {
		const clampedProgress = Math.max(0, Math.min(100, progress));
		const pFrac = clampedProgress / 100;

		// Full curve data
		const curveData: [number, number][] = [];
		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			curveData.push([x * 100, curveFn(x, curveType) * 100]);
		}

		// Filled area up to progress
		const fillData: [number, number][] = [];
		const fillSteps = Math.max(1, Math.round(pFrac * STEPS));
		for (let i = 0; i <= fillSteps; i++) {
			const x = i / STEPS;
			fillData.push([x * 100, curveFn(x, curveType) * 100]);
		}

		// Current price marker
		const markerY = curveFn(pFrac, curveType) * 100;

		return {
			tooltip: {
				trigger: 'axis',
				axisPointer: { type: 'cross', label: { show: false }, crossStyle: { color: 'rgba(0,210,255,0.2)' } },
				formatter: (params: any) => {
					const arr = Array.isArray(params) ? params : [params];
					const p = arr.find((a: any) => a.seriesIndex === 1) || arr[0];
					if (!p?.data) return '';
					return `<div style="font-family:Rajdhani,sans-serif">
						<div style="font-weight:700;margin-bottom:4px">${CURVE_LABELS[curveType]}</div>
						<div>Tokens sold: <b>${p.data[0].toFixed(1)}%</b></div>
						<div>Price level: <b>${p.data[1].toFixed(1)}%</b></div>
					</div>`;
				},
			},
			grid: { top: 30, right: 8, bottom: 32, left: 38 },
			xAxis: {
				type: 'value',
				name: 'Tokens sold',
				nameLocation: 'center',
				nameGap: 20,
				nameTextStyle: { fontSize: 10, color: '#64748b' },
				min: 0, max: 100,
				axisLabel: { formatter: '{value}%', fontSize: 10 },
				splitLine: { show: false },
			},
			yAxis: {
				type: 'value',
				name: 'Price',
				nameLocation: 'center',
				nameGap: 32,
				nameTextStyle: { fontSize: 10, color: '#64748b' },
				min: 0, max: 100,
				axisLabel: { formatter: '{value}%', fontSize: 10 },
			},
			series: [
				// Filled area (progress)
				{
					type: 'line',
					data: fillData,
					smooth: curveType !== 0,
					symbol: 'none',
					lineStyle: { width: 0 },
					areaStyle: {
						color: {
							type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: 'rgba(0,210,255,0.3)' },
								{ offset: 1, color: 'rgba(0,210,255,0.02)' },
							],
						},
					},
					z: 1,
					_fixed: true,
				},
				// Full curve line
				{
					type: 'line',
					data: curveData,
					smooth: curveType !== 0,
					symbol: 'none',
					lineStyle: {
						width: 2.5,
						color: {
							type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [
								{ offset: 0, color: '#3a7bd5' },
								{ offset: 1, color: '#00d2ff' },
							],
						},
					},
					z: 2,
					_fixed: true,
				},
				// Current position marker
				...(clampedProgress > 0 ? [{
					type: 'scatter',
					data: [[pFrac * 100, markerY]],
					symbolSize: 12,
					itemStyle: { color: '#00d2ff', borderColor: '#fff', borderWidth: 2, shadowColor: 'rgba(0,210,255,0.5)', shadowBlur: 8 },
					tooltip: {
						trigger: 'item',
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700">Current Position</div>
							<div>Sold: <b>${clampedProgress.toFixed(1)}%</b></div>
							<div>Price: <b>${markerY.toFixed(1)}%</b></div>
						</div>`,
					},
					z: 3,
					_fixed: true,
				}] : []),
			],
			graphic: clampedProgress > 0 ? [{
				type: 'text',
				left: 'center',
				top: 6,
				style: {
					text: `${CURVE_LABELS[curveType]} · ${clampedProgress.toFixed(1)}% sold`,
					fill: '#94a3b8',
					fontSize: 11,
					fontFamily: "'Rajdhani', sans-serif",
				},
			}] : [{
				type: 'text',
				left: 'center',
				top: 6,
				style: {
					text: CURVE_LABELS[curveType],
					fill: '#94a3b8',
					fontSize: 11,
					fontFamily: "'Rajdhani', sans-serif",
				},
			}],
		} as any;
	});
</script>

<Chart option={chartOption} {height} />
