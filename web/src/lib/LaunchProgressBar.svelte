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

<div class="w-full">
	{#if raised || hardCap}
		<div class="flex justify-between items-baseline mb-1.5">
			<span class={'font-mono font-bold text-heading ' + (size === 'sm' ? 'text-3xs' : size === 'lg' ? 'text-13' : 'text-xs2')}>Raised {progress < 1 && progress > 0 ? progress.toFixed(1) : Math.round(progress)}%</span>
			{#if hardCap}
				<span class={'font-mono text-dim ' + (size === 'sm' ? 'text-xs4' : size === 'lg' ? 'text-xs2' : 'text-3xs')}>{hardCap}</span>
			{/if}
		</div>
	{/if}
	<div class="relative">
		<div class={'w-full overflow-hidden bg-surface-hover border border-line-subtle ' + (size === 'sm' ? 'h-2 rounded' : size === 'lg' ? 'h-4 rounded-lg' : 'h-3 rounded-md')}>
			<div class={'lp-fill h-full transition-[width] duration-300 ease-[ease] shadow-[0_0_8px_rgba(0,210,255,0.3)] ' + (size === 'sm' ? 'rounded' : size === 'lg' ? 'rounded-lg' : 'rounded-md')} style="width: {progress}%"></div>
		</div>
		{#if softCapPct > 0 && softCapPct < 100}
			<div class="absolute top-0 -translate-x-1/2 flex flex-col items-center pointer-events-none" style="left: {softCapPct}%">
				<div class={'w-0.5 bg-white/40 rounded-[1px] ' + (size === 'sm' ? 'h-2' : size === 'lg' ? 'h-4' : 'h-3')}></div>
				<div class="text-7 font-mono text-white/35 mt-px tracking-[0.03em]">SC</div>
			</div>
		{/if}
	</div>
	{#if raised}
		<div class="flex justify-between mt-1 mb-1 font-mono text-3xs text-dim">
			<span>{raised}{hardCap ? ` / ${hardCap}` : ''}</span>
		</div>
	{/if}
</div>

<style>
	.lp-fill { background: linear-gradient(90deg, #00d2ff, #3a7bd5); }
</style>
