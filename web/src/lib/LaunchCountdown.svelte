<script lang="ts">
	let {
		deadline = 0,
		label = 'Sale ends in',
		size = 'md' as 'sm' | 'md' | 'lg' | 'inline',
		variant = 'cyan' as 'cyan' | 'amber',
	}: {
		deadline: number;
		label?: string;
		size?: 'sm' | 'md' | 'lg' | 'inline';
		variant?: 'cyan' | 'amber';
	} = $props();

	let tickNow = $state(Date.now());
	let interval: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		interval = setInterval(() => { tickNow = Date.now(); }, 1000);
		return () => { if (interval) clearInterval(interval); };
	});

	let ms = $derived(deadline * 1000 - tickNow);
	let ended = $derived(ms <= 0);
	let d = $derived(Math.floor(Math.max(0, ms) / 86400000));
	let h = $derived(Math.floor((Math.max(0, ms) % 86400000) / 3600000));
	let m = $derived(Math.floor((Math.max(0, ms) % 3600000) / 60000));
	let s = $derived(Math.floor((Math.max(0, ms) % 60000) / 1000));
	let urgent = $derived(ms > 0 && ms < 900000);
	let warning = $derived(ms > 0 && ms >= 900000 && ms < 3600000);
	let pad = (n: number) => String(n).padStart(2, '0');
</script>

{#if !ended}
	{#if size === 'inline'}
		<span class={'font-numeric font-bold whitespace-nowrap ' + (urgent ? 'text-[#f87171] lcd-urgent' : warning ? 'text-[#fbbf24]' : variant === 'cyan' ? 'text-[#00d2ff]' : 'text-[#f59e0b]')}>
			{d > 0 ? `${pad(d)}d ` : ''}{pad(h)}:{pad(m)}:{pad(s)}
		</span>
	{:else}
		<div class={'w-full lcd-' + variant + ' lcd-' + size}>
			{#if label}
				<span class={'block text-center mb-1.5 font-mono uppercase tracking-[0.06em] ' + (size === 'sm' ? 'text-[8px] mb-1' : size === 'lg' ? 'text-[10px] mb-2' : 'text-[9px]') + ' ' + (urgent ? 'text-[#f87171] lcd-urgent' : warning ? 'text-[#fbbf24]' : variant === 'cyan' ? 'text-[#00d2ff]' : 'text-[#f59e0b]')}>{label}</span>
			{/if}
			<div class={'grid grid-cols-4 ' + (size === 'sm' ? 'gap-[3px]' : size === 'lg' ? 'gap-2' : 'gap-1')}>
				<div class={'lcd-box flex flex-col items-center rounded-lg ' + (size === 'sm' ? 'px-0.5 py-1 gap-px' : size === 'lg' ? 'px-1 py-2.5 gap-1' : 'px-0.5 py-1.5 gap-0.5')}>
					<span class={'lcd-num font-numeric font-bold text-heading leading-none ' + (size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-[28px]' : 'text-lg')}>{pad(d)}</span>
					<span class={'font-mono uppercase tracking-[0.06em] text-dim ' + (size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]')}>{size === 'sm' ? 'd' : 'Days'}</span>
				</div>
				<div class={'lcd-box flex flex-col items-center rounded-lg ' + (size === 'sm' ? 'px-0.5 py-1 gap-px' : size === 'lg' ? 'px-1 py-2.5 gap-1' : 'px-0.5 py-1.5 gap-0.5')}>
					<span class={'lcd-num font-numeric font-bold text-heading leading-none ' + (size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-[28px]' : 'text-lg')}>{pad(h)}</span>
					<span class={'font-mono uppercase tracking-[0.06em] text-dim ' + (size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]')}>{size === 'sm' ? 'h' : 'Hrs'}</span>
				</div>
				<div class={'lcd-box flex flex-col items-center rounded-lg ' + (size === 'sm' ? 'px-0.5 py-1 gap-px' : size === 'lg' ? 'px-1 py-2.5 gap-1' : 'px-0.5 py-1.5 gap-0.5')}>
					<span class={'lcd-num font-numeric font-bold text-heading leading-none ' + (size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-[28px]' : 'text-lg')}>{pad(m)}</span>
					<span class={'font-mono uppercase tracking-[0.06em] text-dim ' + (size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]')}>{size === 'sm' ? 'm' : 'Min'}</span>
				</div>
				<div class={'lcd-box flex flex-col items-center rounded-lg ' + (size === 'sm' ? 'px-0.5 py-1 gap-px' : size === 'lg' ? 'px-1 py-2.5 gap-1' : 'px-0.5 py-1.5 gap-0.5')}>
					<span class={'lcd-num font-numeric font-bold text-heading leading-none ' + (size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-[28px]' : 'text-lg')}>{pad(s)}</span>
					<span class={'font-mono uppercase tracking-[0.06em] text-dim ' + (size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]')}>{size === 'sm' ? 's' : 'Sec'}</span>
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	.lcd-cyan .lcd-box {
		background: linear-gradient(135deg, rgba(0, 210, 255, 0.06), rgba(139, 92, 246, 0.06));
		border: 1px solid rgba(0, 210, 255, 0.1);
	}
	.lcd-amber .lcd-box {
		background: linear-gradient(135deg, rgba(245, 158, 11, 0.06), rgba(217, 119, 6, 0.06));
		border: 1px solid rgba(245, 158, 11, 0.12);
	}
	.lcd-amber .lcd-num { color: #f59e0b; }

	.lcd-urgent { animation: urgentPulse 1.5s ease-in-out infinite; }
	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
