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

	// Previous values for the flip-out layer
	let prevD = $state('00'); let prevH = $state('00'); let prevM = $state('00'); let prevS = $state('00');
	let flipD = $state(false); let flipH = $state(false); let flipM = $state(false); let flipS = $state(false);

	function triggerFlip(getter: () => string, prev: string, setPrev: (v: string) => void, setFlip: (v: boolean) => void) {
		const cur = getter();
		if (cur !== prev) {
			setFlip(true);
			setTimeout(() => { setPrev(cur); setFlip(false); }, 600);
		}
	}

	$effect(() => { triggerFlip(() => pad(s), prevS, v => prevS = v, v => flipS = v); });
	$effect(() => { triggerFlip(() => pad(m), prevM, v => prevM = v, v => flipM = v); });
	$effect(() => { triggerFlip(() => pad(h), prevH, v => prevH = v, v => flipH = v); });
	$effect(() => { triggerFlip(() => pad(d), prevD, v => prevD = v, v => flipD = v); });
</script>

{#if !ended}
	<div class="lcd lcd-{size} lcd-{variant}">
		{#if label}
			<span class="lcd-label" class:lcd-urgent={urgent} class:lcd-warning={warning}>{label}</span>
		{/if}
		<div class="lcd-grid">
			{#each [
				{ cur: pad(d), prev: prevD, flip: flipD, unit: size === 'sm' ? 'd' : 'Days' },
				{ cur: pad(h), prev: prevH, flip: flipH, unit: size === 'sm' ? 'h' : 'Hrs' },
				{ cur: pad(m), prev: prevM, flip: flipM, unit: size === 'sm' ? 'm' : 'Min' },
				{ cur: pad(s), prev: prevS, flip: flipS, unit: size === 'sm' ? 's' : 'Sec' },
			] as item, i}
				{#if i > 0}<div class="lcd-sep">:</div>{/if}
				<div class="lcd-col">
					<div class="flap">
						<!-- Static bottom half: shows NEW number -->
						<div class="flap-face flap-bottom">
							<span class="flap-num">{item.cur}</span>
						</div>
						<!-- Static top half: shows NEW number -->
						<div class="flap-face flap-top">
							<span class="flap-num">{item.cur}</span>
						</div>
						<!-- Animated top flap: shows OLD number, flips down -->
						{#if item.flip}
							<div class="flap-face flap-top flap-fold-top">
								<span class="flap-num">{item.prev}</span>
							</div>
							<!-- Animated bottom flap: shows NEW number, folds up from behind -->
							<div class="flap-face flap-bottom flap-fold-bottom">
								<span class="flap-num">{item.cur}</span>
							</div>
						{/if}
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
		align-items: start;
	}
	.lcd-sep {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-dim); text-align: center; opacity: 0.4;
	}
	.lcd-col {
		display: flex; flex-direction: column; align-items: center;
	}
	.lcd-unit {
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-dim);
	}

	/* ── Split-flap card ── */
	.flap {
		position: relative; overflow: hidden; border-radius: 6px;
	}
	.lcd-cyan .flap { background: rgba(0,210,255,0.06); border: 1px solid rgba(0,210,255,0.1); }
	.lcd-amber .flap { background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.1); }

	.flap-face {
		display: flex; align-items: center; justify-content: center;
		overflow: hidden; backface-visibility: hidden;
	}
	.flap-num {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text-heading); font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.lcd-amber .flap-num { color: #f59e0b; }

	/* Top half clips bottom, bottom half clips top */
	.flap-top {
		position: absolute; top: 0; left: 0; right: 0; height: 50%;
	}
	.flap-top .flap-num { position: relative; top: 35%; }
	.flap-bottom {
		position: relative; width: 100%; height: 100%;
	}

	/* Divider line */
	.flap::after {
		content: ''; position: absolute; left: 0; right: 0; top: 50%;
		height: 1px; background: var(--bg, #07070d); opacity: 0.3; z-index: 5;
	}

	/* ── Animated flaps ── */
	.flap-fold-top {
		z-index: 10;
		transform-origin: center bottom;
		animation: flapDown 0.3s ease-in forwards;
	}
	.flap-fold-bottom {
		z-index: 8; top: 50%; height: 50%;
		transform-origin: center top;
		animation: flapUp 0.3s 0.15s ease-out forwards;
		transform: rotateX(90deg);
	}
	.flap-fold-bottom .flap-num { position: relative; top: -35%; }

	/* ── Sizes ── */
	.lcd-sm .lcd-grid { gap: 2px; }
	.lcd-sm .flap { width: 28px; height: 28px; border-radius: 4px; }
	.lcd-sm .flap-num { font-size: 16px; }
	.lcd-sm .lcd-unit { font-size: 6px; margin-top: 1px; }
	.lcd-sm .lcd-sep { font-size: 10px; margin-top: 6px; }
	.lcd-sm .lcd-label { font-size: 8px; margin-bottom: 4px; }

	.lcd-md .lcd-grid { gap: 3px; }
	.lcd-md .flap { width: 38px; height: 38px; border-radius: 6px; }
	.lcd-md .flap-num { font-size: 22px; }
	.lcd-md .lcd-unit { font-size: 7px; margin-top: 2px; }
	.lcd-md .lcd-sep { font-size: 14px; margin-top: 10px; }
	.lcd-md .lcd-label { font-size: 9px; }

	.lcd-lg .lcd-grid { gap: 6px; }
	.lcd-lg .flap { width: 52px; height: 52px; border-radius: 8px; }
	.lcd-lg .flap-num { font-size: 30px; }
	.lcd-lg .lcd-unit { font-size: 9px; margin-top: 3px; }
	.lcd-lg .lcd-sep { font-size: 20px; margin-top: 14px; }
	.lcd-lg .lcd-label { font-size: 10px; margin-bottom: 8px; }

	@keyframes flapDown {
		0% { transform: rotateX(0deg); }
		100% { transform: rotateX(-90deg); }
	}
	@keyframes flapUp {
		0% { transform: rotateX(90deg); }
		70% { transform: rotateX(-8deg); }
		100% { transform: rotateX(0deg); }
	}
	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
