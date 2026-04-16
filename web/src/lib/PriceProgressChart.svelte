<script lang="ts">
	import Chart from '$lib/Chart.svelte';

	let {
		curveType = 0,
		tokensForCurve = 0n,
		tokensSold = 0n,
		currentPrice = 0n,
		hardCap = 0n,
		tokenDecimals = 18,
		usdtDecimals = 18,
		height = '240px'
	}: {
		curveType?: number;
		tokensForCurve?: bigint;
		tokensSold?: bigint;
		currentPrice?: bigint;
		hardCap?: bigint;
		tokenDecimals?: number;
		usdtDecimals?: number;
		height?: string;
	} = $props();

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];
	const STEPS = 100;

	function curveFn(x: number, type: number): number {
		switch (type) {
			case 0: return x;
			case 1: return Math.sqrt(x);
			case 2: return x * x;
			case 3: return (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1);
			default: return x;
		}
	}

	function formatNum(val: bigint, decimals: number): string {
		const num = Number(val) / (10 ** decimals);
		if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
		if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
		if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
		if (num >= 1) return num.toFixed(2);
		if (num >= 0.001) return num.toFixed(4);
		return num.toFixed(6);
	}

	let chartOption = $derived.by(() => {
		const totalTokens = Number(tokensForCurve) / (10 ** tokenDecimals);
		const sold = Number(tokensSold) / (10 ** tokenDecimals);
		const progressFrac = tokensForCurve > 0n ? Math.max(0, Math.min(1, Number(tokensSold) / Number(tokensForCurve))) : 0;
		const maxY = curveFn(1, curveType);

		// Full curve data — X = tokens sold, Y = price level (normalized 0-100%)
		const curveData: [number, number][] = [];
		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			curveData.push([x * totalTokens, (curveFn(x, curveType) / maxY) * 100]);
		}

		// Filled area up to progress
		const fillData: [number, number][] = [];
		const fillSteps = Math.max(1, Math.round(progressFrac * STEPS));
		for (let i = 0; i <= fillSteps; i++) {
			const x = i / STEPS;
			fillData.push([x * totalTokens, (curveFn(x, curveType) / maxY) * 100]);
		}

		const markerY = (curveFn(progressFrac, curveType) / maxY) * 100;

		return {
			tooltip: {
				trigger: 'axis',
				axisPointer: { type: 'cross', label: { show: false }, crossStyle: { color: 'rgba(16,185,129,0.2)' } },
				formatter: (params: any) => {
					const arr = Array.isArray(params) ? params : [params];
					const p = arr.find((a: any) => a.seriesIndex === 1) || arr[0];
					if (!p?.data) return '';
					const tokens = p.data[0];
					const pricePct = p.data[1];
					return `<div style="font-family:Rajdhani,sans-serif">
						<div style="font-weight:700;margin-bottom:4px">${CURVE_LABELS[curveType]} Curve</div>
						<div>Tokens: <b>${formatNum(BigInt(Math.round(tokens * (10 ** tokenDecimals))), tokenDecimals)}</b></div>
						<div>Price level: <b>${pricePct.toFixed(1)}%</b></div>
					</div>`;
				},
			},
			grid: { top: 30, right: 16, bottom: 36, left: 52 },
			xAxis: {
				type: 'value',
				name: 'Tokens Sold',
				nameLocation: 'center',
				nameGap: 22,
				nameTextStyle: { fontSize: 10, color: '#64748b' },
				min: 0,
				max: totalTokens,
				axisLabel: {
					fontSize: 9,
					formatter: (v: number) => formatNum(BigInt(Math.round(v * (10 ** tokenDecimals))), tokenDecimals),
				},
				splitLine: { show: false },
			},
			yAxis: {
				type: 'value',
				name: 'Price',
				nameLocation: 'center',
				nameGap: 36,
				nameTextStyle: { fontSize: 10, color: '#64748b' },
				min: 0,
				max: 100,
				axisLabel: { formatter: '{value}%', fontSize: 9 },
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
								{ offset: 0, color: 'rgba(16,185,129,0.3)' },
								{ offset: 1, color: 'rgba(16,185,129,0.02)' },
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
						width: 2,
						color: {
							type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [
								{ offset: 0, color: '#10b981' },
								{ offset: 1, color: '#00d2ff' },
							],
						},
						opacity: 0.4,
					},
					z: 2,
					_fixed: true,
				},
				// Active segment (thicker)
				...(progressFrac > 0 ? [{
					type: 'line',
					data: fillData,
					smooth: curveType !== 0,
					symbol: 'none',
					lineStyle: {
						width: 2.5,
						color: {
							type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [
								{ offset: 0, color: '#10b981' },
								{ offset: 1, color: '#00d2ff' },
							],
						},
					},
					z: 3,
					_fixed: true,
				}] : []),
				// Current position marker
				...(progressFrac > 0 ? [{
					type: 'scatter',
					data: [[sold, markerY]],
					symbolSize: 12,
					itemStyle: {
						color: '#10b981',
						borderColor: '#fff',
						borderWidth: 2,
						shadowColor: 'rgba(16,185,129,0.5)',
						shadowBlur: 8,
					},
					tooltip: {
						trigger: 'item',
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700">Current Position</div>
							<div>Sold: <b>${formatNum(tokensSold, tokenDecimals)}</b> / ${formatNum(tokensForCurve, tokenDecimals)}</div>
							<div>Progress: <b>${(progressFrac * 100).toFixed(1)}%</b></div>
							<div>Price level: <b>${markerY.toFixed(1)}%</b></div>
						</div>`,
					},
					z: 4,
					_fixed: true,
				}] : []),
			],
			graphic: [{
				type: 'text',
				left: 'center',
				top: 6,
				style: {
					text: `${CURVE_LABELS[curveType]}${progressFrac > 0 ? ` · ${(progressFrac * 100).toFixed(1)}% sold` : ''}`,
					fill: '#94a3b8',
					fontSize: 11,
					fontFamily: "'Rajdhani', sans-serif",
				},
			}],
		} as any;
	});
</script>

<Chart option={chartOption} {height} />
