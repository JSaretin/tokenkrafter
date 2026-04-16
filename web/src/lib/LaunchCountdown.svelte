<script lang="ts">
	let {
		deadline = 0,
		label = 'Sale ends in',
		size = 'md' as 'sm' | 'md' | 'lg',
		variant = 'cyan' as 'cyan' | 'amber',
	}: {
		deadline: number;
		label?: string;
		size?: 'sm' | 'md' | 'lg';
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

	let prevS = $state(-1); let flipS = $state(false);
	let prevM = $state(-1); let flipM = $state(false);
	let prevH = $state(-1); let flipH = $state(false);
	let prevD = $state(-1); let flipD = $state(false);

	$effect(() => { if (s !== prevS) { flipS = true; prevS = s; setTimeout(() => flipS = false, 400); } });
	$effect(() => { if (m !== prevM) { flipM = true; prevM = m; setTimeout(() => flipM = false, 400); } });
	$effect(() => { if (h !== prevH) { flipH = true; prevH = h; setTimeout(() => flipH = false, 400); } });
	$effect(() => { if (d !== prevD) { flipD = true; prevD = d; setTimeout(() => flipD = false, 400); } });
</script>

{#if !ended}
	<div class="lcd lcd-{size} lcd-{variant}">
		{#if label}
			<span class="lcd-label" class:lcd-urgent={urgent} class:lcd-warning={warning}>{label}</span>
		{/if}
		<div class="lcd-grid">
			{#each [
				{ val: pad(d), flip: flipD, unit: size === 'sm' ? 'd' : 'DAYS' },
				{ val: pad(h), flip: flipH, unit: size === 'sm' ? 'h' : 'HRS' },
				{ val: pad(m), flip: flipM, unit: size === 'sm' ? 'm' : 'MIN' },
				{ val: pad(s), flip: flipS, unit: size === 'sm' ? 's' : 'SEC' },
			] as item, i}
				{#if i > 0}<div class="lcd-sep">:</div>{/if}
				<div class="lcd-col">
					<div class="lcd-card" class:lcd-tick={item.flip}>
						<span class="lcd-num">{item.val}</span>
						<div class="lcd-line"></div>
					</div>
					<span class="lcd-unit">{item.unit}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.lcd { width: 100%; }
	.lcd-label {
		display: block; text-align: center; margin-bottom: 8px;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.08em;
	}
	.lcd-cyan .lcd-label { color: #00d2ff; }
	.lcd-amber .lcd-label { color: #f59e0b; }
	.lcd-warning { color: #fbbf24 !important; }
	.lcd-urgent { color: #f87171 !important; animation: urgentPulse 1.5s ease-in-out infinite; }

	.lcd-grid {
		display: grid;
		grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr;
		align-items: start;
	}
	.lcd-sep {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-dim); text-align: center; opacity: 0.3;
	}
	.lcd-col {
		display: flex; flex-direction: column; align-items: center;
	}
	.lcd-unit {
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim);
	}

	/* Card */
	.lcd-card {
		position: relative;
		display: flex; align-items: center; justify-content: center;
		border-radius: 6px;
	}
	.lcd-cyan .lcd-card {
		background: linear-gradient(180deg, rgba(0,210,255,0.08) 0%, rgba(0,210,255,0.02) 100%);
		border: 1px solid rgba(0,210,255,0.12);
	}
	.lcd-amber .lcd-card {
		background: linear-gradient(180deg, rgba(245,158,11,0.08) 0%, rgba(245,158,11,0.02) 100%);
		border: 1px solid rgba(245,158,11,0.12);
	}

	/* Horizontal split line */
	.lcd-line {
		position: absolute; left: 2px; right: 2px; top: 50%;
		height: 1px; background: var(--bg, #07070d); opacity: 0.2;
		pointer-events: none;
	}

	.lcd-num {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-heading); font-variant-numeric: tabular-nums;
		line-height: 1; position: relative; z-index: 1;
	}
	.lcd-amber .lcd-num { color: #f59e0b; }

	/* Tick animation — card flips down then back up */
	.lcd-tick {
		animation: tick 0.4s ease-in-out;
	}

	/* ── Sizes ── */
	.lcd-sm .lcd-grid { gap: 2px; }
	.lcd-sm .lcd-card { width: 26px; height: 28px; border-radius: 4px; }
	.lcd-sm .lcd-num { font-size: 16px; }
	.lcd-sm .lcd-unit { font-size: 5px; margin-top: 1px; }
	.lcd-sm .lcd-sep { font-size: 10px; margin-top: 8px; }
	.lcd-sm .lcd-label { font-size: 7px; margin-bottom: 4px; }

	.lcd-md .lcd-grid { gap: 3px; }
	.lcd-md .lcd-card { width: 36px; height: 40px; border-radius: 6px; }
	.lcd-md .lcd-num { font-size: 22px; }
	.lcd-md .lcd-unit { font-size: 6px; margin-top: 2px; }
	.lcd-md .lcd-sep { font-size: 14px; margin-top: 12px; }
	.lcd-md .lcd-label { font-size: 8px; }

	.lcd-lg .lcd-grid { gap: 8px; }
	.lcd-lg .lcd-card { width: 52px; height: 56px; border-radius: 8px; }
	.lcd-lg .lcd-num { font-size: 32px; }
	.lcd-lg .lcd-unit { font-size: 8px; margin-top: 3px; }
	.lcd-lg .lcd-sep { font-size: 22px; margin-top: 16px; }
	.lcd-lg .lcd-label { font-size: 10px; margin-bottom: 10px; }

	@keyframes tick {
		0% { transform: perspective(200px) rotateX(0deg); }
		50% { transform: perspective(200px) rotateX(-30deg) scale(0.97); }
		100% { transform: perspective(200px) rotateX(0deg); }
	}

	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
