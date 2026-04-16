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

	// Cumulative integral of the curve (area under price curve = total raised)
	function curveIntegral(x: number, type: number): number {
		switch (type) {
			case 0: return x * x / 2;
			case 1: return (2 / 3) * Math.pow(x, 1.5);
			case 2: return x * x * x / 3;
			case 3: {
				const k = 3;
				const norm = Math.E ** k - 1;
				return ((Math.exp(k * x) / k) - x) / norm;
			}
			default: return x * x / 2;
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
		const raisedNum = Number(totalBaseRaised) / (10 ** usdtDecimals);

		// Derive max price from current price + progress
		const curveFracAtProgress = curveFn(progressFrac, curveType) / maxCurveY;
		let maxPrice: number;
		if (curPriceNum > 0 && curveFracAtProgress > 1e-12) {
			maxPrice = curPriceNum / curveFracAtProgress;
		} else if (totalTokens > 0) {
			maxPrice = hardCapNum / totalTokens * 2;
		} else {
			maxPrice = 1;
		}
		if (!Number.isFinite(maxPrice) || maxPrice <= 0) maxPrice = 1;

		// Total raised at 100% = hardCap (the contract enforces this)
		const integralAt1 = curveIntegral(1, curveType);
		const totalUsdtAt100 = hardCapNum > 0 ? hardCapNum : 100;

		// Y axis scales to fit the full curve
		const yMaxPrice = maxPrice * 1.1;
		const yMaxRaised = totalUsdtAt100 * 1.1;

		// Build curve data
		const priceData: [number, number][] = [];
		const raisedData: [number, number][] = [];
		const priceFillData: [number, number][] = [];
		const fillSteps = Math.max(1, Math.round(progressFrac * STEPS));

		for (let i = 0; i <= STEPS; i++) {
			const x = i / STEPS;
			const tokens = x * totalTokens;
			const price = maxPrice * (curveFn(x, curveType) / maxCurveY);
			const raised = totalUsdtAt100 * (curveIntegral(x, curveType) / integralAt1);
			priceData.push([tokens, price]);
			raisedData.push([tokens, raised]);
			if (i <= fillSteps) priceFillData.push([tokens, price]);
		}

		// User average price
		const userAvgPrice = userTokensBought > 0n
			? Number(userBasePaid) / Number(userTokensBought)
			: 0;

		// Soft cap position
		const scFrac = hardCap > 0n ? Math.min(1, Number(softCap) / Number(hardCap)) : 0;
		const scTokens = scFrac * totalTokens;
		const scPrice = maxPrice * (curveFn(scFrac, curveType) / maxCurveY);

		return {
			tooltip: {
				trigger: 'axis',
				axisPointer: { type: 'cross', label: { show: false }, crossStyle: { color: 'rgba(16,185,129,0.15)' } },
				formatter: (params: any) => {
					const arr = Array.isArray(params) ? params : [params];
					let html = `<div style="font-family:Rajdhani,sans-serif">`;
					// Find price and raised values
					const pricePt = arr.find((a: any) => a.seriesName === 'Token Price');
					const raisedPt = arr.find((a: any) => a.seriesName === 'USDT Raised');
					if (pricePt?.data) {
						html += `<div>Tokens: <b>${fmtNum(BigInt(Math.round(pricePt.data[0] * (10 ** tokenDecimals))), tokenDecimals)}</b></div>`;
						html += `<div style="color:#00d2ff">Price: <b>${fmtUsd(pricePt.data[1])}</b></div>`;
					}
					if (raisedPt?.data) {
						html += `<div style="color:#f59e0b">Raised: <b>${fmtUsd(raisedPt.data[1])}</b></div>`;
					}
					html += '</div>';
					return html;
				},
			},
			legend: {
				show: true,
				top: 4,
				right: 8,
				textStyle: { fontSize: 10, color: '#94a3b8', fontFamily: "'Space Mono', monospace" },
				itemWidth: 12,
				itemHeight: 8,
				itemGap: 12,
				selected: { 'Token Price': true, 'USDT Raised': true },
			},
			grid: { top: 30, right: 50, bottom: 32, left: 50 },
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
			yAxis: [
				{
					type: 'value',
					name: 'Price',
					nameLocation: 'center',
					nameGap: 42,
					nameTextStyle: { fontSize: 10, color: '#00d2ff' },
					min: 0,
					max: yMaxPrice,
					axisLabel: { fontSize: 9, color: '#64748b', formatter: (v: number) => fmtUsd(v) },
					axisLine: { lineStyle: { color: 'rgba(0,210,255,0.2)' } },
					splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
				},
				{
					type: 'value',
					name: 'Raised',
					nameLocation: 'center',
					nameGap: 42,
					nameTextStyle: { fontSize: 10, color: '#f59e0b' },
					min: 0,
					max: yMaxRaised,
					axisLabel: { fontSize: 9, color: '#64748b', formatter: (v: number) => fmtUsd(v) },
					axisLine: { lineStyle: { color: 'rgba(245,158,11,0.2)' } },
					splitLine: { show: false },
				},
			],
			series: [
				// Price fill area
				{
					name: 'Token Price',
					type: 'line',
					data: priceFillData,
					smooth: curveType !== 0,
					symbol: 'none',
					yAxisIndex: 0,
					lineStyle: { width: 0 },
					areaStyle: {
						color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: 'rgba(0,210,255,0.2)' },
								{ offset: 1, color: 'rgba(0,210,255,0.01)' },
							],
						},
					},
					z: 1,
				},
				// Price curve (full, dimmed)
				{
					name: 'Token Price',
					type: 'line',
					data: priceData,
					smooth: curveType !== 0,
					symbol: 'none',
					yAxisIndex: 0,
					lineStyle: {
						width: 2, opacity: 0.3,
						color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [{ offset: 0, color: '#3a7bd5' }, { offset: 1, color: '#00d2ff' }],
						},
					},
					z: 2,
				},
				// Price curve (active segment, bright)
				...(progressFrac > 0 ? [{
					name: 'Token Price',
					type: 'line',
					data: priceFillData,
					smooth: curveType !== 0,
					symbol: 'none',
					yAxisIndex: 0,
					lineStyle: {
						width: 2.5,
						color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
							colorStops: [{ offset: 0, color: '#3a7bd5' }, { offset: 1, color: '#00d2ff' }],
						},
					},
					z: 3,
				}] : []),
				// USDT Raised curve
				{
					name: 'USDT Raised',
					type: 'line',
					data: raisedData,
					smooth: true,
					symbol: 'none',
					yAxisIndex: 1,
					lineStyle: {
						width: 2, type: 'dashed', opacity: 0.6,
						color: '#f59e0b',
					},
					z: 2,
				},
				// Soft cap marker
				...(scFrac > 0 && scFrac < 1 ? [{
					name: 'Soft Cap',
					type: 'scatter',
					data: [[scTokens, scPrice]],
					symbolSize: 8,
					yAxisIndex: 0,
					itemStyle: { color: '#f59e0b', borderColor: '#fff', borderWidth: 1.5 },
					tooltip: {
						trigger: 'item' as const,
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700;color:#f59e0b">Soft Cap</div>
							<div>${fmtUsd(Number(softCap) / (10 ** usdtDecimals))}</div>
						</div>`,
					},
					z: 5,
				}] : []),
				// Current price marker
				...(progressFrac > 0 ? [{
					name: 'Current',
					type: 'scatter',
					data: [[sold, curPriceNum]],
					symbolSize: 12,
					yAxisIndex: 0,
					itemStyle: {
						color: '#10b981', borderColor: '#fff', borderWidth: 2,
						shadowColor: 'rgba(16,185,129,0.5)', shadowBlur: 8,
					},
					tooltip: {
						trigger: 'item' as const,
						formatter: () => `<div style="font-family:Rajdhani,sans-serif">
							<div style="font-weight:700">Current Price</div>
							<div>${fmtUsd(curPriceNum)}</div>
							<div>Raised: ${fmtUsd(raisedNum)}</div>
						</div>`,
					},
					z: 6,
				}] : []),
				// User average price marker
				...(userAvgPrice > 0 ? [{
					name: 'Your Avg',
					type: 'scatter',
					data: [[sold, userAvgPrice]],
					symbolSize: 10,
					symbol: 'diamond',
					yAxisIndex: 0,
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
					z: 7,
				}] : []),
			],
			graphic: [],
		} as any;
	});
</script>

<Chart option={chartOption} {height} />
