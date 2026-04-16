<script lang="ts">
	import * as echarts from 'echarts';
	import { chartPrefs, type ChartType } from '$lib/chartPrefs.svelte';

	let {
		option,
		height = '240px',
		onclick,
	}: {
		option: echarts.EChartsOption;
		height?: string;
		onclick?: (params: any) => void;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let chart: echarts.ECharts | null = null;

	const DARK_THEME = {
		backgroundColor: 'transparent',
		textStyle: { color: '#94a3b8', fontFamily: "'Rajdhani', sans-serif", fontSize: 11 },
		legend: { textStyle: { color: '#94a3b8', fontSize: 11, fontFamily: "'Rajdhani', sans-serif" } },
		tooltip: {
			backgroundColor: 'rgba(15,23,42,0.95)',
			borderColor: 'rgba(255,255,255,0.1)',
			textStyle: { color: '#e2e8f0', fontSize: 12, fontFamily: "'Rajdhani', sans-serif" }
		},
		grid: { top: 30, right: 12, bottom: 24, left: 48, containLabel: false },
		xAxis: { axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, axisTick: { show: false }, splitLine: { show: false } },
		yAxis: { axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
	};

	/** Switch series types based on global chart preference */
	function applyChartType(opt: echarts.EChartsOption, type: ChartType): echarts.EChartsOption {
		if (!opt.series) return opt;
		const series = Array.isArray(opt.series) ? opt.series : [opt.series];
		const patched = series.map((s: any) => {
			// Only switch line/bar/scatter series — skip pie, gauge, etc.
			if (!['line', 'bar', 'scatter'].includes(s.type)) return s;
			// Skip series explicitly marked as fixed
			if (s._fixed) return s;

			const result = { ...s, type };
			if (type === 'bar') {
				result.barMaxWidth = s.barMaxWidth || 12;
				result.itemStyle = { ...s.itemStyle, borderRadius: [2, 2, 0, 0] };
				delete result.areaStyle;
				delete result.smooth;
			} else if (type === 'scatter') {
				result.symbolSize = s.symbolSize || 6;
				delete result.areaStyle;
				delete result.smooth;
				delete result.barMaxWidth;
			} else if (type === 'line') {
				result.smooth = true;
				delete result.barMaxWidth;
			}
			return result;
		});
		return { ...opt, series: patched };
	}

	/** Add ctrl+scroll zoom + scroll pan for cartesian charts */
	function addDataZoom(opt: echarts.EChartsOption): echarts.EChartsOption {
		// Skip for pie/radar/gauge charts
		const series = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : [];
		const hasCartesian = series.some((s: any) => ['line', 'bar', 'scatter'].includes(s.type));
		if (!hasCartesian) return opt;

		// Don't override if user explicitly set dataZoom
		if (opt.dataZoom) return opt;

		return {
			...opt,
			dataZoom: [
				{ type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: true, moveOnMouseMove: false },
				{ type: 'inside', yAxisIndex: 0, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: false }
			]
		};
	}

	function mergeTheme(opt: echarts.EChartsOption): echarts.EChartsOption {
		const optLegend = (opt.legend as any) || {};
		return addDataZoom({
			...DARK_THEME,
			...opt,
			tooltip: { ...DARK_THEME.tooltip, ...(opt.tooltip as any || {}) },
			grid: { ...DARK_THEME.grid, ...(opt.grid as any || {}) },
			legend: { ...DARK_THEME.legend, ...optLegend, textStyle: { ...(DARK_THEME.legend as any).textStyle, ...optLegend.textStyle } },
			xAxis: { ...DARK_THEME.xAxis, ...(opt.xAxis as any || {}) },
			yAxis: { ...DARK_THEME.yAxis, ...(opt.yAxis as any || {}), splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' }, ...(opt.yAxis as any)?.splitLine } },
		});
	}

	// Init chart once when el is available
	$effect(() => {
		if (!el) return;
		chart = echarts.init(el, undefined, { renderer: 'canvas' });
		if (onclick) chart.on('click', 'series', onclick);

		const ro = new ResizeObserver(() => chart?.resize());
		ro.observe(el);

		return () => {
			ro.disconnect();
			chart?.dispose();
			chart = null;
		};
	});

	// Update chart when option or chartPrefs change (no dispose/reinit)
	$effect(() => {
		if (!chart) return;
		const themed = mergeTheme(option);
		const final = applyChartType(themed, chartPrefs.type);
		chart.setOption(final, true);
	});
</script>

<div bind:this={el} class="w-full" style="height: {height};"></div>
