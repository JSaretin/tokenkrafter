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

	// Flip triggers
	let prevS = $state(-1); let prevM = $state(-1); let prevH = $state(-1); let prevD = $state(-1);
	let flipS = $state(false); let flipM = $state(false); let flipH = $state(false); let flipD = $state(false);

	$effect(() => { if (s !== prevS) { flipS = true; prevS = s; setTimeout(() => flipS = false, 500); } });
	$effect(() => { if (m !== prevM) { flipM = true; prevM = m; setTimeout(() => flipM = false, 500); } });
	$effect(() => { if (h !== prevH) { flipH = true; prevH = h; setTimeout(() => flipH = false, 500); } });
	$effect(() => { if (d !== prevD) { flipD = true; prevD = d; setTimeout(() => flipD = false, 500); } });
</script>

{#if !ended}
	<div class="lcd lcd-{size} lcd-{variant}">
		{#if label}
			<span class="lcd-label" class:lcd-urgent={urgent} class:lcd-warning={warning}>{label}</span>
		{/if}
		<div class="lcd-grid">
			<div class="lcd-box" class:lcd-flipping={flipD}>
				<div class="lcd-card">
					<span class="lcd-num">{pad(d)}</span>
				</div>
				<span class="lcd-unit">{size === 'sm' ? 'd' : 'Days'}</span>
			</div>
			<div class="lcd-sep">:</div>
			<div class="lcd-box" class:lcd-flipping={flipH}>
				<div class="lcd-card">
					<span class="lcd-num">{pad(h)}</span>
				</div>
				<span class="lcd-unit">{size === 'sm' ? 'h' : 'Hrs'}</span>
			</div>
			<div class="lcd-sep">:</div>
			<div class="lcd-box" class:lcd-flipping={flipM}>
				<div class="lcd-card">
					<span class="lcd-num">{pad(m)}</span>
				</div>
				<span class="lcd-unit">{size === 'sm' ? 'm' : 'Min'}</span>
			</div>
			<div class="lcd-sep">:</div>
			<div class="lcd-box" class:lcd-flipping={flipS}>
				<div class="lcd-card">
					<span class="lcd-num">{pad(s)}</span>
				</div>
				<span class="lcd-unit">{size === 'sm' ? 's' : 'Sec'}</span>
			</div>
		</div>
	</div>
{/if}

<style>
	.lcd { width: 100%; }

	.lcd-label {
		display: block; text-align: center; margin-bottom: 6px;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.06em;
	}
	.lcd-cyan .lcd-label { color: #00d2ff; }
	.lcd-amber .lcd-label { color: #f59e0b; }
	.lcd-warning { color: #fbbf24 !important; }
	.lcd-urgent { color: #f87171 !important; animation: urgentPulse 1.5s ease-in-out infinite; }

	.lcd-grid {
		display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr;
		align-items: center;
	}

	.lcd-sep {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-dim); text-align: center; line-height: 1;
		opacity: 0.4; padding-bottom: 12px;
	}

	.lcd-box {
		display: flex; flex-direction: column; align-items: center; gap: 4px;
		perspective: 300px;
	}

	/* The flippable card */
	.lcd-card {
		display: flex; align-items: center; justify-content: center;
		border-radius: 8px;
		transform-style: preserve-3d;
		transform-origin: center bottom;
		transition: transform 0.15s ease-in;
	}
	.lcd-cyan .lcd-card {
		background: linear-gradient(180deg, rgba(0,210,255,0.1) 0%, rgba(0,210,255,0.03) 100%);
		border: 1px solid rgba(0,210,255,0.12);
		box-shadow: 0 2px 8px rgba(0,210,255,0.06);
	}
	.lcd-amber .lcd-card {
		background: linear-gradient(180deg, rgba(245,158,11,0.1) 0%, rgba(245,158,11,0.03) 100%);
		border: 1px solid rgba(245,158,11,0.12);
		box-shadow: 0 2px 8px rgba(245,158,11,0.06);
	}

	/* Flip animation on the card */
	.lcd-flipping .lcd-card {
		animation: cardFlip 0.5s ease-out;
	}

	.lcd-num {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-heading); line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.lcd-amber .lcd-num { color: #f59e0b; }

	.lcd-unit {
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-dim);
	}

	/* ── Size: sm ── */
	.lcd-sm .lcd-label { font-size: 8px; margin-bottom: 4px; }
	.lcd-sm .lcd-grid { gap: 2px; }
	.lcd-sm .lcd-card { padding: 4px 6px; border-radius: 5px; }
	.lcd-sm .lcd-box { gap: 1px; }
	.lcd-sm .lcd-num { font-size: 14px; }
	.lcd-sm .lcd-unit { font-size: 6px; }
	.lcd-sm .lcd-sep { font-size: 10px; padding-bottom: 6px; }

	/* ── Size: md ── */
	.lcd-md .lcd-label { font-size: 9px; }
	.lcd-md .lcd-grid { gap: 3px; }
	.lcd-md .lcd-card { padding: 8px 10px; }
	.lcd-md .lcd-box { gap: 2px; }
	.lcd-md .lcd-num { font-size: 20px; }
	.lcd-md .lcd-unit { font-size: 7px; }
	.lcd-md .lcd-sep { font-size: 14px; padding-bottom: 10px; }

	/* ── Size: lg ── */
	.lcd-lg .lcd-label { font-size: 10px; margin-bottom: 8px; }
	.lcd-lg .lcd-grid { gap: 6px; }
	.lcd-lg .lcd-card { padding: 12px 14px; border-radius: 10px; }
	.lcd-lg .lcd-box { gap: 4px; }
	.lcd-lg .lcd-num { font-size: 30px; }
	.lcd-lg .lcd-unit { font-size: 9px; }
	.lcd-lg .lcd-sep { font-size: 20px; padding-bottom: 14px; }

	@keyframes cardFlip {
		0% { transform: rotateX(0deg); }
		30% { transform: rotateX(-90deg); }
		60% { transform: rotateX(10deg); }
		80% { transform: rotateX(-3deg); }
		100% { transform: rotateX(0deg); }
	}

	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
