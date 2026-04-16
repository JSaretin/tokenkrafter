<script lang="ts">
	import Chart from '$lib/Chart.svelte';

	let {
		curveType = 0,
		tokensForCurve = 0n,
		tokensSold = 0n,
		currentPrice = 0n,
		softCap = 0n,
		hardCap = 0n,
		totalBaseRaised = 0n,
		userBasePaid = 0n,
		userTokensBought = 0n,
		tokenDecimals = 18,
		usdtDecimals = 18,
		height = '180px'
	}: {
		curveType?: number;
		tokensForCurve?: bigint;
		tokensSold?: bigint;
		currentPrice?: bigint;
		softCap?: bigint;
		hardCap?: bigint;
		totalBaseRaised?: bigint;
		userBasePaid?: bigint;
		userTokensBought?: bigint;
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

	function fmtNum(val: bigint, decimals: number): string {
		const num = Number(val) / (10 ** decimals);
		if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
		if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
		if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
		if (num >= 1) return num.toFixed(2);
		if (num >= 0.001) return num.toFixed(4);
		return num.toFixed(6);
	}

	function fmtUsd(val: number): string {
		if (val >= 1e6) return '$' + (val / 1e6).toFixed(1) + 'M';
		if (val >= 1e3) return '$' + (val / 1e3).toFixed(1) + 'K';
		if (val >= 1) return '$' + val.toFixed(2);
		if (val >= 0.01) return '$' + val.toFixed(4);
		if (val >= 0.0001) return '$' + val.toFixed(6);
		return '$' + val.toFixed(8);
	}

	let chartOption = $derived.by(() => {
		const totalTokens = Number(tokensForCurve) / (10 ** tokenDecimals);
		const sold = Number(tokensSold) / (10 ** tokenDecimals);
		const progressFrac = tokensForCurve > 0n ? Math.max(0, Math.min(1, Number(tokensSold) / Number(tokensForCurve))) : 0;
		const maxCurveY = curveFn(1, curveType);
		const curPriceNum = Number(currentPrice) / (10 ** usdtDecimals);
		const hardCapNum = Number(hardCap) / (10 ** usdtDecimals);

		// Compute max price from the curve endpoint and current price
		const maxPrice = curPriceNum > 0 && progressFrac > 0
			? curPriceNum / (curveFn(progressFrac, curveType) / maxCurveY)
			: hardCapNum / totalTokens * 2;

		// Auto-scale Y axis
		const peekFrac = Math.min(1, progressFrac + 0.3);
		const peekPrice = maxPrice * (curveFn(peekFrac, curveType) / maxCurveY);
		const yMaxPrice = progressFrac < 0.5
			? Math.max(curPriceNum * 3, peekPrice * 1.3)
			: maxPrice * 1.05;

		// Price curve data (Y = actual USDT price)
		const curveData: [number, number][] = [];
		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			const price = maxPrice * (curveFn(x, curveType) / maxCurveY);
			curveData.push([x * totalTokens, price]);
		}

		// Filled area up to current progress
		const fillData: [number, number][] = [];
		const fillSteps = Math.max(1, Math.round(progressFrac * STEPS));
		for (let i = 0; i <= fillSteps; i++) {
			const x = i / STEPS;
			const price = maxPrice * (curveFn(x, curveType) / maxCurveY);
			fillData.push([x * totalTokens, price]);
		}

		// User's average price
		const userAvgPrice = userTokensBought > 0n
			? Number(userBasePaid) / Number(userTokensBought)
			: 0;

		// Soft cap position on the curve
		const scFrac = hardCap > 0n ? Math.min(1, Number(softCap) / Number(hardCap)) : 0;
		const scTokens = scFrac * totalTokens;
		const scPrice = maxPrice * (curveFn(scFrac, curveType) / maxCurveY);

		return {
			tooltip: {
				trigger: 'axis',
				axisPointer: { type: 'cross', label: { show: false }, crossStyle: { color: 'rgba(16,185,129,0.2)' } },
				formatter: (params: any) => {
					const arr = Array.isArray(params) ? params : [params];
					const p = arr.find((a: any) => a.seriesIndex === 1) || arr[0];
					if (!p?.data) return '';
					const tokens = p.data[0];
					const price = p.data[1];
					return `<div style="font-family:Rajdhani,sans-serif">
						<div style="font-weight:700;margin-bottom:4px">${CURVE_LABELS[curveType]} Curve</div>
						<div>Tokens: <b>${fmtNum(BigInt(Math.round(tokens * (10 ** tokenDecimals))), tokenDecimals)}</b></div>
						<div>Price: <b>${fmtUsd(price)}</b></div>
					</div>`;
				},
			},
			grid: { top: 30, right: 8, bottom: 32, left: 50 },
			xAxis: {
				type: 'value',
				name: 'Tokens Sold',
				nameLocation: 'center',
				nameGap: 22,
				nameTextStyle: { fontSize: 10, color: '#94a3b8' },
				min: 0,
				max: totalTokens,
				axisLabel: {
					fontSize: 9, color: '#94a3b8',
					formatter: (v: number) => fmtNum(BigInt(Math.round(v * (10 ** tokenDecimals))), tokenDecimals),
				},
				axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
				splitLine: { show: false },
			},
			yAxis: {
				type: 'value',
				name: 'Price (USDT)',
				nameLocation: 'center',
				nameGap: 42,
				nameTextStyle: { fontSize: 10, color: '#94a3b8' },
				min: 0,
				max: yMaxPrice,
				axisLabel: {
					fontSize: 9, color: '#94a3b8',
					formatter: (v: number) => fmtUsd(v),
				},
				axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
				splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
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
								{ offset: 0, color: 'rgba(16,185,129,0.25)' },
								{ offset: 1, color: 'rgba(16,185,129,0.02)' },
							],
						},
					},
					z: 1,
				},
				// Full curve line (dimmed)
				{
					type: 'line',
					data: curveData,
					smooth: curveType !== 0,
					symbol: 'none',
					lineStyle: {
						width: 2,
						color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [{ offset: 0, color: '#10b981' }, { offset: 1, color: '#00d2ff' }],
						},
						opacity: 0.35,
					},
					z: 2,
				},
				// Active curve segment (bright)
				...(progressFrac > 0 ? [{
					type: 'line',
					data: fillData,
					smooth: curveType !== 0,
					symbol: 'none',
					lineStyle: {
						width: 2.5,
						color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [{ offset: 0, color: '#10b981' }, { offset: 1, color: '#00d2ff' }],
						},
					},
					z: 3,
				}] : []),
				// Soft cap marker
				...(scFrac > 0 && scFrac < 1 ? [{
					type: 'scatter',
					data: [[scTokens, scPrice]],
					symbolSize: 8,
					itemStyle: { color: '#f59e0b', borderColor: '#fff', borderWidth: 1.5 },
					tooltip: {
						trigger: 'item' as const,
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700;color:#f59e0b">Soft Cap</div>
							<div>${fmtUsd(Number(softCap) / (10 ** usdtDecimals))}</div>
						</div>`,
					},
					z: 4,
				}] : []),
				// Current position marker
				...(progressFrac > 0 ? [{
					type: 'scatter',
					data: [[sold, curPriceNum]],
					symbolSize: 12,
					itemStyle: {
						color: '#10b981', borderColor: '#fff', borderWidth: 2,
						shadowColor: 'rgba(16,185,129,0.5)', shadowBlur: 8,
					},
					tooltip: {
						trigger: 'item' as const,
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700">Current Price</div>
							<div>${fmtUsd(curPriceNum)}</div>
							<div>Sold: ${fmtNum(tokensSold, tokenDecimals)} tokens</div>
						</div>`,
					},
					z: 5,
				}] : []),
				// User average price marker
				...(userAvgPrice > 0 ? [{
					type: 'scatter',
					data: [[sold, userAvgPrice]],
					symbolSize: 10,
					symbol: 'diamond',
					itemStyle: {
						color: '#a78bfa', borderColor: '#fff', borderWidth: 1.5,
						shadowColor: 'rgba(139,92,246,0.5)', shadowBlur: 6,
					},
					tooltip: {
						trigger: 'item' as const,
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700;color:#a78bfa">Your Avg Price</div>
							<div>${fmtUsd(userAvgPrice)}</div>
							<div>Spent: ${fmtUsd(Number(userBasePaid) / (10 ** usdtDecimals))}</div>
							<div>Tokens: ${fmtNum(userTokensBought, tokenDecimals)}</div>
						</div>`,
					},
					z: 6,
				}] : []),
			],
			graphic: [{
				type: 'text',
				left: 'center',
				top: 6,
				style: {
					text: `${CURVE_LABELS[curveType]}${progressFrac > 0 ? ` · ${(progressFrac * 100).toFixed(1)}% tokens sold` : ''}`,
					fill: '#94a3b8',
					fontSize: 11,
					fontFamily: "'Rajdhani', sans-serif",
				},
			}],
		} as any;
	});
</script>

<Chart option={chartOption} {height} />
